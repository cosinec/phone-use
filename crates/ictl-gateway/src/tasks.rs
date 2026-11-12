use crate::{
    commands::command_request,
    error::{ApiError, Result, recoverable_observation_error, recoverable_wda_error},
    gateway::Session,
    model::{Model, validate_reply},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, oneshot};
use tokio_util::sync::CancellationToken;

const RECOVERY_WAIT: Duration = Duration::from_secs(120);
const RECOVERY_INTERVAL: Duration = Duration::from_secs(2);
const MAX_RECOVERIES: u32 = 2;
/// OCR text often differs from accessibility labels, so in OCR mode a missed
/// element tap (nothing was tapped, no side effect) is reported back to the
/// model instead of halting, at most this many times per task.
const MAX_OCR_ELEMENT_MISSES: u32 = 2;

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
}
pub struct TaskManager {
    task: Mutex<Option<Task>>,
}
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
        Self { task: Mutex::new(None) }
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
    ) -> Result<Value> {
        if instruction.trim().is_empty() || instruction.chars().count() > 4000 || instruction.contains('\0') {
            return Err(ApiError::new(400, "Invalid task instruction"));
        }
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
            "id": id, "instruction": instruction.trim(), "model": model.name, "state": "observing", "steps": [],
            "confirmation": null, "startedAt": now(), "finishedAt": null, "message": null, "error": null, "timings": {},
            "observationId":null,"attachments":images.iter().map(|i| &i.name).collect::<Vec<_>>(), "maxSteps":100
        });
        *guard = Some(Task {
            session_id: session.id.clone(),
            started: Instant::now(),
            snapshot: snapshot.clone(),
            cancel: cancel.clone(),
            confirmation: None,
            lease: Some(lease.clone()),
        });
        drop(guard);
        tokio::spawn(async move {
            tokio::select! {biased;
                _=session.cancel.cancelled()=>session.tasks.finish(&id,"stopped",Some("Session disconnected. Already sent actions cannot be undone.".into()),None).await,
                _=cancel.cancelled()=>{},
                _=tokio::time::sleep(Duration::from_secs(1800))=>session.tasks.finish(&id,"failed",None,Some("任务已达到 30 分钟时限".into())).await,
                result=run(session.clone(),&id,model,images,cancel.clone(),&lease)=>match result{
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
        task.confirmation = None;
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
fn confirmation_required(action: &Value, request: &Value) -> bool {
    let op = request["op"].as_str().unwrap_or("");
    let sensitive =
        regex::Regex::new(r"(?i)\b(send|submit|pay|purchase|delete|erase|remove)\b|发送|提交|支付|购买|删除|清空|转账")
            .unwrap();
    action["requiresConfirmation"] == true
        || op == "terminate_app"
        || (op == "type_text" && request["submit"] == true)
        || (op == "open_url"
            && reqwest::Url::parse(request["url"].as_str().unwrap_or(""))
                .is_ok_and(|u| !["http", "https"].contains(&u.scheme())))
        || (["tap", "tap_element", "long_press"].contains(&op)
            && sensitive.is_match(&format!(
                "{} {}",
                action["reason"].as_str().unwrap_or(""),
                action["args"]["text"].as_str().unwrap_or("")
            )))
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
    cancel: CancellationToken,
    lease: &crate::control::TaskLease,
) -> Result<String> {
    // Keep bounded tool content private to the inference loop, out of polled UI snapshots.
    let mut history: Vec<Value> = Vec::new();
    let mut next_observation: Option<Value> = None;
    let mut focus_recoveries = 0;
    let mut element_misses = 0;
    let mut typing_blocked = false;
    let mut input_pending = false;
    let mut recoveries = 0;
    loop {
        let observation_id = uuid::Uuid::new_v4().to_string();
        let snapshot = s
            .tasks
            .update(id, |task| {
                task.snapshot["state"] = json!("observing");
                task.snapshot["observationId"] = json!(observation_id);
            })
            .await?;
        let observing = Instant::now();
        let observation_stage = TaskStage::start(&s.id, id, &observation_id, "observe");
        let direct =
            if images.is_empty() && history.is_empty() && snapshot["steps"].as_array().is_some_and(Vec::is_empty) {
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
                        recover_observation(&s, id, recoveries, cancel.clone(), lease, model.wants_elements()).await
                    }
                    Err(error) => Err(error),
                }
            }
        }
        .await;
        observation_stage.finish(if observation_result.is_ok() { "ok" } else { "error" });
        let mut observation = observation_result?;
        observation["observationId"] = json!(observation_id);
        let query_only = observation["queryOnly"] == true;
        if observation["deviceId"] != s.device.serial_number {
            return Err(ApiError::new(409, "Observation device identity mismatch"));
        }
        let mut timings =
            json!({"observationMs":observing.elapsed().as_millis() as u64,"capture":observation["timings"]});
        s.tasks
            .update(id, |t| {
                t.snapshot["state"] = json!("thinking");
                t.snapshot["timings"] = timings.clone();
            })
            .await?;
        let steps = snapshot["steps"].as_array().unwrap();
        while history.len() > 8 || history.iter().map(|v| v.to_string().len()).sum::<usize>() > 24000 {
            history.remove(0);
        }
        let thinking = Instant::now();
        let model_stage = TaskStage::start(&s.id, id, &observation_id, "model");
        let action_result = if let Some(direct) = direct {
            timings["direct"] = json!(true);
            Ok(direct)
        } else {
            model
                .generate(
                    snapshot["instruction"].as_str().unwrap(),
                    observation,
                    history.clone(),
                    &images,
                    cancel.clone(),
                )
                .await
                .and_then(validate_reply)
        };
        model_stage.finish(if action_result.is_ok() { "ok" } else { "error" });
        let action = action_result?;
        timings["modelMs"] = json!(thinking.elapsed().as_millis() as u64);
        s.tasks.update(id, |t| t.snapshot["timings"] = timings.clone()).await?;
        if cancel.is_cancelled() {
            return Err(ApiError::new(409, "Task cancelled"));
        }
        if action["type"] == "done" {
            if input_pending {
                return Err(ApiError::unavailable("Text input is still pending; task halted"));
            }
            return Ok(action["message"].as_str().unwrap().to_owned());
        }
        if steps.len() >= 100 {
            return Err(ApiError::new(409, "任务已达到 100 步上限"));
        }
        // A text-only query result is sufficient for app lookup/completion, but
        // never authorizes invented screen coordinates. Re-observe and re-plan first.
        if query_only && matches!(action["tool"].as_str(), Some("iphone_tap" | "iphone_swipe" | "iphone_long_press")) {
            continue;
        }
        let request = command_request(action["tool"].as_str().unwrap(), &action["args"])?;
        if typing_blocked && request["op"] == "type_text" {
            return Err(ApiError::unavailable("Focus an editable field before typing again; task halted"));
        }
        let step_id = uuid::Uuid::new_v4().to_string();
        let step = json!({
            "id": step_id, "tool": action["tool"], "args": action["args"], "reason": action["reason"],
            "state": "pending", "startedAt": now(), "finishedAt": null, "result": null
        });
        let needs_confirmation = confirmation_required(&action, &request);
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
            tokio::select! {biased;_=cancel.cancelled()=>return Err(ApiError::new(409,"Task cancelled")),r=receiver=>r.map_err(|_|ApiError::new(409,"Task cancelled"))?}
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
        let action_result = s.run_task_command(command, cancel.clone(), lease).await;
        action_stage.finish(if action_result.as_ref().is_ok_and(|result| result["kind"] != "error") {
            "ok"
        } else {
            "error"
        });
        let result = match action_result {
            Ok(result) => result,
            Err(error)
                if s.device.platform == crate::identity::Platform::Ios && recoverable_wda_error(&error.message) =>
            {
                json!({"kind":"error","message":error.message})
            }
            Err(error) => return Err(error),
        };
        timings["actionMs"] = json!(executing.elapsed().as_millis() as u64);
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
        } else if failed {
            "failed"
        } else if missed {
            "missed"
        } else {
            "succeeded"
        };
        history.push(json!({"tool":action["tool"],"args":action["args"],"reason":action["reason"],"state":state,"result":inference_result(&result)}));
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
            if !continue_after_element_miss(model.observation_mode(), element_misses) {
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
fn continue_after_element_miss(mode: crate::model::ObservationMode, misses: u32) -> bool {
    mode == crate::model::ObservationMode::Ocr && misses <= MAX_OCR_ELEMENT_MISSES
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
    fn only_ocr_mode_continues_after_a_bounded_number_of_element_misses() {
        use crate::model::ObservationMode::{Hybrid, Image, Ocr};
        assert!(continue_after_element_miss(Ocr, 1));
        assert!(continue_after_element_miss(Ocr, MAX_OCR_ELEMENT_MISSES));
        assert!(!continue_after_element_miss(Ocr, MAX_OCR_ELEMENT_MISSES + 1));
        assert!(!continue_after_element_miss(Image, 1));
        assert!(!continue_after_element_miss(Hybrid, 1));
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
}
