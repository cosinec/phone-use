use crate::{
    commands::command_request,
    error::{ApiError, Result},
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

struct Task {
    snapshot: Value,
    cancel: CancellationToken,
    confirmation: Option<oneshot::Sender<()>>,
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
    pub async fn start(&self, session: Arc<Session>, instruction: &str, model: Model) -> Result<Value> {
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
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = session.cancel.child_token();
        let snapshot = json!({
            "id": id, "instruction": instruction.trim(), "model": model.name, "state": "observing", "steps": [],
            "confirmation": null, "startedAt": now(), "finishedAt": null, "message": null, "error": null, "timings": {}
        });
        *guard = Some(Task { snapshot: snapshot.clone(), cancel: cancel.clone(), confirmation: None });
        drop(guard);
        tokio::spawn(async move {
            tokio::select! {biased;
                _=session.cancel.cancelled()=>session.tasks.finish(&id,"stopped",Some("Session disconnected. Already sent actions cannot be undone.".into()),None).await,
                _=cancel.cancelled()=>{},
                _=tokio::time::sleep(Duration::from_secs(360))=>session.tasks.finish(&id,"failed",None,Some("Task time limit reached".into())).await,
                result=run(session.clone(),&id,model,cancel.clone())=>match result{
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
        task.snapshot["state"] = json!(state);
        task.snapshot["message"] = json!(message.or_else(|| {
            uncertain.then(|| "A device action may already have been sent and cannot be undone.".into())
        }));
        task.snapshot["error"] = json!(error);
        task.snapshot["finishedAt"] = json!(now());
        task.snapshot["confirmation"] = Value::Null;
        task.confirmation = None;
        task.cancel.cancel();
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
async fn run(s: Arc<Session>, id: &str, model: Model, cancel: CancellationToken) -> Result<String> {
    // Keep bounded tool content private to the inference loop, out of polled UI snapshots.
    let mut history: Vec<Value> = Vec::new();
    let mut next_observation: Option<Value> = None;
    let mut focus_recoveries = 0;
    let mut typing_blocked = false;
    let mut input_pending = false;
    loop {
        let snapshot = s.tasks.update(id, |t| t.snapshot["state"] = json!("observing")).await?;
        let observing = Instant::now();
        let direct = if history.is_empty() && snapshot["steps"].as_array().is_some_and(Vec::is_empty) {
            direct_command_for(snapshot["instruction"].as_str().unwrap_or(""), s.device.platform)
        } else {
            None
        };
        let observation = if direct.is_some() {
            json!({"deviceId":s.device.serial_number,"caption":"Explicit user command"})
        } else if let Some(observation) = next_observation.take() {
            observation
        } else {
            s.screen(cancel.clone()).await?
        };
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
        let action = if let Some(direct) = direct {
            timings["direct"] = json!(true);
            direct
        } else {
            validate_reply(
                model
                    .generate(snapshot["instruction"].as_str().unwrap(), observation, history.clone(), cancel.clone())
                    .await?,
            )?
        };
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
        if steps.len() >= 20 {
            return Err(ApiError::new(409, "Task step limit reached"));
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
        let result = s.run_command(command, cancel.clone()).await?;
        timings["actionMs"] = json!(executing.elapsed().as_millis() as u64);
        let missed = if result.get("outcome").is_some() {
            result["outcome"]["tapped_nothing"] == true
        } else {
            ["没找到", "只匹配到", "被挡住", "Not found", "Only matched", "Covered"]
                .iter()
                .any(|p| result["text"].as_str().unwrap_or("").starts_with(p))
        };
        let failed = result["kind"] == "error";
        let missed = action["tool"] == "iphone_tap_element" && missed;
        let state = if failed {
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
                json!({"deviceId":s.device.serial_number,"imageBase64":result["jpeg_base64"],"caption":result["caption"],"elementsText":""}),
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
            return Err(ApiError::new(409, "Element tap missed; task halted"));
        }
        if matches!(request["op"].as_str(), Some("tap" | "tap_element")) {
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
