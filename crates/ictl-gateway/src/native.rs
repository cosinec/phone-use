use std::collections::HashMap;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::identity::Device;

const MAX_RESPONSE: usize = 12 * 1024 * 1024;
const MAX_TRANSCRIPT: usize = 32 * 1024;
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

struct RequestTrace {
    id: u64,
    namespace: String,
    started: Instant,
    phase_started: Instant,
    phase: &'static str,
    outcome: &'static str,
    response_bytes: usize,
}

impl RequestTrace {
    fn new(namespace: String) -> Self {
        let id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        eprintln!(
            "{} event=native_request_started namespace={namespace} diagnostic_id={id}",
            chrono::Utc::now().to_rfc3339()
        );
        Self {
            id,
            namespace,
            started: Instant::now(),
            phase_started: Instant::now(),
            phase: "ipc_connect",
            outcome: "cancelled",
            response_bytes: 0,
        }
    }

    fn phase(&mut self, next: &'static str) {
        eprintln!(
            "{} event=native_request_stage namespace={} diagnostic_id={} phase={} elapsed_ms={} next={next}",
            chrono::Utc::now().to_rfc3339(),
            self.namespace,
            self.id,
            self.phase,
            self.phase_started.elapsed().as_millis()
        );
        self.phase = next;
        self.phase_started = Instant::now();
    }
}

impl Drop for RequestTrace {
    fn drop(&mut self) {
        eprintln!(
            "{} event=native_request_finished namespace={} diagnostic_id={} phase={} phase_elapsed_ms={} elapsed_ms={} response_bytes={} outcome={}",
            chrono::Utc::now().to_rfc3339(),
            self.namespace,
            self.id,
            self.phase,
            self.phase_started.elapsed().as_millis(),
            self.started.elapsed().as_millis(),
            self.response_bytes,
            self.outcome
        );
    }
}

struct Group {
    pid: i32,
    cleanup: Mutex<()>,
    cleaned: AtomicBool,
}

struct State {
    ready: bool,
    daemon: &'static str,
    setup: Value,
    setup_pid: Option<i32>,
    transcript: Vec<u8>,
}

struct Inner {
    command: PathBuf,
    device: Device,
    data_dir: PathBuf,
    signing_runtime: Option<PathBuf>,
    socket_path: PathBuf,
    mux_address: String,
    cancel: CancellationToken,
    state: Mutex<State>,
    groups: Mutex<HashMap<i32, Arc<Group>>>,
    stdin: Mutex<Option<(i32, ChildStdin)>>,
    start_lock: Mutex<()>,
    setup_lock: Mutex<()>,
}

#[derive(Clone)]
pub struct NativeController(Arc<Inner>);

impl NativeController {
    pub fn new(
        command: PathBuf,
        device: Device,
        data_dir: PathBuf,
        socket_path: PathBuf,
        mux_address: String,
        cancel: CancellationToken,
    ) -> Self {
        Self(Arc::new(Inner {
            command,
            device,
            data_dir,
            signing_runtime: None,
            socket_path,
            mux_address,
            cancel,
            state: Mutex::new(State {
                ready: false,
                daemon: "idle",
                setup: json!({"state":"idle","transcript":"","exitCode":null}),
                setup_pid: None,
                transcript: Vec::new(),
            }),
            groups: Mutex::new(HashMap::new()),
            stdin: Mutex::new(None),
            start_lock: Mutex::new(()),
            setup_lock: Mutex::new(()),
        }))
    }

    /// Gateway-controlled scope; never derive a shared root from HOME or a device ID.
    pub fn with_signing_runtime(mut self, runtime: PathBuf) -> Self {
        Arc::get_mut(&mut self.0).expect("new controller is exclusively owned").signing_runtime = Some(runtime);
        self
    }

    async fn spawn(&self, mode: &str) -> Result<(Child, Arc<Group>)> {
        if self.0.cancel.is_cancelled() {
            bail!("Controller closed");
        }
        let mut command = Command::new(&self.0.command);
        command
            .arg(mode)
            .env("IPHONE_UDID", &self.0.device.serial_number)
            .env("ICTL_DATA_DIR", &self.0.data_dir)
            .env("ICTL_SOCKET", &self.0.socket_path)
            .env("ICTL_MANAGE_USBMUXD", "0")
            .env("ICTL_CAPTURE_POLICY", "bounded-remote")
            .env("ICTL_LOW_LATENCY", std::env::var("ICTL_LOW_LATENCY").unwrap_or_else(|_| "1".into()))
            .env("USBMUXD_SOCKET_ADDRESS", &self.0.mux_address)
            .stdin(if mode == "setup" { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(runtime) = &self.0.signing_runtime {
            command
                .env("ICTL_SIGNING_ROOT", runtime.join("signing"))
                .env("ICTL_SIGNING_LEGACY_DATA_ROOT", runtime.join("data"));
        }
        command.process_group(0);
        // Registration and shutdown share this lock, so close cannot miss a newly spawned child.
        let mut groups = self.0.groups.lock().await;
        if self.0.cancel.is_cancelled() {
            bail!("Controller closed");
        }
        let child = command.spawn().context("Could not start native process")?;
        let group = Arc::new(Group {
            pid: child.id().ok_or_else(|| anyhow!("Native process has no PID"))? as i32,
            cleanup: Mutex::new(()),
            cleaned: AtomicBool::new(false),
        });
        eprintln!(
            "{} event=native_started namespace={} mode={mode} pid={}",
            chrono::Utc::now().to_rfc3339(),
            self.0.data_dir.file_name().unwrap_or_default().to_string_lossy(),
            group.pid
        );
        groups.insert(group.pid, group.clone());
        Ok((child, group))
    }

    pub async fn start(&self) -> Result<()> {
        let _start = self.0.start_lock.lock().await;
        if self.0.cancel.is_cancelled() {
            bail!("Controller closed");
        }
        {
            let state = self.0.state.lock().await;
            if state.ready {
                return Ok(());
            }
            if state.daemon != "idle" {
                bail!("Native daemon already started");
            }
        }
        tokio::fs::create_dir_all(&self.0.data_dir).await?;
        tokio::fs::set_permissions(&self.0.data_dir, std::fs::Permissions::from_mode(0o700)).await?;
        self.0.state.lock().await.daemon = "starting";
        let (mut child, group) = match self.spawn("daemon").await {
            Ok(child) => child,
            Err(error) => {
                self.0.state.lock().await.daemon = "failed";
                return Err(error);
            }
        };
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(crate::diagnostics::drain(stdout, self.0.data_dir.join("logs/daemon.stdout.log")));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(crate::diagnostics::drain(stderr, self.0.data_dir.join("logs/daemon.stderr.log")));
        }
        let controller = self.clone();
        tokio::spawn(async move {
            let exit = child.wait().await;
            eprintln!(
                "{} event=native_exited namespace={} pid={} exit_code={:?} cancelled={}",
                chrono::Utc::now().to_rfc3339(),
                controller.0.data_dir.file_name().unwrap_or_default().to_string_lossy(),
                group.pid,
                exit.ok().and_then(|s| s.code()),
                controller.0.cancel.is_cancelled()
            );
            {
                let mut state = controller.0.state.lock().await;
                state.ready = false;
                state.daemon = if controller.0.cancel.is_cancelled() { "closed" } else { "failed" };
            }
            let _ = stop_group(&group).await;
            controller.0.groups.lock().await.remove(&group.pid);
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if self.0.cancel.is_cancelled() {
                bail!("Controller closed");
            }
            if self.0.state.lock().await.daemon == "failed" {
                bail!("Native daemon exited");
            }
            if self.request(json!({"op":"daemon"}), Duration::from_secs(1), self.0.cancel.clone()).await.is_ok() {
                let mut state = self.0.state.lock().await;
                if state.daemon != "starting" || self.0.cancel.is_cancelled() {
                    bail!("Native daemon exited");
                }
                state.ready = true;
                state.daemon = "running";
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                bail!("Native startup timeout");
            }
            tokio::select! {
                biased;
                _ = self.0.cancel.cancelled() => bail!("Controller closed"),
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
        }
    }

    pub async fn request(&self, request: Value, timeout: Duration, cancel: CancellationToken) -> Result<Value> {
        self.request_with_deadline(request, timeout, cancel, None).await
    }

    pub async fn request_with_deadline(
        &self,
        mut request: Value,
        timeout: Duration,
        cancel: CancellationToken,
        deadline: Option<ictl_protocol::ActionDeadline>,
    ) -> Result<Value> {
        let mut trace =
            RequestTrace::new(self.0.data_dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
        let object = request.as_object_mut().ok_or_else(|| anyhow!("Invalid native request"))?;
        object.remove(ictl_protocol::ACTION_DEADLINE);
        if let Some(deadline) = deadline {
            object.insert(ictl_protocol::ACTION_DEADLINE.into(), json!(deadline.wire_ns()));
        }
        object.insert(ictl_protocol::DIAGNOSTIC_ID.into(), json!(trace.id));
        object.insert("expect_udid".into(), json!(self.0.device.serial_number));
        object.insert("cancel_on_close".into(), json!(true));
        object.insert("lang".into(), json!("en"));
        let operation = async {
            check_deadline(deadline, trace.id, "ipc_connect")?;
            let mut socket = UnixStream::connect(&self.0.socket_path).await?;
            check_deadline(deadline, trace.id, "ipc_write")?;
            trace.phase("ipc_write");
            let mut request = serde_json::to_vec(&request)?;
            request.push(b'\n');
            socket.write_all(&request).await?;
            trace.phase("ipc_first_byte_wait");
            let mut bytes = Vec::new();
            let mut chunk = [0; 16384];
            loop {
                let length = socket.read(&mut chunk).await?;
                if length == 0 {
                    bail!("Native response interrupted; sent action is not retried");
                }
                if bytes.len() + length > MAX_RESPONSE {
                    bail!("Native response too large");
                }
                let previous = bytes.len();
                if trace.response_bytes == 0 {
                    trace.phase("ipc_response_read");
                }
                trace.response_bytes += length;
                bytes.extend_from_slice(&chunk[..length]);
                if let Some(offset) = chunk[..length].iter().position(|byte| *byte == b'\n') {
                    let end = previous + offset;
                    trace.phase("ipc_json_decode");
                    let value: Value = serde_json::from_slice(&bytes[..end])?;
                    if !matches!(value.get("kind").and_then(Value::as_str), Some("text" | "image" | "error")) {
                        bail!("Invalid native response");
                    }
                    return Ok(value);
                }
            }
        };
        let (result, outcome) = tokio::select! {
            biased;
            _ = self.0.cancel.cancelled() => (Err(anyhow!("Controller closed")), "cancelled"),
            _ = cancel.cancelled() => (Err(anyhow!("Request cancelled; sent action is not retried")), "cancelled"),
            result = tokio::time::timeout(timeout, operation) => match result {
                Ok(result) => { let outcome = if result.is_ok() { "ok" } else { "error" }; (result, outcome) },
                Err(_) => (Err(anyhow!("Native request timeout; sent action is not retried")), "timeout"),
            },
        };
        trace.outcome = outcome;
        result
    }

    pub async fn snapshot(&self) -> Value {
        let state = self.0.state.lock().await;
        let mut setup = state.setup.clone();
        setup["transcript"] = json!(String::from_utf8_lossy(&state.transcript));
        json!({"ready":state.ready,"daemon":state.daemon,"setup":setup})
    }

    pub(crate) async fn start_setup_admitted(
        &self,
        admission: crate::control::Admission,
        deadline: ictl_protocol::ActionDeadline,
    ) -> Result<()> {
        self.start_setup_inner(Some(admission), Some(deadline)).await
    }
    pub async fn start_setup(&self) -> Result<()> {
        self.start_setup_inner(None, None).await
    }
    async fn start_setup_inner(
        &self,
        admission: Option<crate::control::Admission>,
        deadline: Option<ictl_protocol::ActionDeadline>,
    ) -> Result<()> {
        let _setup = self.0.setup_lock.lock().await;
        if self.0.cancel.is_cancelled() {
            bail!("Controller closed");
        }
        if self.0.state.lock().await.setup["state"] == "running" {
            return Ok(());
        }
        // A previous process group's cleanup must finish before starting a new setup.
        let previous = self.0.state.lock().await.setup_pid;
        if let Some(pid) = previous {
            let group = self.0.groups.lock().await.get(&pid).cloned();
            if let Some(group) = group {
                stop_group(&group).await?;
            }
        }
        check_deadline(deadline, 0, "setup_spawn")?;
        let (mut child, group) = self.spawn("setup").await?;
        let pid = group.pid;
        {
            let mut state = self.0.state.lock().await;
            state.setup = json!({"state":"running","transcript":"","exitCode":null});
            state.setup_pid = Some(pid);
            state.transcript.clear();
        }
        *self.0.stdin.lock().await = child.stdin.take().map(|stdin| (pid, stdin));
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(self.clone().read_setup(pid, stdout));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(self.clone().read_setup(pid, stderr));
        }
        let controller = self.clone();
        tokio::spawn(async move {
            // The pending setup child is manual work until it exits or is cancelled.
            let _admission = admission;
            let started = Instant::now();
            let mut timed_out = false;
            let status = tokio::select! {
                result = child.wait() => result.ok(),
                _ = controller.0.cancel.cancelled() => {
                    let _ = stop_group(&group).await;
                    child.wait().await.ok()
                }
                _ = tokio::time::sleep(Duration::from_secs(15 * 60)) => {
                    timed_out = true;
                    let _ = stop_group(&group).await;
                    child.wait().await.ok()
                }
            };
            eprintln!(
                "{} event=setup_finished namespace={} pid={pid} elapsed_ms={} exit_code={:?} cancelled={} timed_out={timed_out}",
                chrono::Utc::now().to_rfc3339(),
                controller.0.data_dir.file_name().unwrap_or_default().to_string_lossy(),
                started.elapsed().as_millis(),
                status.as_ref().and_then(|status| status.code()),
                controller.0.cancel.is_cancelled()
            );
            {
                let mut state = controller.0.state.lock().await;
                if state.setup_pid == Some(pid) {
                    state.setup["exitCode"] = json!(status.as_ref().and_then(|status| status.code()));
                    state.setup["state"] = json!(if controller.0.cancel.is_cancelled() {
                        "stopped"
                    } else if !timed_out && status.is_some_and(|status| status.success()) {
                        "complete"
                    } else {
                        "failed"
                    });
                    if timed_out {
                        state.setup["error"] = json!("Setup timeout");
                    }
                }
            }
            {
                let mut stdin = controller.0.stdin.lock().await;
                if stdin.as_ref().is_some_and(|(input_pid, _)| *input_pid == pid) {
                    *stdin = None;
                }
            }
            let _ = stop_group(&group).await;
            controller.0.groups.lock().await.remove(&pid);
        });
        Ok(())
    }

    async fn read_setup(self, pid: i32, mut input: impl AsyncRead + Unpin) {
        let mut chunk = [0; 4096];
        loop {
            let length = tokio::select! {
                biased;
                _ = self.0.cancel.cancelled() => break,
                result = input.read(&mut chunk) => match result { Ok(0) | Err(_) => break, Ok(length) => length },
            };
            let mut state = self.0.state.lock().await;
            if state.setup_pid != Some(pid) {
                break;
            }
            state.transcript.extend_from_slice(&chunk[..length]);
            if state.transcript.len() > MAX_TRANSCRIPT {
                let mut remove = state.transcript.len() - MAX_TRANSCRIPT;
                while remove < state.transcript.len() && state.transcript[remove] & 0xc0 == 0x80 {
                    remove += 1;
                }
                state.transcript.drain(..remove);
            }
        }
    }

    pub async fn setup_input(&self, line: &str) -> Result<()> {
        self.setup_input_with_deadline(line, None).await
    }
    pub(crate) async fn setup_input_with_deadline(
        &self,
        line: &str,
        deadline: Option<ictl_protocol::ActionDeadline>,
    ) -> Result<()> {
        if line.encode_utf16().count() > 4096 || line.contains(['\r', '\n', '\0']) {
            bail!("Invalid setup input");
        }
        if self.0.cancel.is_cancelled() || self.0.state.lock().await.setup["state"] != "running" {
            bail!("Setup is not running");
        }
        let mut input = self.0.stdin.lock().await;
        check_deadline(deadline, 0, "setup_input")?;
        let Some((_, stdin)) = input.as_mut() else { bail!("Setup is not running") };
        let bytes = format!("{line}\n");
        tokio::select! {
            biased;
            _ = self.0.cancel.cancelled() => bail!("Controller closed"),
            result = stdin.write_all(bytes.as_bytes()) => result?,
        }
        Ok(())
    }

    pub async fn close(&self) -> Result<()> {
        self.0.cancel.cancel();
        {
            let mut state = self.0.state.lock().await;
            state.ready = false;
            state.daemon = "closed";
            if state.setup["state"] == "running" {
                state.setup["state"] = json!("stopped");
            }
        }
        self.0.stdin.lock().await.take();
        let groups: Vec<_> = self.0.groups.lock().await.values().cloned().collect();
        let mut tasks = tokio::task::JoinSet::new();
        for group in groups {
            tasks.spawn(async move { stop_group(&group).await });
        }
        while let Some(result) = tasks.join_next().await {
            result??;
        }
        Ok(())
    }
}

fn signal_group(pid: i32, signal: i32) -> Result<()> {
    // SAFETY: pid is an owned child process-group ID, positive and representable by pid_t.
    if unsafe { libc::kill(-pid, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(error.into())
}

fn group_alive(pid: i32) -> Result<bool> {
    // SAFETY: signal zero only probes an owned process-group ID.
    if unsafe { libc::kill(-pid, 0) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error.into())
}

async fn stop_group(group: &Group) -> Result<()> {
    let _cleanup = group.cleanup.lock().await;
    if group.cleaned.load(Ordering::Acquire) {
        return Ok(());
    }
    signal_group(group.pid, libc::SIGTERM)?;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while group_alive(group.pid)? && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if group_alive(group.pid)? {
        signal_group(group.pid, libc::SIGKILL)?;
        // The leader is reaped by its supervisor. Orphan zombies can remain in a container
        // until its init reaps them, but SIGKILL guarantees no member can execute again.
    }
    group.cleaned.store(true, Ordering::Release);
    Ok(())
}

fn check_deadline(deadline: Option<ictl_protocol::ActionDeadline>, diagnostic_id: u64, stage: &str) -> Result<()> {
    if deadline.is_some_and(|d| d.expired().unwrap_or(true)) {
        eprintln!(
            "{} event=action_rejected diagnostic_id={diagnostic_id} category=expired stage={stage} budget_ms=30000",
            chrono::Utc::now().to_rfc3339()
        );
        bail!("Action expired before native dispatch; request was not sent");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    fn controller(socket: PathBuf, cancel: CancellationToken) -> NativeController {
        NativeController::new(
            "/bin/false".into(),
            Device {
                platform: crate::identity::Platform::Ios,
                serial_number: "a".repeat(40),
                vendor_id: 1452,
                product_id: 4776,
                product_name: None,
            },
            "/tmp/unused".into(),
            socket,
            "127.0.0.1:1".into(),
            cancel,
        )
    }

    #[tokio::test]
    async fn request_adds_identity_and_reads_fragmented_response() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("ctl.sock");
        let server = UnixListener::bind(&socket).unwrap();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = server.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let byte = stream.read_u8().await.unwrap();
                if byte == b'\n' {
                    break;
                }
                request.push(byte);
            }
            let request: Value = serde_json::from_slice(&request).unwrap();
            assert_eq!(request["expect_udid"], "a".repeat(40));
            assert_eq!(request["cancel_on_close"], true);
            assert_eq!(request["lang"], "en");
            stream.write_all(b"{\"kind\":").await.unwrap();
            tokio::task::yield_now().await;
            stream.write_all(b"\"text\",\"text\":\"ok\"}\n").await.unwrap();
        });
        let response = controller(socket, CancellationToken::new())
            .request(json!({"op":"status"}), Duration::from_secs(1), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(response["text"], "ok");
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn expired_native_deadline_never_writes_ipc_and_fresh_keeps_exact_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("ctl.sock");
        let server = UnixListener::bind(&socket).unwrap();
        let received = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = received.clone();
        let peer = tokio::spawn(async move {
            loop {
                let (mut stream, _) = server.accept().await.unwrap();
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut line = Vec::new();
                loop {
                    let byte = stream.read_u8().await.unwrap();
                    if byte == b'\n' {
                        break;
                    }
                    line.push(byte);
                }
                let request: Value = serde_json::from_slice(&line).unwrap();
                stream
                    .write_all(format!("{}\n", json!({"kind":"text","text":request.to_string()})).as_bytes())
                    .await
                    .unwrap();
            }
        });
        let native = controller(socket, CancellationToken::new());
        let expired = ictl_protocol::ActionDeadline::parse(json!(ictl_protocol::monotonic_ns().unwrap() - 1)).unwrap();
        let result = native
            .request_with_deadline(
                json!({"op":"tap","x":1,"y":1}),
                Duration::from_secs(1),
                CancellationToken::new(),
                Some(expired),
            )
            .await;
        assert!(matches!(&result, Err(error) if error.to_string().contains("expired")), "{result:?}");
        assert_eq!(received.load(std::sync::atomic::Ordering::SeqCst), 0);
        let deadline = ictl_protocol::ActionDeadline::admit().unwrap();
        let result = native
            .request_with_deadline(
                json!({"op":"tap","x":1,"y":1}),
                Duration::from_secs(1),
                CancellationToken::new(),
                Some(deadline),
            )
            .await
            .unwrap();
        let request: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
        assert_eq!(request[ictl_protocol::ACTION_DEADLINE], deadline.wire_ns());
        assert_eq!(received.load(std::sync::atomic::Ordering::SeqCst), 1);
        peer.abort();
    }

    #[tokio::test]
    async fn setup_accepts_one_line_without_recording_it() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native-fixture");
        tokio::fs::write(
            &script,
            "#!/bin/sh\nprintf 'fixture prompt\\n'\nIFS= read -r value\nprintf 'setup complete\\n'\n",
        )
        .await
        .unwrap();
        tokio::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).await.unwrap();
        let ctl = NativeController::new(
            script,
            Device {
                platform: crate::identity::Platform::Ios,
                serial_number: "a".repeat(40),
                vendor_id: 1452,
                product_id: 4776,
                product_name: None,
            },
            dir.path().join("data"),
            dir.path().join("ctl.sock"),
            "127.0.0.1:1".into(),
            CancellationToken::new(),
        );
        let control = crate::control::Control::default();
        ctl.start_setup_admitted(control.manual().unwrap(), ictl_protocol::ActionDeadline::admit().unwrap())
            .await
            .unwrap();
        assert!(control.task().is_err(), "setup child must retain manual admission while waiting for input");
        tokio::time::timeout(Duration::from_secs(2), async {
            while !ctl.snapshot().await["setup"]["transcript"].as_str().unwrap().contains("fixture prompt") {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(ctl.setup_input("bad\nline").await.is_err());
        ctl.setup_input("private input").await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while ctl.snapshot().await["setup"]["state"] == "running" {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let snapshot = ctl.snapshot().await;
        assert_eq!(snapshot["setup"]["state"], "complete");
        tokio::time::timeout(Duration::from_secs(2), async {
            while control.task().is_err() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(!snapshot.to_string().contains("private input"));
        ctl.close().await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_escalates_to_kill_an_uncooperative_process_group() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "trap '' TERM; printf ready; while :; do sleep 30; done"])
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let group = Group { pid: child.id().unwrap() as i32, cleanup: Mutex::new(()), cleaned: AtomicBool::new(false) };
        let mut ready = [0; 5];
        tokio::time::timeout(Duration::from_secs(2), child.stdout.as_mut().unwrap().read_exact(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&ready, b"ready");
        tokio::time::timeout(Duration::from_secs(3), stop_group(&group)).await.unwrap().unwrap();
        let status = tokio::time::timeout(Duration::from_secs(1), child.wait()).await.unwrap().unwrap();
        assert!(!status.success());
        assert!(group.cleaned.load(Ordering::Acquire));
        // Repeated cleanup is idempotent even when the group has already been reaped.
        stop_group(&group).await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_closes_sent_socket_without_replay() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("ctl.sock");
        let server = UnixListener::bind(&socket).unwrap();
        let cancel = CancellationToken::new();
        let request = tokio::spawn({
            let ctl = controller(socket, CancellationToken::new());
            let cancel = cancel.clone();
            async move { ctl.request(json!({"op":"tap","x":1,"y":1}), Duration::from_secs(20), cancel).await }
        });
        let (mut stream, _) = server.accept().await.unwrap();
        let mut chunk = [0; 4096];
        assert!(stream.read(&mut chunk).await.unwrap() > 0);
        cancel.cancel();
        assert!(request.await.unwrap().is_err());
        assert_eq!(stream.read(&mut chunk).await.unwrap(), 0);
        assert!(tokio::time::timeout(Duration::from_millis(20), server.accept()).await.is_err());
    }
}
