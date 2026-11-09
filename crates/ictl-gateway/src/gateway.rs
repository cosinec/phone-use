use crate::{
    commands::command_request,
    error::{ApiError, Result},
    identity::{Device, canonical_uid, validate_device},
    model::Model,
    mux::{PairRecord, VirtualMux, read_pair_record},
    native::NativeController,
    relay::{Frame, MAX_PAYLOAD, Relay},
    tasks::TaskManager,
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{
        FromRequestParts, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{Method, Request, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, OnceCell, mpsc, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub struct Config {
    pub token: String,
    pub origins: HashSet<String>,
    pub public_url: Option<reqwest::Url>,
    pub runtime: PathBuf,
    pub native: PathBuf,
    pub web_dist: PathBuf,
}
pub struct Gateway {
    pub config: Config,
    pub model: Model,
    registry: Mutex<Registry>,
    pub cancel: CancellationToken,
}
#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Session>>,
    owners: HashMap<String, String>,
}
struct CachedCommand {
    fingerprint: String,
    result: watch::Sender<Option<Result<Value>>>,
}
#[derive(Default)]
struct Commands {
    cached: HashMap<String, CachedCommand>,
    order: VecDeque<String>,
    used: HashSet<String>,
}
struct Job {
    request: Option<Value>,
    result: watch::Sender<Option<Result<Value>>>,
    cancel: CancellationToken,
}
pub struct Session {
    pub id: String,
    pub device: Device,
    namespace: String,
    token: String,
    gateway: Weak<Gateway>,
    pub cancel: CancellationToken,
    hello: CancellationToken,
    state: Mutex<String>,
    attached: AtomicBool,
    pub controller: OnceCell<NativeController>,
    mux: Mutex<Option<VirtualMux>>,
    relay: OnceCell<Relay>,
    pair: Mutex<Option<PairRecord>>,
    socket_dir: PathBuf,
    data_dir: PathBuf,
    commands: Mutex<Commands>,
    jobs: mpsc::Sender<Job>,
    close_lock: Mutex<bool>,
    pub tasks: TaskManager,
}

fn id() -> String {
    Uuid::new_v4().to_string()
}
fn equal(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}
fn native_error(_: anyhow::Error) -> ApiError {
    ApiError::unavailable("Native operation failed; sent actions are not retried")
}
async fn private_dir(path: &std::path::Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::create_dir_all(path).await?;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    Ok(())
}
fn reply(status: u16, value: Value) -> Response {
    let mut response = (StatusCode::from_u16(status).unwrap(), Json(value)).into_response();
    response.headers_mut().insert("cache-control", "no-store".parse().unwrap());
    response
}
impl Gateway {
    pub async fn new(config: Config, model: Model) -> anyhow::Result<Arc<Self>> {
        anyhow::ensure!(!config.token.trim().is_empty(), "CONTROL_ACCESS_TOKEN required");
        anyhow::ensure!(!config.origins.is_empty(), "Exact ALLOWED_ORIGINS required");
        for origin in &config.origins {
            let u = reqwest::Url::parse(origin)?;
            anyhow::ensure!(
                ["http", "https"].contains(&u.scheme()) && u.origin().ascii_serialization() == *origin,
                "Exact ALLOWED_ORIGINS required"
            );
        }
        for p in [&config.runtime, &config.runtime.join("data"), &config.runtime.join("record-map")] {
            private_dir(p).await?;
        }
        Ok(Arc::new(Self {
            config,
            model,
            registry: Mutex::new(Registry::default()),
            cancel: CancellationToken::new(),
        }))
    }
    pub fn router(self: &Arc<Self>) -> Router {
        Router::new().fallback(handle).with_state(self.clone())
    }
    fn record_path(&self, record: &PairRecord) -> PathBuf {
        let mut hash = Sha256::new();
        hash.update(self.config.token.as_bytes());
        hash.update(record.pair_record_base64.as_bytes());
        self.config.runtime.join("record-map").join(format!("{:x}.json", hash.finalize()))
    }
    async fn saved_namespace(&self, record: &PairRecord) -> Result<Option<String>> {
        match tokio::fs::read(self.record_path(record)).await {
            Ok(bytes) => {
                let parsed: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| ApiError::new(500, "Could not read native resume state"))?;
                let namespace = parsed["namespace"]
                    .as_str()
                    .filter(|s| Uuid::parse_str(s).is_ok_and(|u| u.to_string() == *s))
                    .ok_or_else(|| ApiError::new(500, "Could not read native resume state"))?;
                Ok(Some(namespace.to_owned()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(ApiError::new(500, "Could not read native resume state")),
        }
    }
    async fn save_mapping(&self, record: &PairRecord, namespace: &str, registry: &Registry) -> Result<()> {
        if let Some(previous) = self.saved_namespace(record).await?
            && previous != namespace
            && registry.owners.contains_key(&previous)
        {
            return Err(ApiError::new(409, "Native signing state has an active owner"));
        }
        let target = self.record_path(record);
        let temporary = target.with_extension(format!("{}.tmp", id()));
        let bytes = serde_json::to_vec(&json!({"namespace":namespace})).unwrap();
        let write = async {
            use tokio::io::AsyncWriteExt;
            let mut file =
                tokio::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).await?;
            file.write_all(&bytes).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temporary, &target).await
        }
        .await;
        if write.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        write.map_err(|_| ApiError::new(500, "Could not save native resume state"))
    }
    async fn create_session(self: &Arc<Self>, device: Device, mut pair: Option<PairRecord>) -> Result<Arc<Session>> {
        let mut registry = self.registry.lock().await;
        if self.cancel.is_cancelled() {
            return Err(ApiError::new(503, "Gateway closing"));
        }
        if registry.sessions.len() >= 32 {
            return Err(ApiError::new(429, "Session limit reached"));
        }
        let mut namespace = id();
        if let Some(ref mut record) = pair {
            read_pair_record(record, &device.serial_number).map_err(|_| ApiError::new(400, "Invalid pair record"))?;
            record.udid = canonical_uid(&record.udid).map_err(|_| ApiError::new(400, "Invalid pair record"))?;
            if let Some(saved) = self.saved_namespace(record).await? {
                namespace = saved;
            }
        }
        if registry.owners.contains_key(&namespace) {
            return Err(ApiError::new(409, "Native signing state has an active owner"));
        }
        if let Some(record) = &pair {
            self.save_mapping(record, &namespace, &registry).await?;
        }
        let sid = id();
        let socket_dir = std::env::temp_dir().join(format!("ictl-{}", &Uuid::new_v4().simple().to_string()[..12]));
        tokio::fs::create_dir(&socket_dir)
            .await
            .map_err(|_| ApiError::unavailable("Could not create control directory"))?;
        private_dir(&socket_dir).await.map_err(|_| ApiError::unavailable("Could not secure control directory"))?;
        let (jobs, receiver) = mpsc::channel(256);
        let session = Arc::new(Session {
            id: sid.clone(),
            device,
            namespace: namespace.clone(),
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            gateway: Arc::downgrade(self),
            cancel: self.cancel.child_token(),
            hello: CancellationToken::new(),
            state: Mutex::new("waiting_for_relay".into()),
            attached: AtomicBool::new(false),
            controller: OnceCell::new(),
            mux: Mutex::new(None),
            relay: OnceCell::new(),
            pair: Mutex::new(pair),
            socket_dir,
            data_dir: self.config.runtime.join("data").join(&namespace),
            commands: Mutex::new(Commands::default()),
            jobs,
            close_lock: Mutex::new(false),
            tasks: TaskManager::new(),
        });
        registry.owners.insert(namespace, sid.clone());
        registry.sessions.insert(sid, session.clone());
        tokio::spawn(session.clone().work(receiver));
        let waiting = session.clone();
        tokio::spawn(async move {
            tokio::select! {_=waiting.cancel.cancelled()=>{},_=waiting.hello.cancelled()=>return,_=tokio::time::sleep(Duration::from_secs(300))=>{}}
            waiting.close().await;
        });
        Ok(session)
    }
    pub async fn close(&self) {
        self.cancel.cancel();
        let sessions: Vec<_> = self.registry.lock().await.sessions.values().cloned().collect();
        futures_util::future::join_all(sessions.iter().map(|s| s.close())).await;
    }
}
impl Session {
    pub async fn close(&self) {
        self.cancel.cancel();
        let mut done = self.close_lock.lock().await;
        if *done {
            return;
        }
        *self.state.lock().await = "closed".into();
        self.tasks.disconnect().await;
        if let Some(relay) = self.relay.get() {
            relay.close().await;
        }
        if let Some(native) = self.controller.get() {
            let _ = native.close().await;
        }
        if let Some(mux) = self.mux.lock().await.take() {
            mux.close().await;
        }
        let _ = tokio::fs::remove_dir_all(&self.socket_dir).await;
        if let Some(g) = self.gateway.upgrade() {
            let mut registry = g.registry.lock().await;
            registry.sessions.remove(&self.id);
            registry.owners.remove(&self.namespace);
        }
        self.commands.lock().await.cached.clear();
        *self.pair.lock().await = None;
        *done = true;
    }
    pub async fn ready(&self) -> Result<&NativeController> {
        if self.cancel.is_cancelled() {
            return Err(ApiError::new(410, "Session closed"));
        }
        let controller = self.controller.get().ok_or_else(|| ApiError::new(409, "Device relay is not connected"))?;
        let probe = async {
            loop {
                let snapshot = controller.snapshot().await;
                if snapshot["ready"] == true {
                    return Ok(controller);
                }
                if snapshot["daemon"] == "failed" || snapshot["daemon"] == "closed" {
                    return Err(ApiError::unavailable("Native control transport is not ready"));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        };
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(ApiError::new(410, "Session closed")),
            result = tokio::time::timeout(Duration::from_secs(30), probe) => {
                result.unwrap_or_else(|_| Err(ApiError::unavailable("Native control transport is not ready")))
            }
        }
    }
    async fn wait_result(
        &self,
        mut result: watch::Receiver<Option<Result<Value>>>,
        cancel: CancellationToken,
    ) -> Result<Value> {
        loop {
            if let Some(value) = result.borrow().clone() {
                return value;
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(ApiError::new(410, "Session closed")),
                _ = cancel.cancelled() => return Err(ApiError::new(409, "Request cancelled; sent action is not retried")),
                changed = result.changed() => {
                    if changed.is_err() { return Err(ApiError::unavailable("Operation unavailable")); }
                }
            }
        }
    }
    pub async fn run_command(&self, input: Value, cancel: CancellationToken) -> Result<Value> {
        if canonical_uid(input["deviceId"].as_str().unwrap_or("")).ok().as_deref()
            != Some(self.device.serial_number.as_str())
        {
            return Err(ApiError::new(409, "Device identity mismatch"));
        }
        let request_id = input["requestId"]
            .as_str()
            .filter(|s| {
                !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
            })
            .ok_or_else(|| ApiError::new(400, "Invalid requestId"))?;
        let request = command_request(input["tool"].as_str().unwrap_or(""), input.get("args").unwrap_or(&json!({})))?;
        let fingerprint = request.to_string();
        let mut commands = self.commands.lock().await;
        let receiver = if let Some(entry) = commands.cached.get(request_id) {
            if entry.fingerprint != fingerprint {
                return Err(ApiError::new(409, "requestId already used for another command"));
            }
            entry.result.subscribe()
        } else {
            if commands.used.contains(request_id) {
                return Err(ApiError::new(409, "requestId result expired; command cannot be replayed"));
            }
            if commands.used.len() >= 10000 {
                return Err(ApiError::new(429, "Session command-ID limit reached"));
            }
            if commands.cached.len() >= 256 {
                let expired = commands
                    .order
                    .iter()
                    .find(|key| commands.cached.get(*key).is_some_and(|v| v.result.borrow().is_some()))
                    .cloned()
                    .ok_or_else(|| ApiError::new(429, "Command queue full"))?;
                commands.cached.remove(&expired);
                commands.order.retain(|k| k != &expired);
            }
            let (sender, receiver) = watch::channel(None);
            self.jobs
                .try_send(Job { request: Some(request), result: sender.clone(), cancel: cancel.clone() })
                .map_err(|_| ApiError::new(429, "Command queue full"))?;
            commands.used.insert(request_id.to_owned());
            commands.order.push_back(request_id.to_owned());
            commands.cached.insert(request_id.to_owned(), CachedCommand { fingerprint, result: sender });
            receiver
        };
        drop(commands);
        self.wait_result(receiver, cancel).await
    }
    pub async fn screen(&self, cancel: CancellationToken) -> Result<Value> {
        let (result, receiver) = watch::channel(None);
        self.jobs
            .try_send(Job { request: None, result, cancel: cancel.clone() })
            .map_err(|_| ApiError::new(429, "Command queue full"))?;
        self.wait_result(receiver, cancel).await
    }
    async fn work(self: Arc<Self>, mut jobs: mpsc::Receiver<Job>) {
        loop {
            let job = tokio::select! {biased;_=self.cancel.cancelled()=>break,job=jobs.recv()=>match job{Some(j)=>j,None=>break}};
            let result = if job.cancel.is_cancelled() {
                Err(ApiError::new(409, "Request cancelled; sent action is not retried"))
            } else {
                self.execute(job.request, job.cancel).await
            };
            job.result.send_replace(Some(result));
        }
        while let Ok(job) = jobs.try_recv() {
            job.result.send_replace(Some(Err(ApiError::new(410, "Session closed"))));
        }
    }
    async fn execute(&self, request: Option<Value>, cancel: CancellationToken) -> Result<Value> {
        let controller = self.ready().await?;
        let native = |r| controller.request(r, Duration::from_secs(45), cancel.clone());
        if let Some(request) = request {
            return native(request).await.map_err(native_error);
        }
        let image = native(json!({"op":"screenshot","region":null})).await.map_err(native_error)?;
        if image["kind"] != "image" {
            return Err(ApiError::unavailable("Screenshot unavailable"));
        }
        let mut result = json!({"imageBase64":image["jpeg_base64"],"caption":image["caption"],"elementsText":"","deviceId":self.device.serial_number});
        match native(json!({"op":"list_elements","filter":"","limit":80,"max_age_ms":0})).await {
            Ok(v) if v["kind"] == "text" => result["elementsText"] = v["text"].clone(),
            _ => result["elementsError"] = json!("UI elements unavailable"),
        }
        Ok(result)
    }
    async fn snapshot(&self) -> Value {
        let native = match self.controller.get() {
            Some(c) => c.snapshot().await,
            None => json!({"ready":false,"setup":{"state":"idle","transcript":"","exitCode":null}}),
        };
        let daemon = if native["ready"] == true {
            match self
                .controller
                .get()
                .unwrap()
                .request(json!({"op":"daemon"}), Duration::from_secs(3), self.cancel.clone())
                .await
            {
                Ok(v) if v["kind"] == "text" => {
                    serde_json::from_str::<Value>(v["text"].as_str().unwrap_or("")).unwrap_or(Value::Null)
                }
                _ => Value::Null,
            }
        } else {
            Value::Null
        };
        json!({
            "id": self.id,
            "deviceId": self.device.serial_number,
            "state": *self.state.lock().await,
            "ready": native["ready"],
            "daemon": daemon,
            "setup": native["setup"],
            "task": self.tasks.snapshot().await
        })
    }
    async fn hello(self: &Arc<Self>, frame: Frame, outbound: mpsc::Sender<Frame>) -> anyhow::Result<()> {
        anyhow::ensure!(frame.kind == 1 && frame.stream_id == 0, "DeviceHello required first");
        let device = validate_device(&serde_json::from_slice(&frame.payload)?)?;
        anyhow::ensure!(
            device.serial_number == self.device.serial_number
                && device.product_id == self.device.product_id
                && device.vendor_id == self.device.vendor_id,
            "DeviceHello identity mismatch"
        );
        self.hello.cancel();
        *self.state.lock().await = "connecting".into();
        let relay = Relay::new(outbound.clone(), self.cancel.clone());
        self.relay.set(relay.clone()).map_err(|_| anyhow::anyhow!("Duplicate DeviceHello"))?;
        let (pair_sender, mut records) = mpsc::channel::<PairRecord>(8);
        let mux = VirtualMux::start(
            self.device.clone(),
            self.pair.lock().await.clone(),
            relay,
            pair_sender,
            self.cancel.clone(),
        )
        .await?;
        let address = mux.address();
        *self.mux.lock().await = Some(mux);
        let gateway = self.gateway.upgrade().ok_or_else(|| anyhow::anyhow!("Gateway closed"))?;
        let controller = NativeController::new(
            gateway.config.native.clone(),
            self.device.clone(),
            self.data_dir.clone(),
            self.socket_dir.join("ctl.sock"),
            address,
            self.cancel.clone(),
        );
        self.controller.set(controller.clone()).map_err(|_| anyhow::anyhow!("Native already started"))?;
        let session = self.clone();
        tokio::spawn(async move {
            let result = controller.start().await;
            if !session.cancel.is_cancelled() {
                if result.is_ok() {
                    *session.state.lock().await = "connected".into();
                } else {
                    session.close().await;
                }
            }
        });
        let session = self.clone();
        tokio::spawn(async move {
            loop {
                let record = tokio::select! {biased;_=session.cancel.cancelled()=>break,r=records.recv()=>match r{Some(r)=>r,None=>break}};
                let Some(g) = session.gateway.upgrade() else {
                    break;
                };
                let registry = g.registry.lock().await;
                let result = g.save_mapping(&record, &session.namespace, &registry).await;
                drop(registry);
                if result.is_err() {
                    session.close().await;
                    break;
                }
                *session.pair.lock().await = Some(record.clone());
                if outbound.send(Frame::json(12, 0, 0, &serde_json::to_value(record).unwrap())).await.is_err() {
                    break;
                }
            }
        });
        Ok(())
    }
    async fn websocket(self: Arc<Self>, socket: WebSocket) {
        let (mut sink, mut source) = socket.split();
        let (outbound, mut frames) = mpsc::channel::<Frame>(64);
        let alive = Arc::new(AtomicBool::new(true));
        let writer_alive = alive.clone();
        let cancel = self.cancel.clone();
        let writer = tokio::spawn(async move {
            let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
            heartbeat.tick().await;
            loop {
                let message = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    frame = frames.recv() => match frame {
                        Some(frame) => Message::Binary(frame.encode().into()),
                        None => break,
                    },
                    _ = heartbeat.tick() => {
                        if !writer_alive.swap(false, Ordering::SeqCst) {
                            cancel.cancel();
                            break;
                        }
                        Message::Ping(Vec::new().into())
                    }
                };
                let sent = tokio::select! {
                    _ = cancel.cancelled() => break,
                    result = tokio::time::timeout(Duration::from_secs(20), sink.send(message)) => result,
                };
                if !matches!(sent, Ok(Ok(()))) {
                    cancel.cancel();
                    break;
                }
            }
        });
        let deadline = tokio::time::sleep(Duration::from_secs(10));
        tokio::pin!(deadline);
        let mut hello = false;
        loop {
            let next = tokio::select! {biased;_=self.cancel.cancelled()=>break,_=&mut deadline,if !hello=>break,next=source.next()=>next};
            let result = match next {
                Some(Ok(Message::Binary(bytes))) => match Frame::decode(&bytes) {
                    Ok(frame) if !hello => {
                        hello = true;
                        self.hello(frame, outbound.clone()).await
                    }
                    Ok(frame) => match frame.kind {
                        2..=5 if frame.kind != 2 => self.relay.get().unwrap().handle(frame).await,
                        8 => outbound
                            .send(Frame::json(9, frame.request_id, 0, &Value::Null))
                            .await
                            .map_err(|_| anyhow::anyhow!("Relay closed")),
                        9 => Ok(()),
                        10 => {
                            if let Some(record) = self.pair.lock().await.clone() {
                                outbound
                                    .send(Frame::json(12, 0, 0, &serde_json::to_value(record).unwrap()))
                                    .await
                                    .map_err(|_| anyhow::anyhow!("Relay closed"))
                            } else {
                                let session = self.clone();
                                tokio::spawn(async move {
                                    if let Ok(c) = session.ready().await {
                                        let _ = c.start_setup().await;
                                    }
                                });
                                Ok(())
                            }
                        }
                        11 => outbound
                            .send(Frame::json(
                                7,
                                frame.request_id,
                                0,
                                &json!({"error":"Asset installation is unsupported; use native setup for WDA"}),
                            ))
                            .await
                            .map_err(|_| anyhow::anyhow!("Relay closed")),
                        _ => Err(anyhow::anyhow!("Invalid relay message")),
                    },
                    Err(e) => Err(e),
                },
                Some(Ok(Message::Pong(_))) => {
                    alive.store(true, Ordering::SeqCst);
                    Ok(())
                }
                Some(Ok(Message::Ping(_))) => Ok(()),
                _ => break,
            };
            if result.is_err() {
                break;
            }
        }
        self.close().await;
        let _ = writer.await;
    }
}

async fn body(request: Request<Body>) -> Result<Value> {
    let bytes = tokio::time::timeout(Duration::from_secs(15), to_bytes(request.into_body(), MAX_PAYLOAD))
        .await
        .map_err(|_| ApiError::new(408, "Request body timeout"))?
        .map_err(|_| ApiError::new(413, "Request body too large"))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::new(400, "Invalid JSON body"))?;
    if !value.is_object() {
        return Err(ApiError::new(400, "Invalid JSON body"));
    }
    Ok(value)
}
async fn handle(State(gateway): State<Arc<Gateway>>, request: Request<Body>) -> Response {
    let origin = request.headers().get("origin").and_then(|h| h.to_str().ok()).map(str::to_owned);
    if origin.as_ref().is_some_and(|o| !gateway.config.origins.contains(o)) {
        return ApiError::new(403, "Origin denied").into_response();
    }
    let mut response = match dispatch(gateway, request).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    if let Some(origin) = origin {
        response.headers_mut().insert("access-control-allow-origin", origin.parse().unwrap());
        response.headers_mut().insert("vary", "Origin".parse().unwrap());
    }
    response
}
async fn dispatch(g: Arc<Gateway>, request: Request<Body>) -> Result<Response> {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    if path == "/ios/device/ws" {
        let origin = request.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
        if !g.config.origins.contains(origin) {
            return Err(ApiError::new(403, "Origin denied"));
        }
        let query = reqwest::Url::parse(&format!("http://gateway{}", request.uri()))
            .map_err(|_| ApiError::new(400, "Invalid relay URL"))?;
        let token = query.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.into_owned()).unwrap_or_default();
        let registry = g.registry.lock().await;
        let session = registry
            .sessions
            .values()
            .find(|s| !s.cancel.is_cancelled() && equal(&token, &s.token))
            .cloned()
            .ok_or_else(|| ApiError::new(401, "Authentication required"))?;
        drop(registry);
        let (mut parts, _) = request.into_parts();
        let ws = WebSocketUpgrade::from_request_parts(&mut parts, &())
            .await
            .map_err(|_| ApiError::new(400, "Invalid WebSocket upgrade"))?;
        if session.attached.swap(true, Ordering::SeqCst) {
            return Err(ApiError::new(409, "Relay already connected"));
        }
        return Ok(ws
            .max_message_size(MAX_PAYLOAD + 16)
            .max_frame_size(MAX_PAYLOAD + 16)
            .on_upgrade(move |socket| session.websocket(socket))
            .into_response());
    }
    if method == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        response.headers_mut().insert("access-control-allow-headers", "Authorization, Content-Type".parse().unwrap());
        response.headers_mut().insert("access-control-allow-methods", "GET,POST,DELETE,OPTIONS".parse().unwrap());
        return Ok(response);
    }
    if method == Method::GET && path == "/api/config" {
        return Ok(reply(200, json!({"aiReady":g.model.ready(),"model":g.model.name})));
    }
    if let Some(response) = crate::static_files::serve(&g.config.web_dist, &method, &path).await {
        return Ok(response);
    }
    let token = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_owned();
    if method == Method::POST && path == "/api/sessions" {
        if !equal(&token, &g.config.token) {
            return Err(ApiError::new(401, "Authentication required"));
        }
        let host = request.headers().get("host").and_then(|v| v.to_str().ok()).unwrap_or("127.0.0.1").to_owned();
        let input = body(request).await?;
        let device =
            validate_device(&input["device"]).map_err(|_| ApiError::new(400, "Invalid Apple device identity"))?;
        let pair = match input.get("pairRecord").filter(|v| !v.is_null()) {
            Some(v) => Some(serde_json::from_value(v.clone()).map_err(|_| ApiError::new(400, "Invalid pair record"))?),
            None => None,
        };
        let base = g
            .config
            .public_url
            .clone()
            .map(Ok)
            .unwrap_or_else(|| reqwest::Url::parse(&format!("http://{host}")))
            .map_err(|_| ApiError::new(400, "Invalid host"))?;
        let mut relay = base.join("/ios/device/ws").map_err(|_| ApiError::new(400, "Invalid host"))?;
        relay
            .set_scheme(if base.scheme() == "https" { "wss" } else { "ws" })
            .map_err(|_| ApiError::new(400, "Invalid host"))?;
        let s = g.create_session(device, pair).await?;
        relay.query_pairs_mut().append_pair("token", &s.token);
        return Ok(reply(
            201,
            json!({"id":s.id,"deviceId":s.device.serial_number,"token":s.token,"relayUrl":relay.as_str(),"state":"waiting_for_relay"}),
        ));
    }
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if parts.len() < 3 || parts[0] != "api" || parts[1] != "sessions" || Uuid::parse_str(parts[2]).is_err() {
        return Err(ApiError::new(404, "Route not found"));
    }
    let s = g
        .registry
        .lock()
        .await
        .sessions
        .get(parts[2])
        .cloned()
        .ok_or_else(|| ApiError::new(404, "Session not found"))?;
    if s.cancel.is_cancelled() || !equal(&token, &s.token) {
        return Err(ApiError::new(401, "Authentication required"));
    }
    let route = &parts[3..];
    match (method, route) {
        (Method::GET, []) => Ok(reply(200, s.snapshot().await)),
        (Method::DELETE, []) => {
            s.close().await;
            Ok(reply(200, json!({"state":"closed"})))
        }
        (Method::POST, ["command"]) => Ok(reply(200, s.run_command(body(request).await?, s.cancel.clone()).await?)),
        (Method::GET, ["screen"]) => Ok(reply(200, s.screen(s.cancel.clone()).await?)),
        (Method::POST, ["setup"]) => {
            body(request).await?;
            let c = s.ready().await?;
            c.start_setup().await.map_err(native_error)?;
            Ok(reply(200, c.snapshot().await["setup"].clone()))
        }
        (Method::POST, ["setup", "input"]) => {
            let input = body(request).await?;
            let line = input["line"]
                .as_str()
                .filter(|s| s.chars().count() <= 4096 && !s.contains(['\r', '\n', '\0']))
                .ok_or_else(|| ApiError::new(400, "Invalid setup input"))?;
            let c = s.ready().await?;
            if c.snapshot().await["setup"]["state"] != "running" {
                return Err(ApiError::new(409, "Setup is not running"));
            }
            c.setup_input(line).await.map_err(native_error)?;
            Ok(reply(200, json!({"accepted":true})))
        }
        (Method::POST, ["tasks"]) => {
            let input = body(request).await?;
            if input.as_object().unwrap().keys().any(|k| k != "instruction") {
                return Err(ApiError::new(400, "Invalid task request"));
            }
            if !g.model.ready() {
                return Err(ApiError::unavailable("AI is not configured"));
            }
            s.ready().await?;
            Ok(reply(
                201,
                s.tasks.start(s.clone(), input["instruction"].as_str().unwrap_or(""), g.model.clone()).await?,
            ))
        }
        (Method::POST, ["tasks", task, "stop"]) => {
            if !body(request).await?.as_object().unwrap().is_empty() {
                return Err(ApiError::new(400, "Invalid stop request"));
            }
            Ok(reply(200, s.tasks.stop(task).await?))
        }
        (Method::POST, ["tasks", task, "confirm"]) => {
            let input = body(request).await?;
            if input.as_object().unwrap().keys().any(|k| !["actionId", "approved"].contains(&k.as_str()))
                || !input["actionId"].is_string()
                || !input["approved"].is_boolean()
            {
                return Err(ApiError::new(400, "Invalid confirmation request"));
            }
            Ok(reply(
                200,
                s.tasks
                    .confirm(task, input["actionId"].as_str().unwrap(), input["approved"].as_bool().unwrap())
                    .await?,
            ))
        }
        _ => Err(ApiError::new(404, "Route not found")),
    }
}
