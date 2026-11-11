//! Retain the device PID from the pinned idevice launcher without dumping its
//! debug messages, launch environment, XCTest activities or phone log payloads.
use std::fmt::{self, Write};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{
    EnvFilter,
    fmt::{FmtContext, FormatEvent, FormatFields, format::Writer},
    registry::LookupSpan,
};

const PHONE_TARGET: &str = "idevice::services::dvt::xctest";

pub(crate) fn with_phone_launch(filter: EnvFilter) -> EnvFilter {
    filter.add_directive(format!("{PHONE_TARGET}=debug").parse().expect("fixed phone log directive"))
}

#[derive(Default)]
struct Message {
    value: String,
    truncated: bool,
}
impl fmt::Write for Message {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.value.len() + value.len() > 512 {
            self.truncated = true;
            return Err(fmt::Error);
        }
        self.value.push_str(value);
        Ok(())
    }
}
impl Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self, "{value:?}");
        }
    }
}

fn launched_pid(message: &Message) -> Option<u32> {
    if message.truncated {
        return None;
    }
    message.value.strip_prefix("Launched test runner pid=")?.parse().ok().filter(|pid| *pid > 0)
}

pub(crate) struct PhoneEvents;
impl<S, N> FormatEvent<S, N> for PhoneEvents
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(&self, ctx: &FmtContext<'_, S, N>, mut writer: Writer<'_>, event: &Event<'_>) -> fmt::Result {
        let level = *event.metadata().level();
        if event.metadata().target().starts_with(PHONE_TARGET)
            && level != tracing::Level::WARN
            && level != tracing::Level::ERROR
        {
            let mut message = Message::default();
            event.record(&mut message);
            let Some(phone_pid) = launched_pid(&message) else {
                return Ok(());
            };
            use tracing_subscriber::fmt::time::FormatTime;
            tracing_subscriber::fmt::time::SystemTime.format_time(&mut writer)?;
            write!(
                writer,
                " INFO phone_lifecycle: event=phone_process_launched native_pid={} phone_pid={phone_pid}",
                std::process::id()
            )?;
            if let Some(scope) = ctx.event_scope() {
                for span in scope.from_root() {
                    if span.metadata().name() == "xctest_runner"
                        && let Some(fields) = span.extensions().get::<tracing_subscriber::fmt::FormattedFields<N>>()
                    {
                        write!(writer, " {fields}")?;
                    }
                }
            }
            return writeln!(writer);
        }
        tracing_subscriber::fmt::format().format_event(ctx, writer, event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

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
            .with_env_filter(with_phone_launch(EnvFilter::new("info,ictl_wda::runner=info,idevice=warn")))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("xctest_runner", runner_id = 42);
            let _entered = span.enter();
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
        assert!(text.contains("event=phone_process_launched"), "{text}");
        assert!(text.contains("phone_pid=1234") && text.contains("runner_id=42"), "{text}");
        assert!(text.contains("ordinary_server_event"));
        assert!(text.contains("existing_device_warning"));
        assert!(!text.contains("PRIVATE") && !text.contains("XXXXX"), "{text}");
        assert_eq!(text.matches("phone_process_launched").count(), 1);
    }
}
