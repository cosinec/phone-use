//! Optional typed process evidence. Observers must do bounded synchronous work.
use crate::IdeviceError;
#[cfg(any(feature = "device_info", test))]
use std::time::Duration;
use std::{future::Future, sync::Arc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Running,
    NotRunning,
    Unknown,
}
#[derive(Debug, Clone, Copy)]
pub enum ProcessEvent {
    Launched {
        pid: u64,
    },
    Observed {
        pid: u64,
        state: ProcessState,
        category: &'static str,
        duration_ms: u64,
        monitoring: bool,
    },
}
pub trait ProcessObserver: Send + Sync {
    fn observe(&self, event: ProcessEvent);
}
pub(super) fn launched(observer: Option<&Arc<dyn ProcessObserver>>, pid: u64) {
    if let Some(observer) = observer {
        observer.observe(ProcessEvent::Launched { pid });
    }
}
#[cfg(any(feature = "device_info", test))]
pub(super) fn classify(result: &Result<bool, IdeviceError>) -> ProcessState {
    match result {
        Ok(true) => ProcessState::Running,
        Ok(false) => ProcessState::NotRunning,
        Err(_) => ProcessState::Unknown,
    }
}
pub(super) async fn with_monitor<T>(
    lifecycle: impl Future<Output = T>,
    monitor: impl Future<Output = ()>,
) -> T {
    tokio::pin!(lifecycle, monitor);
    tokio::select! { result = &mut lifecycle => result, () = &mut monitor => lifecycle.await }
}

pub(super) async fn monitor(
    connection: impl Future<
        Output = Result<super::RemoteServerClient<Box<dyn crate::ReadWrite>>, IdeviceError>,
    >,
    pid: u64,
    observer: &Arc<dyn ProcessObserver>,
) {
    #[cfg(feature = "device_info")]
    {
        // Setup and requests use a dedicated socket. Dropping it after an ambiguous
        // timeout retires queued replies AND any partially written DTX frame.
        let started = crate::time::Instant::now();
        let mut client = match crate::time::timeout(Duration::from_secs(5), connection).await {
            Ok(Ok(client)) => client,
            result => {
                let category = if result.is_err() {
                    "setup_timeout"
                } else {
                    "setup_failed"
                };
                observer.observe(ProcessEvent::Observed {
                    pid,
                    state: ProcessState::Unknown,
                    category,
                    duration_ms: started.elapsed().as_millis() as u64,
                    monitoring: false,
                });
                return;
            }
        };
        let remaining = Duration::from_secs(5).saturating_sub(started.elapsed());
        let mut info = match crate::time::timeout(
            remaining,
            crate::dvt::device_info::DeviceInfoClient::new(&mut client),
        )
        .await
        {
            Ok(Ok(info)) => info,
            result => {
                let category = if result.is_err() {
                    "channel_setup_timeout"
                } else {
                    "channel_setup_failed"
                };
                observer.observe(ProcessEvent::Observed {
                    pid,
                    state: ProcessState::Unknown,
                    category,
                    duration_ms: started.elapsed().as_millis() as u64,
                    monitoring: false,
                });
                return;
            }
        };
        let Ok(pid32) = u32::try_from(pid) else {
            observer.observe(ProcessEvent::Observed {
                pid,
                state: ProcessState::Unknown,
                category: "invalid_pid",
                duration_ms: 0,
                monitoring: false,
            });
            return;
        };
        loop {
            let started = crate::time::Instant::now();
            let result =
                crate::time::timeout(Duration::from_secs(5), info.is_running_pid(pid32)).await;
            let (state, category, monitoring) = match result {
                Ok(Ok(running)) => (classify(&Ok(running)), "deviceinfo_reply", true),
                Ok(Err(_)) => (ProcessState::Unknown, "request_failed", false),
                Err(_) => (ProcessState::Unknown, "request_timeout", false),
            };
            observer.observe(ProcessEvent::Observed {
                pid,
                state,
                category,
                duration_ms: started.elapsed().as_millis() as u64,
                monitoring,
            });
            if !monitoring {
                return;
            }
            // Delay from completion, so stalls cannot cause catch-up bursts.
            crate::time::sleep(Duration::from_secs(10)).await;
        }
    }
    #[cfg(not(feature = "device_info"))]
    {
        drop(connection);
        observer.observe(ProcessEvent::Observed {
            pid,
            state: ProcessState::Unknown,
            category: "feature_disabled",
            duration_ms: 0,
            monitoring: false,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Events(Mutex<Vec<ProcessEvent>>);
    impl ProcessObserver for Events {
        fn observe(&self, event: ProcessEvent) {
            self.0.lock().unwrap().push(event);
        }
    }
    #[cfg(feature = "device_info")]
    async fn dvt_peer(
        mut peer: tokio::io::DuplexStream,
        value: Option<plist::Value>,
        query: tokio::sync::oneshot::Sender<()>,
    ) {
        use crate::dvt::message::Message;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let setup = Message::from_reader(&mut peer).await.unwrap();
        peer.write_all(&Message::build_raw_reply(
            setup.message_header.channel,
            setup.message_header.identifier(),
            setup.message_header.conversation_index(),
            &[],
        ))
        .await
        .unwrap();
        let request = Message::from_reader(&mut peer).await.unwrap();
        assert_eq!(
            request.data.as_ref().and_then(|v| v.as_string()),
            Some("isRunningPid:")
        );
        if let Some(value) = value {
            let data = ns_keyed_archive::encode::encode_to_bytes(value).unwrap();
            peer.write_all(&Message::build_raw_reply(
                request.message_header.channel,
                request.message_header.identifier(),
                request.message_header.conversation_index(),
                &data,
            ))
            .await
            .unwrap();
        }
        let _ = query.send(());
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(6), peer.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0,
            "monitor connection must be released"
        );
    }
    #[cfg(feature = "device_info")]
    #[tokio::test]
    async fn real_channel_true_false_and_malformed_are_distinct() {
        for (reply, expected) in [
            (plist::Value::Boolean(true), ProcessState::Running),
            (plist::Value::Boolean(false), ProcessState::NotRunning),
            (plist::Value::String("false".into()), ProcessState::Unknown),
        ] {
            let (socket, peer) = tokio::io::duplex(4096);
            let (tx, rx) = tokio::sync::oneshot::channel();
            let peer = tokio::spawn(dvt_peer(peer, Some(reply), tx));
            let events = Arc::new(Events::default());
            let observer: Arc<dyn ProcessObserver> = events.clone();
            let client = super::super::RemoteServerClient::new(
                Box::new(socket) as Box<dyn crate::ReadWrite>
            );
            with_monitor(
                async {
                    rx.await.unwrap();
                    while events.0.lock().unwrap().is_empty() {
                        tokio::task::yield_now().await;
                    }
                },
                monitor(async { Ok(client) }, 1234, &observer),
            )
            .await;
            assert!(
                matches!(events.0.lock().unwrap().as_slice(),[ProcessEvent::Observed{state,..}] if *state==expected)
            );
            peer.await.unwrap();
        }
    }
    #[cfg(feature = "device_info")]
    #[tokio::test]
    async fn stalled_request_is_unknown_and_connection_is_retired() {
        let (socket, peer) = tokio::io::duplex(4096);
        let (tx, _rx) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(dvt_peer(peer, None, tx));
        let events = Arc::new(Events::default());
        let observer: Arc<dyn ProcessObserver> = events.clone();
        let client =
            super::super::RemoteServerClient::new(Box::new(socket) as Box<dyn crate::ReadWrite>);
        monitor(async { Ok(client) }, 1234, &observer).await;
        assert!(matches!(
            events.0.lock().unwrap().as_slice(),
            [ProcessEvent::Observed {
                state: ProcessState::Unknown,
                category: "request_timeout",
                monitoring: false,
                ..
            }]
        ));
        peer.await.unwrap();
    }
    #[cfg(feature = "device_info")]
    #[tokio::test]
    async fn callback_dispatch_continues_and_cancelling_owner_releases_socket() {
        let (socket, peer) = tokio::io::duplex(4096);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(dvt_peer(peer, None, tx));
        let events = Arc::new(Events::default());
        let observer: Arc<dyn ProcessObserver> = events;
        let client =
            super::super::RemoteServerClient::new(Box::new(socket) as Box<dyn crate::ReadWrite>);
        struct Listener(Arc<std::sync::atomic::AtomicBool>);
        impl super::super::listener::XCUITestListener for Listener {
            async fn did_begin_executing_test_plan(&mut self) -> Result<(), IdeviceError> {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
        }
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = called.clone();
        let task = tokio::spawn(async move {
            let mut listener = Listener(observed);
            let config = super::super::types::XCTestConfiguration {
                test_bundle_url: String::new(),
                session_identifier: uuid::Uuid::new_v4(),
                product_module_name: String::new(),
                automation_framework_path: String::new(),
                target_application_bundle_id: None,
                target_application_path: None,
                target_application_environment: None,
                target_application_arguments: vec![],
                tests_to_run: None,
                tests_to_skip: None,
                ide_capabilities: super::super::types::XCTCapabilities::empty(),
            };
            let lifecycle = async {
                rx.await.unwrap();
                super::super::dispatch_xct_message(
                    super::super::dtx_services::XCT_DID_BEGIN_TEST_PLAN,
                    &[],
                    &config,
                    &mut listener,
                    &mut false,
                )
                .await
                .unwrap();
                std::future::pending::<()>().await;
            };
            with_monitor(lifecycle, monitor(async { Ok(client) }, 1234, &observer)).await;
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !called.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        peer.await.unwrap();
    }
    #[cfg(feature = "device_info")]
    #[tokio::test]
    async fn connection_and_channel_setup_share_five_second_budget() {
        let (socket, mut peer) = tokio::io::duplex(4096);
        let events = Arc::new(Events::default());
        let observer: Arc<dyn ProcessObserver> = events;
        let client =
            super::super::RemoteServerClient::new(Box::new(socket) as Box<dyn crate::ReadWrite>);
        let started = tokio::time::Instant::now();
        let setup = async {
            tokio::time::sleep(Duration::from_secs(3)).await;
            Ok(client)
        };
        monitor(setup, 1234, &observer).await;
        assert!(
            started.elapsed() < Duration::from_millis(5500),
            "connection+channel setup exceeded five seconds: {:?}",
            started.elapsed()
        );
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes).await.unwrap();
    }
    #[cfg(not(feature = "device_info"))]
    #[tokio::test]
    async fn feature_disabled_is_unknown_without_polling_connection() {
        let events = Arc::new(Events::default());
        let observer: Arc<dyn ProcessObserver> = events.clone();
        monitor(
            async { panic!("disabled monitoring must not connect") },
            1234,
            &observer,
        )
        .await;
        assert!(matches!(
            events.0.lock().unwrap().as_slice(),
            [ProcessEvent::Observed {
                state: ProcessState::Unknown,
                category: "feature_disabled",
                monitoring: false,
                ..
            }]
        ));
    }
    #[test]
    fn launch_pid_is_typed_before_later_failure() {
        let events = Arc::new(Events::default());
        let observer: Arc<dyn ProcessObserver> = events.clone();
        launched(Some(&observer), 1234);
        assert!(matches!(
            events.0.lock().unwrap().as_slice(),
            [ProcessEvent::Launched { pid: 1234 }]
        ));
    }
    #[test]
    fn process_errors_are_unknown() {
        assert_eq!(classify(&Ok(true)), ProcessState::Running);
        assert_eq!(classify(&Ok(false)), ProcessState::NotRunning);
        assert_eq!(
            classify(&Err(IdeviceError::ServiceNotFound)),
            ProcessState::Unknown
        );
    }
    #[tokio::test]
    async fn pending_monitor_does_not_block_lifecycle_and_is_dropped() {
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let guard = Dropped(dropped.clone());
        let monitor = async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        };
        assert_eq!(
            tokio::time::timeout(
                Duration::from_millis(50),
                with_monitor(async { 7 }, monitor)
            )
            .await
            .unwrap(),
            7
        );
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }
}
