use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub const MAX_PAYLOAD: usize = 1024 * 1024;
pub const MAX_USB_DATA: usize = 3 * 16384 - 16 - 20;
const STREAM_BUFFER: usize = 64 * 1024;
// Match the WebSocket writer's single-send budget without blocking stream cleanup.
const CLOSE_DELIVERY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
pub struct Frame {
    pub kind: u8,
    pub request_id: u32,
    pub stream_id: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn json(kind: u8, request_id: u32, stream_id: u32, value: &Value) -> Self {
        Self { kind, request_id, stream_id, payload: serde_json::to_vec(value).expect("JSON value serializes") }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = vec![0; 16];
        bytes[0] = 1;
        bytes[1] = self.kind;
        bytes[4..8].copy_from_slice(&self.request_id.to_be_bytes());
        bytes[8..12].copy_from_slice(&self.stream_id.to_be_bytes());
        bytes[12..16].copy_from_slice(&(self.payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.payload);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 16 || bytes[0] != 1 || bytes[2] != 0 || bytes[3] != 0 {
            bail!("Invalid relay header");
        }
        let read = |start| u32::from_be_bytes(bytes[start..start + 4].try_into().expect("header bounded"));
        let size = read(12) as usize;
        if size > MAX_PAYLOAD || bytes.len() != size + 16 {
            bail!("Invalid relay length");
        }
        Ok(Self { kind: bytes[1], request_id: read(4), stream_id: read(8), payload: bytes[16..].to_vec() })
    }
}

struct Entry {
    port: u16,
    opened: bool,
    result: Option<oneshot::Sender<bool>>,
    incoming: mpsc::Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    cancel: CancellationToken,
    stats: Arc<StreamStats>,
}

struct StreamStats {
    started: Instant,
    received_bytes: AtomicU64,
    sent_bytes: AtomicU64,
}

impl Entry {
    fn log(&self, session: &str, id: u32, event: &str, reason: &str) {
        eprintln!(
            "{} event={event} session={session} stream={id} port={} reason={reason} elapsed_ms={} received_bytes={} sent_bytes={} queued_bytes={} queue_capacity={}",
            chrono::Utc::now().to_rfc3339(),
            self.port,
            self.stats.started.elapsed().as_millis(),
            self.stats.received_bytes.load(Ordering::Relaxed),
            self.stats.sent_bytes.load(Ordering::Relaxed),
            self.queued.load(Ordering::Relaxed),
            self.incoming.capacity()
        );
    }
}

struct Streams {
    next_id: u64,
    entries: HashMap<u32, Entry>,
    late_received_frames: u64,
    late_received_bytes: u64,
}

struct Inner {
    session_id: String,
    streams: Mutex<Streams>,
    outbound: mpsc::Sender<Frame>,
    cancel: CancellationToken,
}

#[derive(Clone)]
pub struct Relay(Arc<Inner>);

// `open` can be dropped by an outer timeout while its handshake is pending.
// Keep retirement owned until the stream pumps take over after a successful open.
struct PendingOpen {
    relay: Relay,
    id: Option<u32>,
}

impl Drop for PendingOpen {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            let relay = self.relay.clone();
            tokio::spawn(async move { relay.retire(id, "open_future_dropped").await });
        }
    }
}

impl Relay {
    pub fn new(outbound: mpsc::Sender<Frame>, cancel: CancellationToken, session_id: String) -> Self {
        Self(Arc::new(Inner {
            session_id,
            streams: Mutex::new(Streams {
                next_id: 1,
                entries: HashMap::new(),
                late_received_frames: 0,
                late_received_bytes: 0,
            }),
            outbound,
            cancel,
        }))
    }

    async fn send(&self, frame: Frame) -> Result<()> {
        tokio::select! {
            biased;
            _ = self.0.cancel.cancelled() => bail!("Relay closed"),
            result = self.0.outbound.send(frame) => result.map_err(|_| anyhow!("Relay closed")),
        }
    }

    async fn retire(&self, id: u32, reason: &'static str) {
        let entry = self.0.streams.lock().await.entries.remove(&id);
        if let Some(entry) = entry {
            entry.log(&self.0.session_id, id, "relay_stream_retired", reason);
            entry.cancel.cancel();
            if !self.0.cancel.is_cancelled() {
                // Closing a stream must never block cleanup behind a stalled socket.
                match self.0.outbound.try_send(Frame { kind: 5, request_id: 0, stream_id: id, payload: Vec::new() }) {
                    Ok(()) => entry.log(&self.0.session_id, id, "relay_close_enqueued", "queued_immediately"),
                    Err(mpsc::error::TrySendError::Full(frame)) => {
                        entry.log(&self.0.session_id, id, "relay_close_deferred", "outbound_queue_full");
                        let outbound = self.0.outbound.clone();
                        let cancel = self.0.cancel.clone();
                        let session = self.0.session_id.clone();
                        tokio::spawn(async move {
                            let began = Instant::now();
                            let result = tokio::select! {
                                biased;
                                _ = cancel.cancelled() => {
                                    entry.log(&session, id, "relay_close_abandoned", "session_cancelled");
                                    return;
                                },
                                sent = tokio::time::timeout(CLOSE_DELIVERY_TIMEOUT, outbound.send(frame)) => sent,
                            };
                            let (event, reason) = match result {
                                Ok(Ok(())) => ("relay_close_enqueued", "queue_recovered"),
                                Ok(Err(_)) => ("relay_cancel_requested", "close_queue_closed"),
                                Err(_) => ("relay_cancel_requested", "close_delivery_timeout"),
                            };
                            eprintln!(
                                "{} event={event} session={session} stream={id} port={} reason={reason} wait_ms={} timeout_ms={} outbound_capacity={}",
                                chrono::Utc::now().to_rfc3339(),
                                entry.port,
                                began.elapsed().as_millis(),
                                CLOSE_DELIVERY_TIMEOUT.as_millis(),
                                outbound.capacity()
                            );
                            if !matches!(result, Ok(Ok(()))) {
                                cancel.cancel();
                            }
                        });
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        entry.log(&self.0.session_id, id, "relay_cancel_requested", "outbound_queue_closed");
                        self.0.cancel.cancel();
                    }
                }
            }
        }
    }

    pub async fn open(&self, port: u16) -> Result<DuplexStream> {
        let (result_tx, result_rx) = oneshot::channel();
        let (incoming_tx, mut incoming_rx) = mpsc::channel::<Vec<u8>>(256);
        let cancel = self.0.cancel.child_token();
        let queued = Arc::new(AtomicUsize::new(0));
        let stats = Arc::new(StreamStats {
            started: Instant::now(),
            received_bytes: AtomicU64::new(0),
            sent_bytes: AtomicU64::new(0),
        });
        let id = {
            let mut streams = self.0.streams.lock().await;
            if self.0.cancel.is_cancelled() || streams.entries.len() >= 64 || streams.next_id > u32::MAX as u64 {
                bail!("Relay stream limit reached or closed");
            }
            let id = streams.next_id as u32;
            streams.next_id += 1;
            streams.entries.insert(
                id,
                Entry {
                    port,
                    opened: false,
                    result: Some(result_tx),
                    incoming: incoming_tx,
                    queued: queued.clone(),
                    cancel: cancel.clone(),
                    stats: stats.clone(),
                },
            );
            id
        };
        let mut pending = PendingOpen { relay: self.clone(), id: Some(id) };
        eprintln!(
            "{} event=relay_stream_open_requested session={} stream={id} port={port}",
            chrono::Utc::now().to_rfc3339(),
            self.0.session_id
        );
        let opened = async {
            self.send(Frame::json(2, id, id, &json!({ "port": port }))).await?;
            match result_rx.await {
                Ok(true) => Ok(()),
                _ => bail!("Device refused stream"),
            }
        };
        let (result, failure_reason) = tokio::select! {
            biased;
            _ = cancel.cancelled() => (Err(anyhow!("Relay closed")), "open_cancelled"),
            result = tokio::time::timeout(Duration::from_secs(20), opened) => match result {
                Ok(result) => (result, "open_send_or_result_failed"),
                Err(_) => (Err(anyhow!("Stream open timeout")), "open_timeout"),
            },
        };
        if let Err(error) = result {
            self.retire(id, failure_reason).await;
            pending.id = None;
            return Err(error);
        }
        let (local, remote) = tokio::io::duplex(STREAM_BUFFER);
        let (mut read, mut write) = tokio::io::split(remote);
        let inbound_cancel = cancel.clone();
        let inbound_relay = self.clone();
        tokio::spawn(async move {
            let result: Result<()> = async {
                loop {
                    let data = tokio::select! {
                        biased;
                        _ = inbound_cancel.cancelled() => break,
                        data = incoming_rx.recv() => match data { Some(data) => data, None => break },
                    };
                    tokio::select! {
                        biased;
                        _ = inbound_cancel.cancelled() => break,
                        result = write.write_all(&data) => result?,
                    }
                    queued.fetch_sub(data.len(), Ordering::AcqRel);
                }
                Ok(())
            }
            .await;
            let reason = if inbound_cancel.is_cancelled() {
                "stream_cancelled"
            } else if result.is_err() {
                "local_write_failed"
            } else {
                "incoming_queue_closed"
            };
            inbound_relay.retire(id, reason).await;
        });
        let outbound_relay = self.clone();
        tokio::spawn(async move {
            let mut failure_reason = "local_read_failed";
            let result: Result<()> = async {
                let mut buffer = vec![0; MAX_USB_DATA];
                loop {
                    failure_reason = "local_read_failed";
                    let length = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        result = read.read(&mut buffer) => result?,
                    };
                    if length == 0 { break; }
                    failure_reason = "outbound_send_failed";
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        result = outbound_relay.send(Frame { kind: 4, request_id: 0, stream_id: id, payload: buffer[..length].to_vec() }) => result?,
                    }
                    stats.sent_bytes.fetch_add(length as u64, Ordering::Relaxed);
                }
                Ok(())
            }.await;
            let reason = if cancel.is_cancelled() {
                "stream_cancelled"
            } else if result.is_err() {
                failure_reason
            } else {
                "local_eof"
            };
            outbound_relay.retire(id, reason).await;
        });
        pending.id = None;
        Ok(local)
    }

    pub async fn handle(&self, frame: Frame) -> Result<()> {
        let mut streams = self.0.streams.lock().await;
        if frame.stream_id == 0 || frame.stream_id as u64 >= streams.next_id {
            bail!("Unknown relay stream");
        }
        match frame.kind {
            3 => {
                if frame.request_id != frame.stream_id {
                    bail!("Invalid OpenResult");
                }
                let result: Value = serde_json::from_slice(&frame.payload)?;
                let ok = result.get("ok").and_then(Value::as_bool).ok_or_else(|| anyhow!("Invalid OpenResult"))?;
                let Some(entry) = streams.entries.get_mut(&frame.stream_id) else { return Ok(()) };
                if entry.opened || entry.result.is_none() {
                    bail!("Unexpected OpenResult");
                }
                if ok {
                    entry.opened = true;
                    entry.log(&self.0.session_id, frame.stream_id, "relay_stream_opened", "device_accepted");
                    if let Some(sender) = entry.result.take() {
                        let _ = sender.send(true);
                    }
                } else {
                    let entry = streams.entries.remove(&frame.stream_id).expect("entry exists");
                    entry.log(&self.0.session_id, frame.stream_id, "relay_stream_retired", "device_refused");
                    entry.cancel.cancel();
                    if let Some(sender) = entry.result {
                        let _ = sender.send(false);
                    }
                }
            }
            4 => {
                if frame.request_id != 0 {
                    bail!("Invalid StreamData");
                }
                let length = frame.payload.len();
                let Some(entry) = streams.entries.get(&frame.stream_id) else {
                    streams.late_received_frames = streams.late_received_frames.saturating_add(1);
                    streams.late_received_bytes = streams.late_received_bytes.saturating_add(length as u64);
                    return Ok(());
                };
                if !entry.opened {
                    bail!("Unknown or unopened stream");
                }
                let previous = entry.queued.fetch_add(length, Ordering::AcqRel);
                // The duplex has STREAM_BUFFER bytes in addition to the queue.
                let reason = if previous.saturating_add(length) > MAX_PAYLOAD - STREAM_BUFFER {
                    Some("receive_bytes_exceeded")
                } else {
                    match entry.incoming.try_send(frame.payload) {
                        Ok(()) => None,
                        Err(mpsc::error::TrySendError::Full(_)) => Some("receive_frames_exceeded"),
                        Err(mpsc::error::TrySendError::Closed(_)) => Some("consumer_closed"),
                    }
                };
                if let Some(reason) = reason {
                    entry.queued.fetch_sub(length, Ordering::AcqRel);
                    eprintln!(
                        "{} event=relay_stream_closed session={} stream={} port={} reason={reason} queued_bytes={previous} incoming_bytes={length} queue_capacity={} action=close_stream",
                        chrono::Utc::now().to_rfc3339(),
                        self.0.session_id,
                        frame.stream_id,
                        entry.port,
                        entry.incoming.capacity()
                    );
                    // A slow reader is local to this stream. Release the registry
                    // before retiring it so unrelated device channels keep running.
                    drop(streams);
                    self.retire(frame.stream_id, reason).await;
                } else {
                    entry.stats.received_bytes.fetch_add(length as u64, Ordering::Relaxed);
                }
            }
            5 => {
                if frame.request_id != 0 {
                    bail!("Invalid StreamClose");
                }
                if let Some(entry) = streams.entries.remove(&frame.stream_id) {
                    entry.log(&self.0.session_id, frame.stream_id, "relay_stream_retired", "peer_close");
                    entry.cancel.cancel();
                }
            }
            _ => bail!("Unsupported stream frame"),
        }
        Ok(())
    }

    pub async fn close(&self) {
        self.0.cancel.cancel();
        let mut streams = self.0.streams.lock().await;
        if streams.late_received_frames > 0 {
            eprintln!(
                "{} event=relay_late_data_totals session={} received_frames={} received_bytes={}",
                chrono::Utc::now().to_rfc3339(),
                self.0.session_id,
                std::mem::take(&mut streams.late_received_frames),
                std::mem::take(&mut streams.late_received_bytes)
            );
        }
        for (id, entry) in streams.entries.drain() {
            entry.log(&self.0.session_id, id, "relay_stream_retired", "session_closed");
            entry.cancel.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn opened_stream(relay: &Relay, rx: &mut mpsc::Receiver<Frame>) -> (DuplexStream, u32) {
        let opening = tokio::spawn({
            let relay = relay.clone();
            async move { relay.open(8100).await }
        });
        let frame = rx.recv().await.unwrap();
        relay.handle(Frame::json(3, frame.stream_id, frame.stream_id, &json!({"ok":true}))).await.unwrap();
        (opening.await.unwrap().unwrap(), frame.stream_id)
    }

    #[tokio::test]
    async fn externally_cancelled_open_retires_only_its_stream() {
        for sent in [false, true] {
            let (tx, mut rx) = mpsc::channel(1);
            let cancel = CancellationToken::new();
            let relay = Relay::new(tx.clone(), cancel.clone(), "fixture".into());
            let (mut control, control_id) = opened_stream(&relay, &mut rx).await;
            if !sent {
                tx.send(Frame::json(9, 1, 0, &Value::Null)).await.unwrap();
            }
            let opening = tokio::spawn({
                let relay = relay.clone();
                async move { relay.open(9100).await }
            });
            let id = if sent {
                rx.recv().await.unwrap().stream_id
            } else {
                loop {
                    let streams = relay.0.streams.lock().await;
                    if let Some((&id, _)) = streams.entries.iter().find(|(_, entry)| entry.port == 9100) {
                        break id;
                    }
                    drop(streams);
                    tokio::task::yield_now().await;
                }
            };
            opening.abort();
            assert!(opening.await.unwrap_err().is_cancelled());
            for _ in 0..4 {
                tokio::task::yield_now().await;
            }
            assert!(!relay.0.streams.lock().await.entries.contains_key(&id), "cancelled pending open leaked");
            if !sent {
                assert_eq!(rx.recv().await.unwrap().kind, 9);
            }
            let close = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap().unwrap();
            assert_eq!((close.kind, close.stream_id), (5, id));
            relay.handle(Frame::json(3, id, id, &json!({"ok":true}))).await.unwrap();
            relay.handle(Frame { kind: 4, request_id: 0, stream_id: id, payload: b"late".to_vec() }).await.unwrap();
            relay
                .handle(Frame { kind: 4, request_id: 0, stream_id: control_id, payload: b"alive".to_vec() })
                .await
                .unwrap();
            let mut word = [0; 5];
            tokio::time::timeout(Duration::from_secs(1), control.read_exact(&mut word)).await.unwrap().unwrap();
            assert_eq!(&word, b"alive");
            assert!(!cancel.is_cancelled());
            assert!(rx.try_recv().is_err(), "abandoned open closes once");
            relay.close().await;
        }
    }

    #[tokio::test]
    async fn late_data_counts_are_bounded_aggregates_and_unknown_streams_still_fail() {
        let (tx, mut rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let relay = Relay::new(tx, cancel.clone(), "fixture".into());
        let (_stream, id) = opened_stream(&relay, &mut rx).await;
        relay.retire(id, "test_close").await;
        for payload in [b"one".to_vec(), b"second".to_vec(), Vec::new()] {
            relay.handle(Frame { kind: 4, request_id: 0, stream_id: id, payload }).await.unwrap();
        }
        {
            let streams = relay.0.streams.lock().await;
            assert_eq!(streams.late_received_frames, 3);
            assert_eq!(streams.late_received_bytes, 9);
            assert!(streams.entries.is_empty());
        }
        assert!(relay.handle(Frame { kind: 4, request_id: 0, stream_id: id + 1, payload: vec![1] }).await.is_err());
        assert!(!cancel.is_cancelled());
        relay.close().await;
        let streams = relay.0.streams.lock().await;
        assert_eq!(streams.late_received_frames, 0);
        assert_eq!(streams.late_received_bytes, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn full_queue_defers_close_while_other_stream_keeps_working() {
        let (tx, mut rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let relay = Relay::new(tx.clone(), cancel.clone(), "fixture".into());
        let (_closing, id) = opened_stream(&relay, &mut rx).await;
        let (mut control, control_id) = opened_stream(&relay, &mut rx).await;
        tx.send(Frame::json(9, 1, 0, &Value::Null)).await.unwrap();
        relay.retire(id, "test_close").await;
        tokio::task::yield_now().await;
        assert!(!cancel.is_cancelled());
        relay
            .handle(Frame { kind: 4, request_id: 0, stream_id: control_id, payload: b"alive".to_vec() })
            .await
            .unwrap();
        let mut word = [0; 5];
        control.read_exact(&mut word).await.unwrap();
        assert_eq!(&word, b"alive");
        assert_eq!(rx.recv().await.unwrap().kind, 9);
        let close = rx.recv().await.unwrap();
        assert_eq!((close.kind, close.stream_id), (5, id));
        assert!(!cancel.is_cancelled());
        relay.retire(id, "duplicate_close").await;
        assert!(rx.try_recv().is_err(), "close is delivered once");
        relay.close().await;
    }

    #[tokio::test(start_paused = true)]
    async fn close_delivery_timeout_cancels_a_stalled_session() {
        let (tx, mut rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let relay = Relay::new(tx.clone(), cancel.clone(), "fixture".into());
        let (_stream, id) = opened_stream(&relay, &mut rx).await;
        tx.send(Frame::json(9, 1, 0, &Value::Null)).await.unwrap();
        relay.retire(id, "test_close").await;
        tokio::task::yield_now().await;
        tokio::time::advance(CLOSE_DELIVERY_TIMEOUT - Duration::from_millis(1)).await;
        assert!(!cancel.is_cancelled());
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert!(cancel.is_cancelled());
    }

    #[tokio::test(start_paused = true)]
    async fn closed_queue_cancels_immediate_and_deferred_closes() {
        for deferred in [false, true] {
            let (tx, mut rx) = mpsc::channel(1);
            let cancel = CancellationToken::new();
            let relay = Relay::new(tx.clone(), cancel.clone(), "fixture".into());
            let (_stream, id) = opened_stream(&relay, &mut rx).await;
            if deferred {
                tx.send(Frame::json(9, 1, 0, &Value::Null)).await.unwrap();
                relay.retire(id, "test_close").await;
                tokio::task::yield_now().await;
            }
            drop(rx);
            if !deferred {
                relay.retire(id, "test_close").await;
            }
            tokio::task::yield_now().await;
            assert!(cancel.is_cancelled());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn session_cancel_releases_a_pending_close_sender() {
        let (tx, mut rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let relay = Relay::new(tx.clone(), cancel.clone(), "fixture".into());
        let (_stream, id) = opened_stream(&relay, &mut rx).await;
        tx.send(Frame::json(9, 1, 0, &Value::Null)).await.unwrap();
        relay.retire(id, "test_close").await;
        tokio::task::yield_now().await;
        assert_eq!(tx.strong_count(), 3);
        relay.close().await;
        // The two stream pumps and deferred close must all observe cancellation.
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
        assert_eq!(tx.strong_count(), 2);
        assert_eq!(rx.recv().await.unwrap().kind, 9);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn binary_frames_reject_flags_lengths_and_versions() {
        let frame = Frame::json(2, 17, 19, &json!({"port":8100}));
        let bytes = frame.encode();
        let decoded = Frame::decode(&bytes).unwrap();
        assert_eq!(decoded.request_id, 17);
        assert_eq!(decoded.stream_id, 19);
        assert_eq!(&bytes[4..8], &17u32.to_be_bytes());
        for index in [0, 2, 3, 15] {
            let mut bad = bytes.clone();
            bad[index] ^= 1;
            assert!(Frame::decode(&bad).is_err());
        }
        assert!(Frame::decode(&bytes[..15]).is_err());
    }

    #[tokio::test]
    async fn stream_pumps_bytes_and_bounds_usb_payloads() {
        let (tx, mut rx) = mpsc::channel(8);
        let relay = Relay::new(tx, CancellationToken::new(), "fixture".into());
        let opening = tokio::spawn({
            let relay = relay.clone();
            async move { relay.open(8100).await }
        });
        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.kind, 2);
        relay.handle(Frame::json(3, frame.stream_id, frame.stream_id, &json!({"ok":true}))).await.unwrap();
        let mut stream = opening.await.unwrap().unwrap();
        relay
            .handle(Frame { kind: 4, request_id: 0, stream_id: frame.stream_id, payload: b"phone".to_vec() })
            .await
            .unwrap();
        let mut word = [0; 5];
        stream.read_exact(&mut word).await.unwrap();
        assert_eq!(&word, b"phone");
        let data = vec![31; 140_000];
        let writer = tokio::spawn(async move {
            stream.write_all(&data).await.unwrap();
            stream
        });
        let mut received = 0;
        while received < 140_000 {
            let frame = rx.recv().await.unwrap();
            assert_eq!(frame.kind, 4);
            assert!(frame.payload.len() <= MAX_USB_DATA);
            received += frame.payload.len();
        }
        drop(writer.await.unwrap());
        relay.close().await;
    }

    #[tokio::test]
    async fn rejects_unopened_and_unknown_streams_and_closes_waiters() {
        let (tx, mut rx) = mpsc::channel(8);
        let relay = Relay::new(tx, CancellationToken::new(), "fixture".into());
        let opening = tokio::spawn({
            let relay = relay.clone();
            async move { relay.open(8100).await }
        });
        let frame = rx.recv().await.unwrap();
        assert!(
            relay.handle(Frame { kind: 4, request_id: 0, stream_id: frame.stream_id, payload: vec![] }).await.is_err()
        );
        assert!(relay.handle(Frame { kind: 5, request_id: 0, stream_id: 100, payload: vec![] }).await.is_err());
        relay.close().await;
        assert!(opening.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn overflowing_stream_closes_without_disconnecting_other_streams() {
        for chunk_size in [MAX_USB_DATA, 1] {
            let (tx, mut rx) = mpsc::channel(8);
            let cancel = CancellationToken::new();
            let relay = Relay::new(tx, cancel.clone(), "fixture".into());
            let mut sockets = Vec::new();
            let mut ids = Vec::new();
            for port in [9100, 8100] {
                let opening = tokio::spawn({
                    let relay = relay.clone();
                    async move { relay.open(port).await }
                });
                let frame = rx.recv().await.unwrap();
                ids.push(frame.stream_id);
                relay.handle(Frame::json(3, frame.stream_id, frame.stream_id, &json!({"ok":true}))).await.unwrap();
                sockets.push(opening.await.unwrap().unwrap());
            }
            let control = sockets.pop().unwrap();
            let mut stalled = sockets.pop().unwrap();
            // Fill the duplex first, leaving its inbound writer blocked.
            for _ in 0..2 {
                relay
                    .handle(Frame { kind: 4, request_id: 0, stream_id: ids[0], payload: vec![0; MAX_USB_DATA] })
                    .await
                    .unwrap();
            }
            tokio::task::yield_now().await;
            for _ in 0..300 {
                relay
                    .handle(Frame { kind: 4, request_id: 0, stream_id: ids[0], payload: vec![0; chunk_size] })
                    .await
                    .expect("one overflowing stream must not become a session protocol error");
            }
            assert!(!cancel.is_cancelled());
            assert!(!relay.0.streams.lock().await.entries.contains_key(&ids[0]));
            let closed = rx.recv().await.unwrap();
            assert_eq!((closed.kind, closed.stream_id), (5, ids[0]));
            assert!(rx.try_recv().is_err(), "stream close must be sent once");
            relay
                .handle(Frame { kind: 4, request_id: 0, stream_id: ids[1], payload: b"alive".to_vec() })
                .await
                .unwrap();
            let mut control = control;
            let mut word = [0; 5];
            tokio::time::timeout(Duration::from_secs(1), control.read_exact(&mut word)).await.unwrap().unwrap();
            assert_eq!(&word, b"alive");
            let mut buffered = Vec::new();
            tokio::time::timeout(Duration::from_secs(1), stalled.read_to_end(&mut buffered)).await.unwrap().unwrap();
            assert!(buffered.len() <= STREAM_BUFFER);
            relay.close().await;
        }
    }
}
