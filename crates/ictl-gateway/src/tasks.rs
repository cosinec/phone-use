use crate::{
    commands::command_request,
    error::{ApiError, Result},
    gateway::Session,
    model::{Model, validate_reply},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
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
            "id": id, "instruction": instruction.trim(), "state": "observing", "steps": [],
            "confirmation": null, "startedAt": now(), "finishedAt": null, "message": null, "error": null
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
    loop {
        let snapshot = s.tasks.update(id, |t| t.snapshot["state"] = json!("observing")).await?;
        let observation = s.screen(cancel.clone()).await?;
        if observation["deviceId"] != s.device.serial_number {
            return Err(ApiError::new(409, "Observation device identity mismatch"));
        }
        s.tasks.update(id, |t| t.snapshot["state"] = json!("thinking")).await?;
        let steps = snapshot["steps"].as_array().unwrap();
        let mut history: Vec<Value> = steps
            .iter()
            .rev()
            .take(8)
            .map(|step| {
                json!({
                    "tool": step["tool"], "args": step["args"], "reason": step["reason"],
                    "state": step["state"], "result": step["result"]
                })
            })
            .collect();
        history.reverse();
        while history.iter().map(|v| v.to_string().len()).sum::<usize>() > 24000 {
            history.remove(0);
        }
        let action = validate_reply(
            model.generate(snapshot["instruction"].as_str().unwrap(), observation, history, cancel.clone()).await?,
        )?;
        if cancel.is_cancelled() {
            return Err(ApiError::new(409, "Task cancelled"));
        }
        if action["type"] == "done" {
            return Ok(action["message"].as_str().unwrap().to_owned());
        }
        if steps.len() >= 20 {
            return Err(ApiError::new(409, "Task step limit reached"));
        }
        let request = command_request(action["tool"].as_str().unwrap(), &action["args"])?;
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
        let result = s.run_command(command, cancel.clone()).await?;
        let missed = if result.get("outcome").is_some() {
            result["outcome"]["tapped_nothing"] == true
        } else {
            ["没找到", "只匹配到", "被挡住", "Not found", "Only matched", "Covered"]
                .iter()
                .any(|p| result["text"].as_str().unwrap_or("").starts_with(p))
        };
        let failed = result["kind"] == "error";
        let missed = action["tool"] == "iphone_tap_element" && missed;
        s.tasks
            .update(id, |t| {
                let step = t.snapshot["steps"].as_array_mut().unwrap().last_mut().unwrap();
                step["result"] = json!({"kind":result["kind"]});
                step["finishedAt"] = json!(now());
                step["state"] = json!(if failed {
                    "failed"
                } else if missed {
                    "missed"
                } else {
                    "succeeded"
                });
            })
            .await?;
        if failed {
            return Err(ApiError::unavailable("Native action failed"));
        }
        if missed {
            return Err(ApiError::new(409, "Element tap missed; task halted"));
        }
    }
}
