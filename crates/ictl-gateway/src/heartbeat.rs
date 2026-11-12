//! WebSocket writer with connection heartbeats.
use crate::relay::Frame;
use axum::extract::ws::Message;
use futures_util::{Sink, SinkExt};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub(crate) struct CloseReason(Arc<std::sync::Mutex<Option<&'static str>>>);
impl CloseReason {
    pub fn record(&self, reason: &'static str) {
        let mut first = self.0.lock().unwrap();
        if first.is_none() || matches!(*first, Some("cancel" | "unattributed")) {
            *first = Some(reason);
        }
    }
    pub fn get(&self) -> &'static str {
        self.0.lock().unwrap().unwrap_or("unattributed")
    }
}

pub(crate) async fn write_frames<S: Sink<Message> + Unpin>(
    mut sink: S,
    mut frames: mpsc::Receiver<Frame>,
    writer_alive: Arc<AtomicBool>,
    cancel: CancellationToken,
    session_id: String,
    close_reason: CloseReason,
) {
    // Schedule from actual send completion, never from an interval's old ticks.
    // The timer precedes queued data so continuous traffic cannot starve Ping.
    let mut next_ping = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let message = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep_until(next_ping) => {
                if !writer_alive.swap(false, Ordering::SeqCst) {
                    eprintln!("{} event=ws_writer_closed session={session_id} reason=heartbeat_pong_missing", chrono::Utc::now().to_rfc3339());
                    close_reason.record("heartbeat_pong_missing");
                    cancel.cancel();
                    break;
                }
                Message::Ping(Vec::new().into())
            },
            frame = frames.recv() => match frame {
                Some(frame) => Message::Binary(frame.encode().into()),
                None => { close_reason.record("writer_channel_closed"); break; },
            },
        };
        let is_ping = matches!(message, Message::Ping(_));
        let sent = tokio::select! {
            _ = cancel.cancelled() => break,
            result = tokio::time::timeout(Duration::from_secs(20), sink.send(message)) => result,
        };
        if !matches!(sent, Ok(Ok(()))) {
            let cause = if sent.is_err() { "send_timeout" } else { "socket_send_failed" };
            close_reason.record(cause);
            eprintln!(
                "{} event=ws_writer_closed session={session_id} reason={cause:?}",
                chrono::Utc::now().to_rfc3339()
            );
            cancel.cancel();
            break;
        }
        if is_ping {
            next_ping = tokio::time::Instant::now() + Duration::from_secs(30);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::time::{Instant, Sleep};

    #[test]
    fn first_known_close_reason_survives_later_cancellation() {
        let reason = CloseReason::default();
        reason.record("browser_close");
        reason.record("cancel");
        reason.record("socket_send_failed");
        assert_eq!(reason.get(), "browser_close");
    }

    struct Peer {
        messages: mpsc::UnboundedSender<Message>,
        delay: Option<Pin<Box<Sleep>>>,
    }
    impl Sink<Message> for Peer {
        type Error = std::io::Error;
        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn start_send(mut self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
            if matches!(message, Message::Binary(_)) {
                self.delay = Some(Box::pin(tokio::time::sleep(Duration::from_secs(1))));
            }
            self.messages.send(message).map_err(|_| std::io::ErrorKind::BrokenPipe.into())
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            if let Some(delay) = self.delay.as_mut() {
                std::task::ready!(delay.as_mut().poll(cx));
                self.delay = None;
            }
            Poll::Ready(Ok(()))
        }
        fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            self.poll_flush(cx)
        }
    }
    fn start() -> (
        mpsc::Sender<Frame>,
        mpsc::UnboundedReceiver<Message>,
        Arc<AtomicBool>,
        CancellationToken,
        tokio::task::JoinHandle<()>,
    ) {
        let (frames, receiver) = mpsc::channel(128);
        let (messages, peer) = mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let cancel = CancellationToken::new();
        let task = tokio::spawn(write_frames(
            Peer { messages, delay: None },
            receiver,
            alive.clone(),
            cancel.clone(),
            "fixture".into(),
            CloseReason::default(),
        ));
        (frames, peer, alive, cancel, task)
    }
    fn frame() -> Frame {
        Frame { kind: 4, request_id: 0, stream_id: 1, payload: vec![1] }
    }

    #[tokio::test(start_paused = true)]
    async fn busy_data_does_not_starve_pings_or_disconnect_a_responsive_peer() {
        let (frames, mut peer, alive, cancel, task) = start();
        for _ in 0..65 {
            frames.send(frame()).await.unwrap();
        }
        let began = Instant::now();
        let mut first_ping = None;
        while began.elapsed() < Duration::from_secs(70) {
            let message = peer.recv().await.expect("healthy writer must stay connected");
            if matches!(message, Message::Ping(_)) {
                first_ping.get_or_insert(began.elapsed());
                // A healthy remote Pong still needs time to cross the network.
                tokio::time::sleep(Duration::from_millis(10)).await;
                alive.store(true, Ordering::SeqCst);
            }
            assert!(!cancel.is_cancelled(), "writer must allow time for the Pong");
        }
        assert!(first_ping.unwrap() <= Duration::from_secs(31), "queued data must not starve heartbeat");
        cancel.cancel();
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_scheduler_starts_pong_deadline_when_ping_is_sent() {
        let (_frames, mut peer, alive, cancel, task) = start();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(65)).await;
        assert!(matches!(peer.recv().await, Some(Message::Ping(_))));
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!cancel.is_cancelled(), "missed ticks must not expire a just-sent Ping");
        alive.store(true, Ordering::SeqCst);
        cancel.cancel();
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn missing_pong_still_closes_the_session() {
        let (_frames, mut peer, _alive, cancel, task) = start();
        assert!(matches!(peer.recv().await, Some(Message::Ping(_))));
        let sent = Instant::now();
        task.await.unwrap();
        assert!(cancel.is_cancelled());
        assert_eq!(sent.elapsed(), Duration::from_secs(30));
    }
}
