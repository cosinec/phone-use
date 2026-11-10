//! Android commands execute over the authenticated browser's ADB transport.
//! No server-side ADB port, shell listener, or shared device connection is exposed.
use crate::relay::{Frame, MAX_PAYLOAD};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AndroidController(Arc<Inner>);
struct Inner {
    device_id: String,
    outbound: mpsc::Sender<Frame>,
    next: AtomicU32,
    pending: Mutex<HashMap<u32, oneshot::Sender<Value>>>,
    cancel: CancellationToken,
}
impl AndroidController {
    pub fn new(device_id: String, outbound: mpsc::Sender<Frame>, cancel: CancellationToken) -> Self {
        Self(Arc::new(Inner {
            device_id,
            outbound,
            next: AtomicU32::new(1),
            pending: Mutex::new(HashMap::new()),
            cancel,
        }))
    }
    pub fn snapshot(&self) -> Value {
        json!({"ready":!self.0.cancel.is_cancelled(),"daemon":"browser-adb","setup":{"state":"complete","transcript":"Android USB debugging authorized. No Apple account or WDA signing is needed.","exitCode":0}})
    }
    pub async fn request(&self, request: Value, timeout: Duration, cancel: CancellationToken) -> Result<Value> {
        if self.0.cancel.is_cancelled() || cancel.is_cancelled() {
            bail!("Android session closed");
        }
        if request["op"] == "daemon" {
            return Ok(
                json!({"kind":"text","text":json!({"state":{"state":"ready","platform":"android"}}).to_string()}),
            );
        }
        #[allow(deprecated)] // fetch_update supports the workspace MSRV (Rust 1.88).
        let id = self
            .0
            .next
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .map_err(|_| anyhow!("Android request ID limit reached"))?;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.0.pending.lock().await;
            if pending.len() >= 64 {
                bail!("Android command queue full");
            }
            pending.insert(id, sender);
        }
        let operation = async {
            self.0
                .outbound
                .send(Frame::json(14, id, 0, &json!({"deviceId":self.0.device_id,"request":request})))
                .await
                .map_err(|_| anyhow!("Android relay closed"))?;
            receiver.await.map_err(|_| anyhow!("Android command interrupted; sent actions are not retried"))
        };
        let result = tokio::select! {biased;
            _=self.0.cancel.cancelled()=>Err(anyhow!("Android session closed")),
            _=cancel.cancelled()=>Err(anyhow!("Android command cancelled; sent actions are not retried")),
            result=tokio::time::timeout(timeout,operation)=>result.unwrap_or_else(|_|Err(anyhow!("Android command timed out; sent actions are not retried"))),
        };
        self.0.pending.lock().await.remove(&id);
        if result.is_err() {
            let _ = self.0.outbound.try_send(Frame::json(16, id, 0, &Value::Null));
        }
        result
    }
    pub async fn handle(&self, frame: Frame) -> Result<()> {
        if frame.kind != 15
            || frame.stream_id != 0
            || frame.request_id == 0
            || frame.request_id >= self.0.next.load(Ordering::SeqCst)
            || frame.payload.len() > MAX_PAYLOAD
        {
            bail!("Invalid Android response");
        }
        let value: Value = serde_json::from_slice(&frame.payload)?;
        if value["deviceId"] != self.0.device_id
            || !matches!(value["result"]["kind"].as_str(), Some("image" | "text" | "error"))
        {
            bail!("Android response identity or type mismatch");
        }
        let _: ictl_protocol::Response = serde_json::from_value(value["result"].clone())?;
        if let Some(sender) = self.0.pending.lock().await.remove(&frame.request_id) {
            let _ = sender.send(value["result"].clone());
        }
        Ok(())
    }
    pub async fn close(&self) {
        self.0.cancel.cancel();
        self.0.pending.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn controller() -> (AndroidController, mpsc::Receiver<Frame>) {
        let (tx, rx) = mpsc::channel(16);
        (AndroidController::new("android:ABC".into(), tx, CancellationToken::new()), rx)
    }
    #[tokio::test]
    async fn responses_bind_to_identity_and_id_and_use_native_response_types() {
        let (c, mut rx) = controller();
        let copy = c.clone();
        let task = tokio::spawn(async move {
            copy.request(json!({"op":"press_button","button":"home"}), Duration::from_secs(1), CancellationToken::new())
                .await
        });
        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.kind, 14);
        let bad = |device: &str, result: Value| {
            Frame::json(15, frame.request_id, 0, &json!({"deviceId":device,"result":result}))
        };
        assert!(c.handle(bad("android:OTHER", json!({"kind":"text","text":"ok"}))).await.is_err());
        assert!(c.handle(bad("android:ABC", json!({"kind":"image"}))).await.is_err());
        c.handle(bad("android:ABC", json!({"kind":"text","text":"ok"}))).await.unwrap();
        assert_eq!(task.await.unwrap().unwrap()["text"], "ok");
        // Late duplicates are ignored, never treated as new commands.
        c.handle(bad("android:ABC", json!({"kind":"text","text":"late"}))).await.unwrap();
        assert!(c.0.pending.lock().await.is_empty());
    }
    #[tokio::test]
    async fn cancellation_and_timeout_retire_requests_and_notify_browser_without_replay() {
        let (c, mut rx) = controller();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let copy = c.clone();
        let task =
            tokio::spawn(async move { copy.request(json!({"op":"tap"}), Duration::from_secs(1), task_cancel).await });
        let sent = rx.recv().await.unwrap();
        cancel.cancel();
        assert!(task.await.unwrap().is_err());
        let retired = rx.recv().await.unwrap();
        assert_eq!(retired.kind, 16);
        assert_eq!(retired.request_id, sent.request_id);
        let copy = c.clone();
        let timed = tokio::spawn(async move {
            copy.request(json!({"op":"screenshot"}), Duration::from_millis(10), CancellationToken::new()).await
        });
        assert_eq!(rx.recv().await.unwrap().kind, 14);
        assert!(timed.await.unwrap().unwrap_err().to_string().contains("timed out"));
        assert_eq!(rx.recv().await.unwrap().kind, 16);
        assert!(c.0.pending.lock().await.is_empty());
        assert!(rx.try_recv().is_err());
        c.close().await;
        assert!(c.request(json!({"op":"tap"}), Duration::from_secs(1), CancellationToken::new()).await.is_err());
    }
    #[tokio::test]
    async fn status_polling_does_not_touch_device_or_block_commands() {
        let (c, mut rx) = controller();
        let result = c.request(json!({"op":"daemon"}), Duration::from_secs(1), CancellationToken::new()).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(result["text"].as_str().unwrap()).unwrap()["state"]["state"], "ready");
        assert!(rx.try_recv().is_err());
    }
}
