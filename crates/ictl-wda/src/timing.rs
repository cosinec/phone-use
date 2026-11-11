//! Metadata-only step timings, including futures dropped by cancellation.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static NEXT_STEP: AtomicU64 = AtomicU64::new(1);

pub struct StepTimer {
    id: u64,
    step: &'static str,
    started: Instant,
    outcome: &'static str,
    span: tracing::Span,
    dispatch: tracing::Dispatch,
}

impl StepTimer {
    pub fn new(step: &'static str) -> Self {
        let timer = Self {
            id: NEXT_STEP.fetch_add(1, Ordering::Relaxed),
            step,
            started: Instant::now(),
            outcome: "interrupted",
            span: tracing::Span::current(),
            dispatch: tracing::dispatcher::get_default(Clone::clone),
        };
        tracing::info!(event = "step_started", step_id = timer.id, step);
        timer
    }

    pub fn finish(mut self, success: bool) {
        self.outcome = if success { "ok" } else { "error" };
    }
}

impl Drop for StepTimer {
    fn drop(&mut self) {
        tracing::dispatcher::with_default(&self.dispatch, || {
            self.span.in_scope(|| {
                tracing::info!(
                    event = "step_finished",
                    step_id = self.id,
                    step = self.step,
                    elapsed_ms = self.started.elapsed().as_millis() as u64,
                    outcome = self.outcome
                );
            })
        });
    }
}
