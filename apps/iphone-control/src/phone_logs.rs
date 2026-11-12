//! Keep typed runner diagnostics while suppressing arbitrary device messages.
use std::fmt;
use tracing::{Event, Subscriber};
use tracing_subscriber::{
    fmt::{FmtContext, FormatEvent, FormatFields, format::Writer},
    registry::LookupSpan,
};
const PHONE_TARGET: &str = "idevice::services::dvt::xctest";
pub(crate) struct PhoneEvents;
impl<S, N> FormatEvent<S, N> for PhoneEvents
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(&self, ctx: &FmtContext<'_, S, N>, writer: Writer<'_>, event: &Event<'_>) -> fmt::Result {
        let level = *event.metadata().level();
        if event.metadata().target().starts_with(PHONE_TARGET)
            && level != tracing::Level::WARN
            && level != tracing::Level::ERROR
        {
            return Ok(());
        }
        tracing_subscriber::fmt::format().format_event(ctx, writer, event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::EnvFilter;

    #[derive(Clone, Default)]
    struct Output(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Output {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Output {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn production_filter_persists_phone_pid_and_drops_all_other_device_debug_payloads() {
        let output = Output::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(output.clone())
            .event_format(PhoneEvents)
            .with_env_filter(EnvFilter::new("info,ictl_wda::runner=info,idevice=warn"))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("xctest_runner", runner_id = 42);
            let _entered = span.enter();
            tracing::info!(target: "ictl_wda::diagnostics", event="phone_process_launched",phone_pid=1234u64,runner_id=42u64,native_start_id="fixture-generation");
            tracing::debug!(target: "idevice::services::dvt::xctest", "Launched test runner pid={}", 1234);
            tracing::debug!(target: "idevice::services::dvt::xctest", "PRIVATE_LAUNCH_ENV_AND_TYPED_PASSWORD");
            tracing::debug!(target: "idevice::services::dvt::xctest", "Launched test runner pid=1234 PRIVATE_TRAILING_DATA");
            tracing::debug!(target: "idevice::services::dvt::xctest", "{}", "X".repeat(10000));
            tracing::debug!(target: "idevice::services::dvt::xctest::child", "PRIVATE_CHILD_PAYLOAD");
            tracing::info!(target: "idevice::services::dvt::xctest", "PRIVATE_INFO_PAYLOAD");
            tracing::warn!(target: "idevice::services::dvt::xctest", "existing_device_warning");
            tracing::info!(event = "ordinary_server_event");
        });
        let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
        assert!(text.contains("phone_process_launched"), "{text}");
        assert!(
            text.contains("phone_pid=1234") && text.contains("runner_id=42") && text.contains("fixture-generation"),
            "{text}"
        );
        assert!(text.contains("ordinary_server_event"));
        assert!(text.contains("existing_device_warning"));
        assert!(!text.contains("PRIVATE") && !text.contains("XXXXX"), "{text}");
        assert_eq!(text.matches("phone_process_launched").count(), 1);
    }
}
