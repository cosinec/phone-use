use crate::error::{ApiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Event {
    #[default]
    Sample,
    Stop,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Stream {
    stream_id: u32,
    port: u16,
    read_queued_bytes: u64,
    read_retained_bytes: u64,
    receive_window_bytes: u64,
    write_queued_bytes: u64,
    peer_window_bytes: u64,
    read_queued_frames: u64,
    send_seq: u32,
    peer_ack: u32,
    in_flight_bytes: u64,
    available_window_bytes: u64,
    write_waiters: u64,
    ack_pending: u8,
    window_blocked: u8,
    window_blocked_ms: u64,
    peer_ack_unchanged_ms: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Metrics {
    schema: u8,
    event: Event,
    sequence: u64,
    browser_time_ms: u64,
    elapsed_ms: u64,
    ws_sent_bytes: u64,
    ws_sent_frames: u64,
    ws_max_buffered_bytes: u64,
    ws_buffered_bytes: u64,
    uplink_waiters: u64,
    uplink_wait_count: u64,
    uplink_wait_max_ms: u64,
    preview_pauses: u64,
    preview_cooldown_ms: u64,
    usb_read_bytes: u64,
    usb_write_bytes: u64,
    usb_read_calls: u64,
    usb_write_calls: u64,
    usb_read_errors: u64,
    usb_write_errors: u64,
    usb_read_max_ms: u64,
    usb_write_max_ms: u64,
    usb_read_pending: u64,
    usb_write_pending: u64,
    usb_read_pending_ms: u64,
    usb_write_pending_ms: u64,
    usb_read_hooked: u8,
    usb_write_hooked: u8,
    ws_hooked: u8,
    skipped_samples: u64,
    upload_errors: u64,
    pending_mux_writes: u64,
    usb_session_closed: u8,
    ws_ready_state: u8,
    streams: Vec<Stream>,
}

pub(crate) fn record(session: &str, input: Value) -> Result<()> {
    let metrics: Metrics =
        serde_json::from_value(input).map_err(|_| ApiError::new(400, "Invalid transport diagnostics"))?;
    if metrics.schema != 1 || metrics.streams.len() > 64 {
        return Err(ApiError::new(400, "Invalid transport diagnostics"));
    }
    eprintln!(
        "{} event=browser_transport session={session} metrics={}",
        chrono::Utc::now().to_rfc3339(),
        serde_json::to_string(&metrics).expect("numeric metrics serialize")
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_numeric_metrics_and_refuses_payload_fields() {
        assert!(
            record(
                "fixture",
                json!({"schema":1,"event":"sample","wsBufferedBytes":1024,
            "usbSessionClosed":0,"wsReadyState":1,
            "streams":[{"streamId":7,"port":9100,"readQueuedBytes":128,
            "sendSeq":32,"peerAck":4294967280u32,"inFlightBytes":48,"availableWindowBytes":0,
            "windowBlocked":1,"windowBlockedMs":1500,"peerAckUnchangedMs":1500,
            "writeWaiters":1,"ackPending":1,"readQueuedFrames":2}]})
            )
            .is_ok()
        );
        for input in [
            json!({"schema":2}),
            json!({"schema":1,"token":"private"}),
            json!({"schema":1,"wsBufferedBytes":"private"}),
            json!({"schema":1,"event":"private"}),
            json!({"schema":1,"streams":[{"payload":"private"}]}),
            json!({"schema":1,"streams":vec![json!({});65]}),
        ] {
            let error = record("fixture", input).unwrap_err();
            assert!(!error.to_string().contains("private"));
        }
    }
}
