use crate::{
    commands::command_request,
    error::{ApiError, Result, recoverable_observation_error, recoverable_wda_error},
    gateway::Session,
    model::{Model, validate_reply},
};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, oneshot};
use tokio_util::sync::CancellationToken;

const RECOVERY_WAIT: Duration = Duration::from_secs(120);
const RECOVERY_INTERVAL: Duration = Duration::from_secs(2);
const MAX_RECOVERIES: u32 = 2;
/// A missed element tap (nothing was tapped, no side effect) is reported back
/// to the model instead of halting, at most this many times per task. Labels
/// often differ from visible or OCR text in every observation mode.
const MAX_ELEMENT_MISSES: u32 = 2;
/// A done reply that asks the user for confirmation would end the task with no
/// way to answer; it is returned to the model once to re-plan as a confirmable action.
const MAX_DONE_QUESTIONS: u32 = 1;
/// Actions the gateway rejects before dispatch (unknown tool, invalid
/// arguments, Back on iOS) never reach the device. Report them to the model
/// and re-plan, at most this many times per task.
const MAX_REJECTED_ACTIONS: u32 = 2;
/// A timed-out iphone_wait_for is read-only, so it is reported back to the
/// model instead of halting, at most this many times per task.
const MAX_WAIT_MISSES: u32 = 3;
/// Consecutive successful actions that left the screen unchanged before the
/// model is warned, and before the task stops instead of repeating itself.
const WARN_NO_EFFECT: u32 = 3;
const MAX_NO_EFFECT: u32 = 6;
/// Average-hash bits (of 256) two observations may differ by and still be the same screen.
const SAME_SCREEN_BITS: u32 = 6;
/// Latest history entries sent with full detail; older steps are summarized in a step log.
const DETAILED_HISTORY: usize = 8;
/// Most earlier steps repeated to the model in the step log.
const STEP_LOG_ENTRIES: usize = 40;
/// Goal updates accepted while one task runs.
const MAX_INSTRUCTION_UPDATES: usize = 20;
/// Earlier goals repeated to the model after the user changes the goal.
const EARLIER_GOALS: usize = 3;
/// Coordinates come from the observation the model saw; only a plan's first action may use them.
const COORDINATE_TOOLS: [&str; 3] = ["iphone_tap", "iphone_swipe", "iphone_long_press"];
/// Read-only results become the next observation, so they end a plan.
const QUERY_TOOLS: [&str; 5] =
    ["iphone_screenshot", "iphone_list_elements", "iphone_status", "iphone_list_apps", "iphone_list_devices"];

struct TaskStage<'a> {
    session_id: &'a str,
    task_id: &'a str,
    observation_id: &'a str,
    stage: &'static str,
    started: Instant,
    outcome: &'static str,
}
impl<'a> TaskStage<'a> {
    fn start(session_id: &'a str, task_id: &'a str, observation_id: &'a str, stage: &'static str) -> Self {
        let stage =
            Self { session_id, task_id, observation_id, stage, started: Instant::now(), outcome: "interrupted" };
        eprintln!("{}", stage.event("start", "started"));
        stage
    }
    fn event(&self, phase: &str, status: &str) -> Value {
        json!({
            "at":now(),"event":"task_stage","session_id":self.session_id,"task_id":self.task_id,
            "observation_id":self.observation_id,"stage":self.stage,"phase":phase,"status":status,
            "elapsed_ms":self.started.elapsed().as_millis() as u64
        })
    }
    fn finish(mut self, outcome: &'static str) {
        self.outcome = outcome;
    }
}
impl Drop for TaskStage<'_> {
    fn drop(&mut self) {
        eprintln!("{}", self.event("end", self.outcome));
    }
}

struct Task {
    session_id: String,
    started: Instant,
    snapshot: Value,
    cancel: CancellationToken,
    confirmation: Option<oneshot::Sender<()>>,
    lease: Option<crate::control::TaskLease>,
    /// Armed only while a goal update may safely abandon the current phase:
    /// model planning, a confirmation wait or a read-only iphone_wait_for.
    interrupt: Option<CancellationToken>,
}
pub struct TaskManager {
    task: Mutex<Option<Task>>,
    /// Summaries of this session's finished tasks, oldest first, so a new task
    /// knows what the user asked and what happened before it.
    previous: Mutex<Vec<Value>>,
}
/// Finished tasks of a session repeated to the model for context.
const PREVIOUS_TASKS: usize = 5;
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn terminal(state: &Value) -> bool {
    ["completed", "failed", "stopped"].iter().any(|s| state == *s)
}
impl Default for TaskManager {
    fn default() -> Self {
        Self::new()
    }
}
impl TaskManager {
    pub fn new() -> Self {
        Self { task: Mutex::new(None), previous: Mutex::new(Vec::new()) }
    }
    pub async fn snapshot(&self) -> Value {
        self.task.lock().await.as_ref().map(|t| t.snapshot.clone()).unwrap_or(Value::Null)
    }
    pub async fn active(&self) -> bool {
        self.task.lock().await.as_ref().is_some_and(|t| !terminal(&t.snapshot["state"]))
    }
    pub async fn start(
        &self,
        session: Arc<Session>,
        instruction: &str,
        model: Model,
        images: Vec<crate::attachments::ReferenceImage>,
        auto_confirm: bool,
    ) -> Result<Value> {
        let instruction = valid_instruction(instruction)?;
        let mut guard = self.task.lock().await;
        if guard.as_ref().is_some_and(|t| !terminal(&t.snapshot["state"])) {
            return Err(ApiError::new(409, "Session already has an active task"));
        }
        if session.cancel.is_cancelled() {
            return Err(ApiError::new(410, "Session closed"));
        }
        let lease = session.claim_task()?;
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = session.cancel.child_token();
        let snapshot = json!({
            "id": id, "instruction": instruction, "model": model.name, "state": "observing", "steps": [],
            "confirmation": null, "startedAt": now(), "finishedAt": null, "message": null, "error": null, "timings": {},
            "observationId":null,"attachments":images.iter().map(|i| &i.name).collect::<Vec<_>>(), "maxSteps":100,
            "instructionUpdates":[],"plan":[],"discardedPlanActions":0,"autoConfirm":auto_confirm
        });
        *guard = Some(Task {
            session_id: session.id.clone(),
            started: Instant::now(),
            snapshot: snapshot.clone(),
            cancel: cancel.clone(),
            confirmation: None,
            lease: Some(lease.clone()),
            interrupt: None,
        });
        drop(guard);
        let previous = self.previous.lock().await.clone();
        tokio::spawn(async move {
            tokio::select! {biased;
                _=session.cancel.cancelled()=>session.tasks.finish(&id,"stopped",Some("Session disconnected. Already sent actions cannot be undone.".into()),None).await,
                _=cancel.cancelled()=>{},
                _=tokio::time::sleep(Duration::from_secs(1800))=>session.tasks.finish(&id,"failed",None,Some("任务已达到 30 分钟时限".into())).await,
                result=run(session.clone(),&id,model,images,previous,cancel.clone(),&lease)=>match result{
                    Ok(message)=>session.tasks.finish(&id,"completed",Some(message),None).await,
                    Err(error)=>session.tasks.finish(&id,"failed",None,Some(error.message)).await,
                }
            }
        });
        Ok(snapshot)
    }
    async fn finish(&self, id: &str, state: &str, message: Option<String>, error: Option<String>) {
        let mut guard = self.task.lock().await;
        let Some(task) = guard.as_mut().filter(|t| t.snapshot["id"] == id && !terminal(&t.snapshot["state"])) else {
            return;
        };
        let mut uncertain = false;
        for step in task.snapshot["steps"].as_array_mut().unwrap() {
            if step["state"] == "executing" {
                step["state"] = json!("uncertain");
                step["finishedAt"] = json!(now());
                uncertain = true;
            }
            if step["state"] == "pending" || step["state"] == "awaiting_confirmation" {
                step["state"] = json!("cancelled");
                step["finishedAt"] = json!(now());
            }
        }
        eprintln!(
            "{}",
            json!({
                "at":now(),"event":"task_stage","session_id":task.session_id,"task_id":id,
                "observation_id":task.snapshot["observationId"],"stage":"finish","phase":"end","status":state,
                "elapsed_ms":task.started.elapsed().as_millis() as u64
            })
        );
        task.snapshot["state"] = json!(state);
        task.snapshot["message"] = json!(message.or_else(|| {
            uncertain.then(|| "A device action may already have been sent and cannot be undone.".into())
        }));
        task.snapshot["error"] = json!(error);
        task.snapshot["finishedAt"] = json!(now());
        task.snapshot["confirmation"] = Value::Null;
        task.snapshot["plan"] = json!([]);
        let summary = task_summary(&task.snapshot);
        {
            let mut previous = self.previous.lock().await;
            previous.push(summary);
            if previous.len() > PREVIOUS_TASKS {
                previous.remove(0);
            }
        }
        task.confirmation = None;
        task.interrupt = None;
        task.cancel.cancel();
        if let Some(lease) = task.lease.take() {
            lease.cancel();
        }
    }
    pub async fn disconnect(&self) {
        let id = self.snapshot().await["id"].as_str().map(str::to_owned);
        if let Some(id) = id {
            self.finish(
                &id,
                "stopped",
                Some("Session disconnected. Already sent actions cannot be undone.".into()),
                None,
            )
            .await;
        }
    }
    pub async fn stop(&self, id: &str) -> Result<Value> {
        if self.snapshot().await["id"] != id {
            return Err(ApiError::new(404, "Task not found"));
        }
        self.finish(id, "stopped", Some("Task stopped. Already sent actions cannot be undone.".into()), None).await;
        Ok(self.snapshot().await)
    }
    pub async fn confirm(&self, id: &str, action_id: &str, approved: bool) -> Result<Value> {
        let mut guard = self.task.lock().await;
        let task = guard
            .as_mut()
            .filter(|t| {
                t.snapshot["id"] == id
                    && t.snapshot["state"] == "awaiting_confirmation"
                    && t.snapshot["confirmation"]["actionId"] == action_id
                    && !t.cancel.is_cancelled()
            })
            .ok_or_else(|| ApiError::new(409, "Invalid or stale confirmation"))?;
        let sender = task.confirmation.take().ok_or_else(|| ApiError::new(409, "Invalid or stale confirmation"))?;
        task.snapshot["confirmation"] = Value::Null;
        if approved {
            task.snapshot["state"] = json!("executing");
            let _ = sender.send(());
            let snapshot = task.snapshot.clone();
            drop(guard);
            Ok(snapshot)
        } else {
            drop(guard);
            self.finish(id, "stopped", Some("Action confirmation declined.".into()), None).await;
            Ok(self.snapshot().await)
        }
    }
    /// Replaces the goal of a running task. Already sent actions are kept; the
    /// next plan uses the new goal, and phases that sent nothing to the phone
    /// (planning, a pending confirmation, a read-only wait) are abandoned now.
    pub async fn steer(&self, id: &str, instruction: &str) -> Result<Value> {
        let instruction = valid_instruction(instruction)?;
        let mut guard = self.task.lock().await;
        let task =
            guard.as_mut().filter(|t| t.snapshot["id"] == id).ok_or_else(|| ApiError::new(404, "Task not found"))?;
        if terminal(&task.snapshot["state"]) || task.cancel.is_cancelled() {
            return Err(ApiError::new(409, "Task is not running"));
        }
        if instruction_updates(&task.snapshot) >= MAX_INSTRUCTION_UPDATES {
            return Err(ApiError::new(429, "本次任务的目标更新次数已达上限，请停止后重新开始。"));
        }
        let previous = task.snapshot["instruction"].clone();
        let after_step = task.snapshot["steps"].as_array().map_or(0, Vec::len);
        task.snapshot["instruction"] = json!(instruction);
        task.snapshot["instructionUpdates"].as_array_mut().unwrap().push(json!({
            "at": now(), "instruction": instruction, "previous": previous, "afterStep": after_step
        }));
        if let Some(interrupt) = task.interrupt.take() {
            interrupt.cancel();
        }
        Ok(task.snapshot.clone())
    }
    /// Arms a goal-update interrupt for a phase that has sent nothing to the phone.
    /// A goal update that arrived after `seen_updates` was read, but before
    /// arming, interrupts at once instead of being missed.
    async fn arm_interrupt(
        &self,
        id: &str,
        cancel: &CancellationToken,
        seen_updates: usize,
    ) -> Result<CancellationToken> {
        let interrupt = cancel.child_token();
        let armed = interrupt.clone();
        self.update(id, move |t| {
            if instruction_updates(&t.snapshot) == seen_updates {
                t.interrupt = Some(armed);
            } else {
                armed.cancel();
            }
        })
        .await?;
        Ok(interrupt)
    }
    async fn disarm_interrupt(&self, id: &str) {
        let _ = self.update(id, |t| t.interrupt = None).await;
    }
    async fn update(&self, id: &str, operation: impl FnOnce(&mut Task)) -> Result<Value> {
        let mut guard = self.task.lock().await;
        let task = guard
            .as_mut()
            .filter(|t| t.snapshot["id"] == id && !terminal(&t.snapshot["state"]) && !t.cancel.is_cancelled())
            .ok_or_else(|| ApiError::new(409, "Task cancelled"))?;
        operation(task);
        Ok(task.snapshot.clone())
    }
}
/// Whether an action must wait for the user. With `auto_confirm` the user
/// pre-approved the task, and only payments and purchases still stop.
fn confirmation_required(action: &Value, request: &Value, auto_confirm: bool) -> bool {
    let op = request["op"].as_str().unwrap_or("");
    let described =
        format!("{} {}", action["reason"].as_str().unwrap_or(""), action["args"]["text"].as_str().unwrap_or(""));
    let payment = regex::Regex::new(
        r"(?i)\b(pay|payment|purchase|buy|checkout|subscribe)\b|支付|付款|购买|下单|转账|订阅|充值",
    )
    .unwrap();
    if auto_confirm {
        return payment.is_match(&described);
    }
    let sensitive =
        regex::Regex::new(r"(?i)\b(send|submit|pay|purchase|delete|erase|remove)\b|发送|提交|支付|购买|删除|清空|转账")
            .unwrap();
    // Submitting a search needs no approval; sending, posting or replying does.
    let outgoing = regex::Regex::new(r"(?i)\b(post|publish|reply|comment)\b|发布|评论|回复|留言").unwrap();
    action["requiresConfirmation"] == true
        || op == "terminate_app"
        || (op == "type_text"
            && request["submit"] == true
            && (sensitive.is_match(&described) || outgoing.is_match(&described)))
        || (op == "open_url"
            && reqwest::Url::parse(request["url"].as_str().unwrap_or(""))
                .is_ok_and(|u| !["http", "https"].contains(&u.scheme())))
        || (["tap", "tap_element", "long_press"].contains(&op) && sensitive.is_match(&described))
}

async fn recover_observation(
    s: &Session,
    id: &str,
    episode: u32,
    cancel: CancellationToken,
    lease: &crate::control::TaskLease,
    elements: bool,
) -> Result<Value> {
    if episode > MAX_RECOVERIES {
        return Err(ApiError::unavailable("任务已达到 2 次恢复次数上限，请检查设备后重新开始。"));
    }
    s.tasks
        .update(id, |task| {
            task.snapshot["state"] = json!("recovering");
            task.snapshot["message"] =
                json!("正在等待 WDA 恢复，最多 120 秒。恢复后会重新查看屏幕，核对上一步的结果。");
            task.snapshot["recovery"] = json!({
                "attempt":episode,"maxAttempts":MAX_RECOVERIES,"maxWaitSeconds":RECOVERY_WAIT.as_secs(),
                "startedAt":now(),"finishedAt":null,"elapsedMs":0
            });
        })
        .await?;
    let started = Instant::now();
    let recovering = async {
        loop {
            let attempt = cancel.child_token();
            // Cancel queued observations too if the recovery deadline drops this future.
            let _guard = attempt.clone().drop_guard();
            let controller =
                s.controller.get().ok_or_else(|| ApiError::unavailable("Native control transport is not ready"))?;
            let daemon = controller.request(json!({"op":"daemon"}), Duration::from_secs(3), attempt.clone()).await;
            let ready = daemon
                .ok()
                .filter(|response| response["kind"] == "text")
                .and_then(|response| serde_json::from_str::<Value>(response["text"].as_str()?).ok())
                .is_some_and(|state| state["state"]["state"] == "ready");
            if ready {
                match s.task_screen(attempt, lease, elements).await {
                    Ok(observation) => return Ok(observation),
                    Err(error) if recoverable_observation_error(&error.message) => {}
                    Err(error) => return Err(error),
                }
            }
            s.tasks
                .update(id, |task| {
                    task.snapshot["recovery"]["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
                })
                .await?;
            tokio::time::sleep(RECOVERY_INTERVAL).await;
        }
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(ApiError::new(409,"Task cancelled")),
        result = tokio::time::timeout(RECOVERY_WAIT, recovering) => result.unwrap_or_else(|_| {
            Err(ApiError::unavailable("等待 WDA 恢复已超过 120 秒，任务已停止。请检查手机连接和 WDA 状态。"))
        }),
    };
    s.tasks
        .update(id, |task| {
            task.snapshot["recovery"]["finishedAt"] = json!(now());
            task.snapshot["recovery"]["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
            task.snapshot["message"] = Value::Null;
        })
        .await?;
    result
}

async fn run(
    s: Arc<Session>,
    id: &str,
    model: Model,
    images: Vec<crate::attachments::ReferenceImage>,
    previous_tasks: Vec<Value>,
    cancel: CancellationToken,
    lease: &crate::control::TaskLease,
) -> Result<String> {
    // Keep bounded tool content private to the inference loop, out of polled UI snapshots.
    let mut history: Vec<Value> = Vec::new();
    let mut next_observation: Option<Value> = None;
    let mut focus_recoveries = 0;
    let mut element_misses = 0;
    let mut rejected_actions = 0;
    let mut wait_misses = 0;
    let mut done_questions = 0;
    // Set when the goal changes; cleared once an action is dispatched for the new goal.
    let mut steered = false;
    // Every dispatched action, so the model keeps track of the whole task.
    let mut step_log: Vec<Value> = Vec::new();
    // The screen that planned the latest actions, and whether a mutating action ran since.
    let mut last_screen: Option<ScreenFingerprint> = None;
    let mut awaiting_effect = false;
    let mut no_effect = 0;
    let mut typing_blocked = false;
    let mut input_pending = false;
    let mut recoveries = 0;
    // Remaining actions of a model plan, dispatched without re-observing.
    let mut queue: VecDeque<Value> = VecDeque::new();
    let mut plan_observation_id = String::new();
    let mut seen_updates = 0;
    loop {
        let snapshot = s.tasks.update(id, |_| {}).await?;
        if instruction_updates(&snapshot) != seen_updates {
            // The user changed the goal: actions planned for the old goal are void.
            seen_updates = instruction_updates(&snapshot);
            steered = true;
            no_effect = 0;
            discard_plan(&s, id, &mut queue).await?;
        }
        let (action, observation_id, mut timings) = if let Some(action) = queue.pop_front() {
            let remaining = plan_view(&queue);
            s.tasks.update(id, move |t| t.snapshot["plan"] = remaining).await?;
            (action, plan_observation_id.clone(), json!({"planned":true}))
        } else {
            let observation_id = uuid::Uuid::new_v4().to_string();
            s.tasks
                .update(id, |task| {
                    task.snapshot["state"] = json!("observing");
                    task.snapshot["observationId"] = json!(observation_id);
                })
                .await?;
            let observing = Instant::now();
            let observation_stage = TaskStage::start(&s.id, id, &observation_id, "observe");
            let direct = if images.is_empty()
                && history.is_empty()
                && snapshot["steps"].as_array().is_some_and(Vec::is_empty)
            {
                direct_command_for(snapshot["instruction"].as_str().unwrap_or(""), s.device.platform)
            } else {
                None
            };
            let observation_result = async {
                if direct.is_some() {
                    Ok(json!({"deviceId":s.device.serial_number,"caption":"Explicit user command"}))
                } else if let Some(observation) = next_observation.take() {
                    Ok(observation)
                } else {
                    match s.task_screen(cancel.clone(), lease, model.wants_elements()).await {
                        Ok(observation) => Ok(observation),
                        Err(error)
                            if s.device.platform == crate::identity::Platform::Ios
                                && recoverable_observation_error(&error.message) =>
                        {
                            recoveries += 1;
                            recover_observation(&s, id, recoveries, cancel.clone(), lease, model.wants_elements())
                                .await
                        }
                        Err(error) => Err(error),
                    }
                }
            }
            .await;
            observation_stage.finish(if observation_result.is_ok() { "ok" } else { "error" });
            let mut observation = observation_result?;
            observation["observationId"] = json!(observation_id);
            if let Some(screen) = ScreenFingerprint::of(&observation).await {
                if awaiting_effect
                    && let Some(changed) = last_screen.as_ref().and_then(|before| before.changed(&screen))
                {
                    awaiting_effect = false;
                    for entry in [history.iter_mut().rev().find(|e| e["state"] == "succeeded"), step_log.last_mut()]
                        .into_iter()
                        .flatten()
                    {
                        entry["screenChanged"] = json!(changed);
                    }
                    no_effect = if changed { 0 } else { no_effect + 1 };
                    if no_effect >= MAX_NO_EFFECT {
                        let last = step_log.last().and_then(|s| s["reason"].as_str()).unwrap_or("").to_owned();
                        return Err(ApiError::unavailable(format!(
                            "连续 {MAX_NO_EFFECT} 步操作后屏幕都没有变化，任务已停止，避免继续重复操作。最后一步：{last}。请检查手机画面是否被弹窗挡住或页面没有响应。"
                        )));
                    }
                    if no_effect == WARN_NO_EFFECT {
                        history.push(json!({"tool":"gateway","state":"warning",
                            "result":{"kind":"text","text":NO_EFFECT_WARNING}}));
                    }
                }
                last_screen = Some(screen);
            }
            let query_only = observation["queryOnly"] == true;
            if observation["deviceId"] != s.device.serial_number {
                return Err(ApiError::new(409, "Observation device identity mismatch"));
            }
            let mut timings =
                json!({"observationMs":observing.elapsed().as_millis() as u64,"capture":observation["timings"]});
            let snapshot = s
                .tasks
                .update(id, |t| {
                    t.snapshot["state"] = json!("thinking");
                    t.snapshot["timings"] = timings.clone();
                })
                .await?;
            compact_history(&mut history);
            while history.len() > DETAILED_HISTORY
                || history.iter().map(|v| v.to_string().len()).sum::<usize>() > HISTORY_CHARS
            {
                history.remove(0);
            }
            let thinking = Instant::now();
            let model_stage = TaskStage::start(&s.id, id, &observation_id, "model");
            // Kept to re-plan from the same screen when the goal changes during planning.
            let reusable = direct.is_none().then(|| observation.clone());
            let action_result = if let Some(direct) = direct {
                timings["direct"] = json!(true);
                Ok(direct)
            } else {
                let interrupt = s.tasks.arm_interrupt(id, &cancel, seen_updates).await?;
                let result = model
                    .generate(&model_instruction(&snapshot), observation, model_history(&previous_tasks, &step_log, &history), &images, interrupt)
                    .await
                    .and_then(validate_reply);
                s.tasks.disarm_interrupt(id).await;
                result
            };
            model_stage.finish(if action_result.is_ok() { "ok" } else { "error" });
            if cancel.is_cancelled() {
                return Err(ApiError::new(409, "Task cancelled"));
            }
            if instruction_updates(&s.tasks.update(id, |_| {}).await?) != seen_updates {
                // Nothing was dispatched for the old goal: plan again for the new one.
                next_observation = reusable;
                continue;
            }
            let action = action_result?;
            timings["modelMs"] = json!(thinking.elapsed().as_millis() as u64);
            s.tasks.update(id, |t| t.snapshot["timings"] = timings.clone()).await?;
            if action["type"] == "done" {
                if input_pending {
                    return Err(ApiError::unavailable("Text input is still pending; task halted"));
                }
                let message = action["message"].as_str().unwrap();
                if done_questions < MAX_DONE_QUESTIONS && asks_for_confirmation(message) {
                    // Nothing was dispatched: re-plan from the same screen as a confirmable action.
                    done_questions += 1;
                    history.push(json!({"tool":"done","args":{"message":message},"state":"rejected",
                        "result":{"kind":"error","message":DONE_IS_NOT_CONFIRMATION}}));
                    next_observation = reusable;
                    continue;
                }
                if steered && !stops_task(snapshot["instruction"].as_str().unwrap_or("")) {
                    // Models read a replaced goal as a refusal and stop; re-plan once per update.
                    steered = false;
                    history.push(json!({"tool":"done","args":{"message":message},"state":"rejected",
                        "result":{"kind":"error","message":DONE_AFTER_GOAL_UPDATE}}));
                    next_observation = reusable;
                    continue;
                }
                return Ok(message.to_owned());
            }
            let action = if action["type"] == "plan" {
                let mut actions = plan_prefix(action["actions"].as_array().map(Vec::as_slice).unwrap_or(&[]));
                if actions.is_empty() {
                    return Err(ApiError::unavailable("Invalid model reply: empty plan"));
                }
                let first = actions.remove(0);
                queue.extend(actions);
                plan_observation_id = observation_id.clone();
                timings["plannedActions"] = json!(queue.len() + 1);
                let remaining = plan_view(&queue);
                s.tasks.update(id, move |t| t.snapshot["plan"] = remaining).await?;
                first
            } else {
                action
            };
            // A text-only query result is sufficient for app lookup/completion, but
            // never authorizes invented screen coordinates. Re-observe and re-plan first.
            if query_only && matches!(action["tool"].as_str(), Some("iphone_tap" | "iphone_swipe" | "iphone_long_press"))
            {
                discard_plan(&s, id, &mut queue).await?;
                continue;
            }
            (action, observation_id, timings)
        };
        if snapshot["steps"].as_array().map_or(0, Vec::len) >= 100 {
            return Err(ApiError::new(409, "任务已达到 100 步上限"));
        }
        let request = match command_request(action["tool"].as_str().unwrap(), &action["args"]) {
            Ok(request) => request,
            Err(error) if error.status == 400 && rejected_actions < MAX_REJECTED_ACTIONS => {
                rejected_actions += 1;
                log_rejection(&s.id, id, &action, &error.message);
                history.push(rejected_history(&action, &error));
                discard_plan(&s, id, &mut queue).await?;
                continue;
            }
            Err(error) => return Err(error),
        };
        if typing_blocked && request["op"] == "type_text" {
            // Nothing is sent: return the action to the model to tap the field first,
            // within the same re-plan budget as other gateway rejections.
            discard_plan(&s, id, &mut queue).await?;
            if rejected_actions < MAX_REJECTED_ACTIONS {
                rejected_actions += 1;
                log_rejection(&s.id, id, &action, "focus_first");
                history.push(rejected_history(&action, &ApiError::new(409, FOCUS_FIRST)));
                continue;
            }
            return Err(ApiError::unavailable("Focus an editable field before typing again; task halted"));
        }
        let step_id = uuid::Uuid::new_v4().to_string();
        let step = json!({
            "id": step_id, "tool": action["tool"], "args": action["args"], "reason": action["reason"],
            "state": "pending", "startedAt": now(), "finishedAt": null, "result": null,
            "planned": timings["planned"] == true
        });
        let needs_confirmation = confirmation_required(&action, &request, snapshot["autoConfirm"] == true);
        let (sender, receiver) = oneshot::channel();
        s.tasks
            .update(id, |task| {
                task.snapshot["steps"].as_array_mut().unwrap().push(step);
                if needs_confirmation {
                    task.snapshot["steps"].as_array_mut().unwrap().last_mut().unwrap()["state"] =
                        json!("awaiting_confirmation");
                    task.snapshot["state"] = json!("awaiting_confirmation");
                    task.snapshot["confirmation"] = json!({
                        "actionId": step_id, "tool": action["tool"], "args": action["args"], "reason": action["reason"]
                    });
                    task.confirmation = Some(sender);
                }
            })
            .await?;
        if needs_confirmation {
            let interrupt = s.tasks.arm_interrupt(id, &cancel, seen_updates).await?;
            let confirmed = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(ApiError::new(409, "Task cancelled")),
                r = receiver => {
                    r.map_err(|_| ApiError::new(409, "Task cancelled"))?;
                    true
                }
                _ = interrupt.cancelled() => false,
            };
            s.tasks.disarm_interrupt(id).await;
            if !confirmed {
                // The goal changed before the user confirmed: this action was never sent.
                s.tasks
                    .update(id, |t| {
                        t.confirmation = None;
                        t.snapshot["confirmation"] = Value::Null;
                        t.snapshot["state"] = json!("thinking");
                        let step = t.snapshot["steps"].as_array_mut().unwrap().last_mut().unwrap();
                        step["state"] = json!("cancelled");
                        step["finishedAt"] = json!(now());
                    })
                    .await?;
                history.push(not_dispatched_history(&action, GOAL_CHANGED_BEFORE_CONFIRMATION));
                discard_plan(&s, id, &mut queue).await?;
                continue;
            }
        }
        s.tasks
            .update(id, |t| {
                t.snapshot["state"] = json!("executing");
                t.snapshot["steps"].as_array_mut().unwrap().last_mut().unwrap()["state"] = json!("executing");
            })
            .await?;
        let command = json!({
            "requestId": format!("task:{id}:{step_id}"), "deviceId": s.device.serial_number,
            "tool": action["tool"], "args": action["args"]
        });
        let executing = Instant::now();
        let action_stage = TaskStage::start(&s.id, id, &observation_id, "action");
        // A wait only reads the screen, so a goal update may abandon it safely.
        let interruptible = action["tool"] == "iphone_wait_for";
        let action_cancel = if interruptible { s.tasks.arm_interrupt(id, &cancel, seen_updates).await? } else { cancel.clone() };
        let action_result = s.run_task_command(command, action_cancel.clone(), lease).await;
        steered = false;
        if interruptible {
            s.tasks.disarm_interrupt(id).await;
        }
        action_stage.finish(if action_result.as_ref().is_ok_and(|result| result["kind"] != "error") {
            "ok"
        } else {
            "error"
        });
        timings["actionMs"] = json!(executing.elapsed().as_millis() as u64);
        if interruptible && action_cancel.is_cancelled() && !cancel.is_cancelled() {
            history.push(not_dispatched_history(&action, WAIT_INTERRUPTED));
            s.tasks
                .update(id, |t| {
                    t.snapshot["timings"] = timings.clone();
                    let step = t.snapshot["steps"].as_array_mut().unwrap().last_mut().unwrap();
                    step["timings"] = timings;
                    step["finishedAt"] = json!(now());
                    step["state"] = json!("cancelled");
                })
                .await?;
            discard_plan(&s, id, &mut queue).await?;
            continue;
        }
        let mut rejected = false;
        let result = match action_result {
            Ok(result) => result,
            Err(error) if error.status == 400 && rejected_actions < MAX_REJECTED_ACTIONS => {
                rejected_actions += 1;
                rejected = true;
                log_rejection(&s.id, id, &action, &error.message);
                json!({"kind":"error","message":rejected_message(&error)})
            }
            Err(error)
                if s.device.platform == crate::identity::Platform::Ios && recoverable_wda_error(&error.message) =>
            {
                json!({"kind":"error","message":error.message})
            }
            Err(error) => return Err(error),
        };
        let missed = if result.get("outcome").is_some() {
            result["outcome"]["tapped_nothing"] == true
        } else {
            ["没找到", "只匹配到", "被挡住", "Not found", "Only matched", "Covered"]
                .iter()
                .any(|p| result["text"].as_str().unwrap_or("").starts_with(p))
        };
        let failed = result["kind"] == "error";
        let recoverable = failed
            && s.device.platform == crate::identity::Platform::Ios
            && recoverable_wda_error(result["message"].as_str().unwrap_or(""));
        let missed = action["tool"] == "iphone_tap_element" && missed;
        let state = if recoverable {
            "uncertain"
        } else if rejected {
            "rejected"
        } else if failed {
            "failed"
        } else if missed {
            "missed"
        } else {
            "succeeded"
        };
        history.push(json!({"tool":action["tool"],"args":action["args"],"reason":action["reason"],"state":state,"result":inference_result(&result)}));
        step_log.push(step_summary(step_log.len() + 1, &action, state));
        let tool = action["tool"].as_str().unwrap_or("");
        if state == "succeeded" && !QUERY_TOOLS.contains(&tool) && tool != "iphone_wait_for" {
            awaiting_effect = true;
        }
        if result["kind"] == "image" {
            // The just-captured full frame/crop IS the next observation; do not
            // fetch another full image and send two pictures for the same query.
            next_observation = Some(
                json!({"deviceId":s.device.serial_number,"imageBase64":result["jpeg_base64"],"caption":result["caption"],"coordinateMapping":result["coordinateMapping"],"elementsText":""}),
            );
        } else if matches!(
            action["tool"].as_str(),
            Some("iphone_status" | "iphone_list_apps" | "iphone_list_devices" | "iphone_list_elements")
        ) && !failed
        {
            next_observation = Some(json!({"deviceId":s.device.serial_number,"queryOnly":true,
                "caption":"Fresh read-only tool result in recentHistory; no current image or coordinate evidence.",
                "elementsText":if action["tool"] == "iphone_list_elements" { result["text"].clone() } else { Value::Null }}));
        }
        s.tasks
            .update(id, |t| {
                t.snapshot["timings"] = timings.clone();
                let step = t.snapshot["steps"].as_array_mut().unwrap().last_mut().unwrap();
                step["result"] = json!({"kind":result["kind"]});
                step["timings"] = timings;
                step["finishedAt"] = json!(now());
                step["state"] = json!(state);
            })
            .await?;
        // The rest of a plan assumed this action succeeded and needed no review.
        if state != "succeeded" || needs_confirmation || next_observation.is_some() {
            discard_plan(&s, id, &mut queue).await?;
        }
        if rejected {
            // Nothing reached the device; observe again and let the model re-plan.
            continue;
        }
        if failed && !recoverable && action["tool"] == "iphone_wait_for" && wait_misses < MAX_WAIT_MISSES {
            // A wait that timed out only read the screen; let the model look again.
            wait_misses += 1;
            continue;
        }
        if failed {
            if recoverable {
                recoveries += 1;
                next_observation =
                    Some(recover_observation(&s, id, recoveries, cancel.clone(), lease, model.wants_elements()).await?);
                if needs_confirmation || request["op"] == "type_text" {
                    return Err(ApiError::unavailable(
                        "设备已恢复，但上一步操作结果不确定。请先核对手机上的实际结果，再重新开始任务。",
                    ));
                }
                continue;
            }
            // These exact native preflight errors guarantee that no text was sent.
            // Re-observe and re-plan once, requiring a successful tap before typing.
            let no_input_sent = s.device.platform == crate::identity::Platform::Ios
                && request["op"] == "type_text"
                && matches!(
                    result["message"].as_str(),
                    Some(
                        "No keyboard on screen (no text field has focus), nothing typed; tap a text field first and check with a screenshot that the keyboard is up"
                            | "屏幕上没有键盘(没有输入框获得焦点),什么都没输;先点一下输入框,截图确认键盘出来了再输入"
                    )
                );
            if no_input_sent && focus_recoveries == 0 {
                focus_recoveries += 1;
                typing_blocked = true;
                input_pending = true;
                next_observation = None;
                continue;
            }
            let cause = result["message"]
                .as_str()
                .filter(|message| !message.trim().is_empty())
                .map(|message| message.chars().take(2000).collect::<String>())
                .unwrap_or_else(|| "Native action failed".into());
            return Err(ApiError::unavailable(cause));
        }
        if missed {
            element_misses += 1;
            if !continue_after_element_miss(element_misses) {
                return Err(ApiError::new(409, "Element tap missed; task halted"));
            }
        }
        // A missed element tap changed nothing, so it cannot have focused a field.
        if !missed && matches!(request["op"].as_str(), Some("tap" | "tap_element")) {
            typing_blocked = false;
        }
        if request["op"] == "type_text" {
            input_pending = false;
        }
    }
}

const NO_EFFECT_WARNING: &str = "Warning from the gateway: the last actions did not change the screen (screenChanged:false). Do not repeat them unchanged. Try a different target, iphone_tap_element with an exact label from iphone_list_elements, a swipe or scroll, dismissing a dialog or keyboard, or reply done explaining what blocks the task.";

/// A coarse screen identity: an average hash of the screenshot and a hash of the UI element text.
struct ScreenFingerprint {
    image: Option<[u64; 4]>,
    elements: Option<u64>,
}
impl ScreenFingerprint {
    async fn of(observation: &Value) -> Option<Self> {
        let image = match observation["imageBase64"].as_str() {
            Some(data) => {
                let data = data.to_owned();
                tokio::task::spawn_blocking(move || average_hash(&data)).await.ok().flatten()
            }
            None => None,
        };
        let elements = observation["elementsText"].as_str().filter(|text| !text.is_empty()).map(|text| {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            text.hash(&mut hasher);
            hasher.finish()
        });
        (image.is_some() || elements.is_some()).then_some(Self { image, elements })
    }
    /// Whether the screen changed; unknown when the two observations share no evidence.
    fn changed(&self, after: &Self) -> Option<bool> {
        let same_image = self
            .image
            .zip(after.image)
            .map(|(a, b)| a.iter().zip(b).map(|(x, y)| (x ^ y).count_ones()).sum::<u32>() <= SAME_SCREEN_BITS);
        let same_elements = self.elements.zip(after.elements).map(|(a, b)| a == b);
        if same_image.is_none() && same_elements.is_none() {
            return None;
        }
        Some(same_image != Some(true) && same_elements != Some(true))
    }
}
/// 16x16 grayscale average hash of a base64 screenshot.
fn average_hash(data: &str) -> Option<[u64; 4]> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    let pixels = image::load_from_memory(&bytes).ok()?.thumbnail_exact(16, 16).to_luma8().into_raw();
    if pixels.len() != 256 {
        return None;
    }
    let mean = pixels.iter().map(|&p| u32::from(p)).sum::<u32>() / 256;
    let mut bits = [0u64; 4];
    for (index, &pixel) in pixels.iter().enumerate() {
        if u32::from(pixel) > mean {
            bits[index / 64] |= 1u64 << (index % 64);
        }
    }
    Some(bits)
}

/// One line of the task step log sent to the model.
fn step_summary(number: usize, action: &Value, state: &str) -> Value {
    let mut args = action["args"].clone();
    if let Some(text) = args.get("text").and_then(Value::as_str).map(|t| t.chars().take(40).collect::<String>()) {
        args["text"] = json!(text);
    }
    json!({"step":number,"tool":action["tool"],"args":args,"state":state,
        "reason":action["reason"].as_str().unwrap_or("").chars().take(80).collect::<String>()})
}

/// History sent to the model: once older entries were trimmed, a step log of the
/// earlier steps comes first so the model does not redo completed work.
fn with_step_log(step_log: &[Value], history: &[Value]) -> Vec<Value> {
    if step_log.len() <= DETAILED_HISTORY {
        return history.to_vec();
    }
    let earlier = &step_log[..step_log.len() - DETAILED_HISTORY];
    let shown = &earlier[earlier.len().saturating_sub(STEP_LOG_ENTRIES)..];
    let mut out = vec![json!({
        "stepLog": shown, "omittedSteps": earlier.len() - shown.len(),
        "note": "Earlier steps of this task, oldest first. The entries after this one detail the latest steps. Do not repeat completed steps."
    })];
    out.extend_from_slice(history);
    out
}

/// History sent to the model: earlier tasks of this session, then this task's
/// step log and detailed history.
fn model_history(previous_tasks: &[Value], step_log: &[Value], history: &[Value]) -> Vec<Value> {
    let mut out = with_step_log(step_log, history);
    if !previous_tasks.is_empty() {
        out.insert(0, json!({
            "previousTasks": previous_tasks,
            "note": "Earlier tasks in this session, oldest first. The current instruction may refer to them (for example continue, again, the same, undo). Use them as context; do not redo them unless the current instruction asks to."
        }));
    }
    out
}

/// What a finished task asked for and how it ended, for the next task of the session.
fn task_summary(snapshot: &Value) -> Value {
    let bounded = |value: &Value, max: usize| value.as_str().map(|s| s.chars().take(max).collect::<String>());
    let steps = snapshot["steps"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let last_steps: Vec<Value> = steps[steps.len().saturating_sub(10)..]
        .iter()
        .map(|step| json!({"tool":step["tool"],"state":step["state"],"reason":bounded(&step["reason"], 80)}))
        .collect();
    let updates: Vec<Value> = snapshot["instructionUpdates"]
        .as_array()
        .map(|updates| updates.iter().map(|update| json!(bounded(&update["instruction"], 300))).collect())
        .unwrap_or_default();
    json!({
        "instruction": bounded(&snapshot["instruction"], 500), "goalUpdates": updates, "state": snapshot["state"],
        "result": bounded(&snapshot["message"], 500).or_else(|| bounded(&snapshot["error"], 500)),
        "steps": steps.len(), "lastSteps": last_steps,
    })
}

/// Content-free record of a gateway rejection; the message is gateway-generated.
fn log_rejection(session_id: &str, task_id: &str, action: &Value, reason: &str) {
    eprintln!(
        "{}",
        json!({"at":now(),"event":"task_action_rejected","session_id":session_id,"task_id":task_id,
            "tool":action["tool"],"reason":reason.chars().take(160).collect::<String>()})
    );
}

/// Number of goal updates the user has made to this task.
fn instruction_updates(snapshot: &Value) -> usize {
    snapshot["instructionUpdates"].as_array().map_or(0, Vec::len)
}

/// The goal sent to the model. After the user changes the goal mid-task, the
/// model also sees the most recent earlier goals so it can build on (or undo)
/// steps already taken for them without pursuing them further.
fn model_instruction(snapshot: &Value) -> String {
    let current = snapshot["instruction"].as_str().unwrap_or("");
    let earlier: Vec<&str> = snapshot["instructionUpdates"]
        .as_array()
        .map(|updates| updates.iter().filter_map(|update| update["previous"].as_str()).collect())
        .unwrap_or_default();
    if earlier.is_empty() {
        return current.to_owned();
    }
    let mut text = format!(
        "CURRENT GOAL (the user changed the goal while this task was running; it replaces every earlier goal): {current}\nEarlier goals, oldest first, for context only:"
    );
    for goal in &earlier[earlier.len().saturating_sub(EARLIER_GOALS)..] {
        text.push_str("\n- ");
        text.push_str(&goal.chars().take(1000).collect::<String>());
    }
    text.push_str("\nSteps in recentHistory may have served an earlier goal. Build on them when they help the current goal, undo them only when the current goal requires it, and never repeat completed steps.");
    text
}

/// Keeps the longest prefix of a model plan that may run without re-observing.
/// The first action is always kept; it has the same checks as a single action.
fn plan_prefix(actions: &[Value]) -> Vec<Value> {
    let mut kept: Vec<Value> = Vec::new();
    for action in actions.iter().take(crate::model::MAX_PLAN_ACTIONS) {
        if let Some(previous) = kept.last() {
            let tool = action["tool"].as_str().unwrap_or("");
            let previous_tool = previous["tool"].as_str().unwrap_or("");
            if COORDINATE_TOOLS.contains(&tool)
                || QUERY_TOOLS.contains(&previous_tool)
                || previous["requiresConfirmation"] == true
                || (tool == "iphone_type_text" && !["iphone_tap", "iphone_tap_element"].contains(&previous_tool))
            {
                break;
            }
        }
        kept.push(action.clone());
    }
    kept
}

fn plan_view(queue: &VecDeque<Value>) -> Value {
    json!(queue.iter().map(|action| json!({"tool":action["tool"],"reason":action["reason"]})).collect::<Vec<_>>())
}

/// Drops the planned actions that were not dispatched; nothing reached the phone.
async fn discard_plan(s: &Session, id: &str, queue: &mut VecDeque<Value>) -> Result<()> {
    if queue.is_empty() {
        return Ok(());
    }
    let discarded = queue.len() as u64;
    queue.clear();
    s.tasks
        .update(id, move |t| {
            let total = t.snapshot["discardedPlanActions"].as_u64().unwrap_or(0) + discarded;
            t.snapshot["discardedPlanActions"] = json!(total);
            t.snapshot["plan"] = json!([]);
        })
        .await?;
    Ok(())
}

const GOAL_CHANGED_BEFORE_CONFIRMATION: &str = "Not sent to the device and not refused: the user updated the goal while this action awaited confirmation. Continue with the CURRENT GOAL in the instruction.";
const DONE_AFTER_GOAL_UPDATE: &str = "Not finished: the user just updated the goal (CURRENT GOAL in the instruction). Earlier actions were replaced, not refused. Plan the next action for the current goal; reply done only if the current goal is already achieved, and say how.";
/// Whether an updated goal tells the task to stop rather than to do something else.
fn stops_task(instruction: &str) -> bool {
    regex::Regex::new(r"(?i)停止|别做了|不用了|不要做了|取消任务|算了|结束任务|\bstop\b|\bcancel\b|never ?mind")
        .unwrap()
        .is_match(instruction)
}
const WAIT_INTERRUPTED: &str = "Interrupted by a goal update; this read-only wait changed nothing on the device.";
fn not_dispatched_history(action: &Value, message: &str) -> Value {
    json!({"tool":action["tool"],"args":action["args"],"reason":action["reason"],"state":"cancelled",
        "result":{"kind":"text","text":message}})
}
fn valid_instruction(instruction: &str) -> Result<&str> {
    if instruction.trim().is_empty() || instruction.chars().count() > 4000 || instruction.contains('\0') {
        return Err(ApiError::new(400, "Invalid task instruction"));
    }
    Ok(instruction.trim())
}
fn direct_command_for(instruction: &str, platform: crate::identity::Platform) -> Option<Value> {
    let mut action = direct_command(instruction)?;
    if platform == crate::identity::Platform::Android {
        match action["args"]["app"].as_str() {
            Some("com.apple.Preferences") => action["args"]["app"] = json!("com.android.settings"),
            Some(_) => return None, // Clock package IDs vary between Android vendors; let the model look up apps.
            None => {}
        }
    }
    Some(action)
}
fn direct_command(instruction: &str) -> Option<Value> {
    let text = instruction.trim().trim_end_matches(['。', '.', '!', '！']).to_lowercase();
    let (tool, args) = match text.as_str() {
        "回到主屏幕" | "返回主屏幕" | "回到桌面" | "go home" | "go to home screen" => {
            ("iphone_press_button", json!({"button":"home"}))
        }
        "打开设置" | "open settings" => ("iphone_launch_app", json!({"app":"com.apple.Preferences"})),
        "打开时钟" | "open clock" => ("iphone_launch_app", json!({"app":"com.apple.mobiletimer"})),
        _ => return None,
    };
    Some(
        json!({"type":"action","tool":tool,"args":args,"reason":"执行用户明确指定的单步操作，随后观察并验证结果","requiresConfirmation":false}),
    )
}
const FOCUS_FIRST: &str = "No editable field has focus: the previous typing found no keyboard. Tap the intended text field first and confirm the keyboard in the next observation before typing.";
fn rejected_message(error: &ApiError) -> String {
    format!("Rejected by the gateway before reaching the device, nothing was done: {}", error.message)
}
fn rejected_history(action: &Value, error: &ApiError) -> Value {
    json!({"tool":action["tool"],"args":action["args"],"reason":action["reason"],"state":"rejected",
        "result":{"kind":"error","message":rejected_message(error)}})
}

fn continue_after_element_miss(misses: u32) -> bool {
    misses <= MAX_ELEMENT_MISSES
}

const DONE_IS_NOT_CONFIRMATION: &str = "Not finished: your done message asked the user for confirmation, but done ends the task and the user cannot answer it. Return the next action itself with requiresConfirmation:true so the user can approve it in the interface, or continue the task if no confirmation is needed.";
/// Whether a done message asks the user to confirm or choose instead of reporting a result.
fn asks_for_confirmation(message: &str) -> bool {
    regex::Regex::new(
        r"(?i)请确认|是否(继续|要|需要|确认|同意)|要不要|需要你(的)?确认|确认(后|一下)?(我|再)?(继续|执行)|\bconfirm\b|\bproceed\?|\bcontinue\?|would you like|shall i|should i",
    )
    .unwrap()
    .is_match(message)
}

/// Total history sent to the model. Input tokens drive time to first token, so
/// only the newest result keeps its full text; older results keep a short summary.
const HISTORY_CHARS: usize = 16000;
const OLDER_RESULT_CHARS: usize = 1500;

fn compact_history(history: &mut [Value]) {
    let Some((_, older)) = history.split_last_mut() else { return };
    for entry in older {
        for key in ["text", "caption", "message"] {
            if let Some(text) = entry["result"][key].as_str()
                && text.chars().count() > OLDER_RESULT_CHARS
            {
                entry["result"][key] = json!(text.chars().take(OLDER_RESULT_CHARS).collect::<String>());
                entry["result"]["truncated"] = json!(true);
            }
        }
    }
}

fn inference_result(result: &Value) -> Value {
    let mut summary = json!({"kind":result["kind"]});
    for key in ["text", "caption", "message"] {
        if let Some(text) = result[key].as_str() {
            let bounded: String = text.chars().take(6000).collect();
            summary[key] = json!(bounded);
            if text.chars().count() > 6000 {
                summary["truncated"] = json!(true);
            }
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_stage_events_include_only_trace_and_timing_metadata() {
        let stage = TaskStage::start("session-fixture", "task-fixture", "observation-fixture", "model");
        let event = stage.event("end", "error");
        assert_eq!(event["session_id"], "session-fixture");
        assert_eq!(event["task_id"], "task-fixture");
        assert_eq!(event["observation_id"], "observation-fixture");
        assert_eq!(event["stage"], "model");
        assert_eq!(event["phase"], "end");
        assert_eq!(event["status"], "error");
        let mut keys: Vec<_> = event.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["at", "elapsed_ms", "event", "observation_id", "phase", "session_id", "stage", "status", "task_id"]
        );
        stage.finish("error");
    }

    #[test]
    fn only_the_newest_history_result_keeps_its_full_text() {
        let long = "x".repeat(5000);
        let mut history = vec![
            json!({"tool":"iphone_list_apps","result":{"kind":"text","text":long}}),
            json!({"tool":"iphone_tap","result":{"kind":"text","text":"Tapped"}}),
            json!({"tool":"iphone_list_elements","result":{"kind":"text","text":long}}),
        ];
        compact_history(&mut history);
        assert_eq!(history[0]["result"]["text"].as_str().unwrap().len(), OLDER_RESULT_CHARS);
        assert_eq!(history[0]["result"]["truncated"], true);
        assert_eq!(history[1]["result"]["text"], "Tapped");
        assert!(history[1]["result"].get("truncated").is_none());
        assert_eq!(history[2]["result"]["text"].as_str().unwrap().len(), 5000);
        compact_history(&mut []);
    }

    #[test]
    fn rejected_actions_are_reported_as_not_dispatched() {
        let action = json!({"tool":"iphone_press_button","args":{"button":"back"},"reason":"Go back"});
        let entry = rejected_history(&action, &ApiError::new(400, "Back is supported on Android only"));
        assert_eq!(entry["state"], "rejected");
        assert_eq!(entry["tool"], "iphone_press_button");
        let message = entry["result"]["message"].as_str().unwrap();
        assert!(
            message.contains("before reaching the device") && message.ends_with("Back is supported on Android only")
        );
        assert!(command_request("iphone_unknown", &json!({})).unwrap_err().status == 400);
    }

    #[test]
    fn typing_before_a_focus_tap_is_returned_to_the_model_without_dispatch() {
        let action = json!({"tool":"iphone_type_text","args":{"text":"bilibili"},"reason":"Search"});
        let entry = rejected_history(&action, &ApiError::new(409, FOCUS_FIRST));
        assert_eq!(entry["state"], "rejected");
        let message = entry["result"]["message"].as_str().unwrap();
        assert!(
            message.contains("before reaching the device") && message.contains("Tap the intended text field first")
        );
    }

    #[test]
    fn tasks_continue_after_a_bounded_number_of_element_misses() {
        assert!(continue_after_element_miss(1));
        assert!(continue_after_element_miss(MAX_ELEMENT_MISSES));
        assert!(!continue_after_element_miss(MAX_ELEMENT_MISSES + 1));
    }

    #[test]
    fn confirmation_is_limited_to_outgoing_or_destructive_actions_and_auto_confirm_keeps_payments() {
        let action = |tool: &str, args: Value, reason: &str| json!({"tool":tool,"args":args,"reason":reason});
        let needs = |action: &Value, auto: bool| {
            let request = command_request(action["tool"].as_str().unwrap(), &action["args"]).unwrap();
            confirmation_required(action, &request, auto)
        };
        let search = action("iphone_type_text", json!({"text":"天气","submit":true}), "搜索天气");
        let message = action("iphone_type_text", json!({"text":"你好","submit":true}), "发送消息");
        let delete = action("iphone_tap", json!({"x":1,"y":2}), "点击删除");
        let pay = action("iphone_tap", json!({"x":1,"y":2}), "点击立即支付");
        let open = action("iphone_tap", json!({"x":1,"y":2}), "打开设置");
        assert!(!needs(&search, false));
        assert!(needs(&message, false));
        assert!(needs(&delete, false));
        assert!(!needs(&open, false));
        assert!(!needs(&message, true) && !needs(&delete, true));
        assert!(needs(&pay, true) && needs(&pay, false));
    }

    fn png(shade: u8) -> String {
        let image = image::RgbImage::from_fn(32, 64, |x, _| {
            if x < 16 { image::Rgb([shade, shade, shade]) } else { image::Rgb([255 - shade, 0, 0]) }
        });
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    }

    #[tokio::test]
    async fn screen_fingerprints_detect_unchanged_and_changed_screens() {
        let a = ScreenFingerprint::of(&json!({"imageBase64":png(0),"elementsText":"Button: A"})).await.unwrap();
        let same = ScreenFingerprint::of(&json!({"imageBase64":png(0),"elementsText":"Button: B"})).await.unwrap();
        let other = ScreenFingerprint::of(&json!({"imageBase64":png(255),"elementsText":"Button: C"})).await.unwrap();
        assert_eq!(a.changed(&same), Some(false), "same image, different tree");
        assert_eq!(a.changed(&other), Some(true));
        let tree = ScreenFingerprint::of(&json!({"elementsText":"Button: A"})).await.unwrap();
        assert_eq!(a.changed(&tree), Some(false), "same tree without an image");
        assert!(ScreenFingerprint::of(&json!({"queryOnly":true})).await.is_none());
    }

    #[test]
    fn step_log_precedes_detailed_history_only_after_it_was_trimmed() {
        let action = json!({"tool":"iphone_type_text","args":{"text":"x".repeat(100)},"reason":"r".repeat(200)});
        let entry = step_summary(1, &action, "succeeded");
        assert_eq!(entry["args"]["text"].as_str().unwrap().len(), 40);
        assert_eq!(entry["reason"].as_str().unwrap().len(), 80);
        let history = vec![json!({"tool":"iphone_tap"})];
        let short: Vec<Value> = (1..=DETAILED_HISTORY).map(|n| step_summary(n, &action, "succeeded")).collect();
        assert_eq!(with_step_log(&short, &history), history);
        let long: Vec<Value> = (1..=60).map(|n| step_summary(n, &action, "succeeded")).collect();
        let sent = with_step_log(&long, &history);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["stepLog"].as_array().unwrap().len(), STEP_LOG_ENTRIES);
        assert_eq!(sent[0]["omittedSteps"], 60 - DETAILED_HISTORY - STEP_LOG_ENTRIES);
        assert_eq!(sent[0]["stepLog"][0]["step"], 60 - DETAILED_HISTORY - STEP_LOG_ENTRIES + 1);
    }

    #[test]
    fn previous_tasks_lead_the_model_history_with_bounded_summaries() {
        let snapshot = json!({
            "instruction": "打开时钟", "state": "completed", "message": "已打开时钟", "error": null,
            "instructionUpdates": [{"instruction": "改为打开秒表"}],
            "steps": (0..12).map(|n| json!({"tool":"iphone_tap","state":"succeeded","reason":format!("step {n}")})).collect::<Vec<_>>(),
        });
        let summary = task_summary(&snapshot);
        assert_eq!(summary["result"], "已打开时钟");
        assert_eq!(summary["goalUpdates"], json!(["改为打开秒表"]));
        assert_eq!(summary["steps"], 12);
        assert_eq!(summary["lastSteps"].as_array().unwrap().len(), 10);
        assert_eq!(summary["lastSteps"][0]["reason"], "step 2");
        let history = vec![json!({"tool":"iphone_tap"})];
        assert_eq!(model_history(&[], &[], &history), history);
        let sent = model_history(&[summary.clone()], &[], &history);
        assert_eq!(sent[0]["previousTasks"], json!([summary]));
        assert_eq!(sent[1], history[0]);
    }

    #[test]
    fn only_goal_updates_that_say_stop_may_finish_without_a_replan() {
        assert!(stops_task("算了，不用了"));
        assert!(stops_task("Stop here"));
        assert!(!stops_task("改为打开时钟"));
        assert!(!stops_task("Open the Settings app instead"));
    }

    #[test]
    fn done_messages_that_ask_for_confirmation_are_recognized() {
        for message in [
            "切换 App Store 账号会更改账户设置。请确认是否继续退出当前账号并登录你提供的账号。",
            "是否继续删除这条消息？",
            "Should I proceed? Please confirm the purchase.",
            "Would you like me to send it?",
        ] {
            assert!(asks_for_confirmation(message), "{message}");
        }
        for message in ["已打开设置，系统版本为 iOS 26.3.1。", "Alarm list shows 3 alarms.", "无法继续：未找到登录入口。"] {
            assert!(!asks_for_confirmation(message), "{message}");
        }
    }

    #[test]
    fn direct_commands_are_exact_allowlisted_and_do_not_match_compound_or_negative_requests() {
        assert_eq!(direct_command(" 回到主屏幕。 ").unwrap()["args"]["button"], "home");
        assert_eq!(direct_command("OPEN SETTINGS").unwrap()["args"]["app"], "com.apple.Preferences");
        for instruction in
            ["不要回到主屏幕", "打开设置并关闭密码", "打开时钟并删除闹钟", "pay", "send message", "回到主屏幕然后支付"]
        {
            assert!(direct_command(instruction).is_none(), "{instruction}");
        }
    }
    #[test]
    fn android_shortcuts_use_android_packages_and_clock_falls_back_to_lookup() {
        use crate::identity::Platform;
        assert_eq!(direct_command_for("打开设置", Platform::Android).unwrap()["args"]["app"], "com.android.settings");
        assert!(direct_command_for("打开时钟", Platform::Android).is_none());
        assert_eq!(direct_command_for("打开设置", Platform::Ios).unwrap()["args"]["app"], "com.apple.Preferences");
    }
    #[test]
    fn inference_preserves_query_text_without_copying_image_data() {
        let result = json!({"kind":"text","text":"App: com.example.fixture"});
        assert_eq!(inference_result(&result)["text"], result["text"]);
        let result = json!({"kind":"image","caption":"crop at x=10 y=20","jpeg_base64":"private-image"});
        assert_eq!(inference_result(&result)["caption"], result["caption"]);
        assert!(inference_result(&result).get("jpeg_base64").is_none());
        let result = inference_result(&json!({"kind":"text","text":"中".repeat(7000)}));
        assert_eq!(result["text"].as_str().unwrap().chars().count(), 6000);
        assert_eq!(result["truncated"], true);
    }
    #[test]
    fn plans_keep_only_actions_that_need_no_fresh_observation() {
        let a = |tool: &str| json!({"type":"action","tool":tool,"args":{},"reason":"fixture","requiresConfirmation":false});
        let tools = |plan: Vec<Value>| {
            plan_prefix(&plan).iter().map(|v| v["tool"].as_str().unwrap().to_owned()).collect::<Vec<_>>()
        };
        assert_eq!(
            tools(vec![a("iphone_tap"), a("iphone_type_text"), a("iphone_wait_for"), a("iphone_press_button")]),
            ["iphone_tap", "iphone_type_text", "iphone_wait_for", "iphone_press_button"]
        );
        // Later coordinates would come from a stale observation.
        assert_eq!(tools(vec![a("iphone_tap"), a("iphone_swipe")]), ["iphone_tap"]);
        // Typing must directly follow the tap that focuses its field.
        assert_eq!(tools(vec![a("iphone_launch_app"), a("iphone_type_text")]), ["iphone_launch_app"]);
        // A read-only result becomes the next observation.
        assert_eq!(tools(vec![a("iphone_screenshot"), a("iphone_press_button")]), ["iphone_screenshot"]);
        let mut sensitive = a("iphone_tap_element");
        sensitive["requiresConfirmation"] = json!(true);
        assert_eq!(tools(vec![sensitive, a("iphone_press_button")]), ["iphone_tap_element"]);
        assert_eq!(tools(vec![a("iphone_press_button"); 6]).len(), crate::model::MAX_PLAN_ACTIONS);
        assert!(plan_prefix(&[]).is_empty());
    }

    #[test]
    fn validated_plans_normalize_actions_and_reject_unsafe_shapes() {
        let plan = validate_reply(json!({"type":"plan","actions":[
            {"tool":"iphone_tap","args":{"x":1,"y":2},"reason":"Focus"},
            {"tool":"iphone_type_text","args":{"text":"hi","submit":false},"reason":"Type"}
        ]}))
        .unwrap();
        assert_eq!(plan["type"], "plan");
        assert_eq!(plan["actions"][0]["type"], "action");
        assert_eq!(plan["actions"][1]["requiresConfirmation"], false);
        let single = validate_reply(json!({"type":"plan","actions":[
            {"tool":"iphone_press_button","args":{"button":"home"},"reason":"Home"}
        ]}))
        .unwrap();
        assert_eq!(single["type"], "action");
        let five = Value::Array(vec![json!({"tool":"iphone_status","args":{},"reason":"Status"}); 5]);
        for (reply, detail) in [
            (json!({"type":"plan","actions":[]}), "nonempty"),
            (json!({"type":"plan","actions":[{"tool":"iphone_status","args":{},"reason":"r"}],"reason":"x"}), "only accepts"),
            (json!({"type":"plan","actions":[{"type":"done","message":"ok"}]}), "must be an action"),
            (json!({"type":"plan","actions":[{"type":"plan","actions":[]}]}), "must be an action"),
            (json!({"type":"plan","actions":[{"tool":"iphone_tap","args":{"x":"bad","y":1},"reason":"r"}]}), "plan action 1: args:"),
            (json!({"type":"plan","actions":five}), "at most"),
        ] {
            let error = validate_reply(reply).unwrap_err();
            assert!(error.message.contains(detail), "{}", error.message);
        }
    }

    #[test]
    fn goal_updates_reach_the_model_with_bounded_earlier_goals() {
        let mut snapshot = json!({"instruction":"Open Clock","instructionUpdates":[]});
        assert_eq!(model_instruction(&snapshot), "Open Clock");
        snapshot["instructionUpdates"] =
            json!((1..=5).map(|i| json!({"previous":format!("goal {i}")})).collect::<Vec<_>>());
        let text = model_instruction(&snapshot);
        assert!(text.starts_with("CURRENT GOAL"), "{text}");
        assert!(text.contains("Open Clock"));
        assert!(!text.contains("goal 2") && text.contains("goal 3") && text.contains("goal 5"), "{text}");
        assert_eq!(instruction_updates(&snapshot), 5);
        assert!(valid_instruction(" ").is_err());
        assert!(valid_instruction(&"x".repeat(4001)).is_err());
        assert!(valid_instruction("a\0").is_err());
        assert_eq!(valid_instruction("  New goal ").unwrap(), "New goal");
    }
}
