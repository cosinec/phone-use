//! Session admission authority. Task authority is typed and never deserialized from browser input.
use crate::error::{ApiError, Result};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub(crate) struct Control(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    manual: usize,
    owner: Option<u64>,
    next: u64,
    closed: bool,
}

pub(crate) struct ManualPermit(Control);
#[derive(Clone)]
pub(crate) struct TaskLease(Arc<TaskOwner>);
struct TaskOwner {
    id: u64,
    control: Control,
    cancel: CancellationToken,
}
pub(crate) enum Admission {
    Manual(ManualPermit),
    Task(TaskLease),
}
impl Control {
    pub(crate) fn manual(&self) -> Result<Admission> {
        let mut state = self.0.lock().unwrap();
        if state.closed {
            return Err(ApiError::new(410, "Session closed"));
        }
        if state.owner.is_some() {
            return Err(ApiError::new(409, "Task owns session control; stop the task first"));
        }
        state.manual =
            state.manual.checked_add(1).ok_or_else(|| ApiError::new(429, "Control admission limit reached"))?;
        Ok(Admission::Manual(ManualPermit(self.clone())))
    }
    pub(crate) fn task(&self) -> Result<TaskLease> {
        let mut state = self.0.lock().unwrap();
        if state.closed {
            return Err(ApiError::new(410, "Session closed"));
        }
        if state.owner.is_some() || state.manual > 0 {
            return Err(ApiError::new(409, "Session control is busy; wait for pending commands or stop the task"));
        }
        state.next = state.next.checked_add(1).ok_or_else(|| ApiError::new(429, "Control generation limit reached"))?;
        let id = state.next;
        state.owner = Some(id);
        Ok(TaskLease(Arc::new(TaskOwner { id, control: self.clone(), cancel: CancellationToken::new() })))
    }
    pub(crate) fn task_job(&self, lease: &TaskLease) -> Result<Admission> {
        if !lease.valid(self) {
            return Err(ApiError::new(409, "Task control lease is cancelled or stale"));
        }
        Ok(Admission::Task(lease.clone()))
    }
    pub(crate) fn task_owned(&self) -> bool {
        self.0.lock().unwrap().owner.is_some()
    }
    pub(crate) fn close(&self) {
        self.0.lock().unwrap().closed = true;
    }
}
impl Drop for ManualPermit {
    fn drop(&mut self) {
        let mut state = self.0.0.lock().unwrap();
        state.manual -= 1;
    }
}
impl Drop for TaskOwner {
    fn drop(&mut self) {
        let mut state = self.control.0.lock().unwrap();
        if state.owner == Some(self.id) {
            state.owner = None;
        }
    }
}
impl TaskLease {
    pub(crate) fn cancel(&self) {
        self.0.cancel.cancel();
    }
    fn valid(&self, control: &Control) -> bool {
        if !Arc::ptr_eq(&self.0.control.0, &control.0) || self.0.cancel.is_cancelled() {
            return false;
        }
        let state = control.0.lock().unwrap();
        !state.closed && state.owner == Some(self.0.id)
    }
}
impl Admission {
    pub(crate) fn valid(&self, control: &Control) -> bool {
        match self {
            Self::Task(lease) => lease.valid(control),
            Self::Manual(permit) => Arc::ptr_eq(&permit.0.0, &control.0) && !control.0.lock().unwrap().closed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_manual_and_task_admission_are_exclusive() {
        let control = Control::default();
        let manual = control.manual().unwrap();
        assert!(control.task().is_err(), "a queued manual job must prevent task claim");
        drop(manual);
        let task = control.task().unwrap();
        assert!(control.manual().is_err(), "task owns the entire model/confirmation interval");
        assert!(control.task_job(&task).unwrap().valid(&control));
        drop(task);
        assert!(control.manual().is_ok());
    }
    #[test]
    fn cancelled_task_jobs_hold_ownership_until_dropped_but_cannot_dispatch() {
        let control = Control::default();
        let task = control.task().unwrap();
        let job = control.task_job(&task).unwrap();
        task.cancel();
        assert!(!job.valid(&control));
        assert!(control.task_job(&task).is_err());
        drop(task);
        assert!(control.manual().is_err(), "cancelled queued/inflight job still owns session");
        assert!(control.task().is_err());
        drop(job);
        assert!(control.task().is_ok());
    }
    #[test]
    fn racing_manual_and_task_claim_admit_exactly_one_owner() {
        for _ in 0..16 {
            let control = Control::default();
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let c = control.clone();
            let b = barrier.clone();
            let manual = std::thread::spawn(move || {
                b.wait();
                let result = c.manual();
                b.wait();
                result
            });
            let task = std::thread::spawn(move || {
                barrier.wait();
                let result = control.task();
                barrier.wait();
                result
            });
            let manual = manual.join().unwrap();
            let task = task.join().unwrap();
            assert!(manual.is_ok() ^ task.is_ok(), "both claims cannot be admitted together");
        }
    }
    #[test]
    fn foreign_task_lease_and_closed_session_never_admit_jobs() {
        let first = Control::default();
        let other = Control::default();
        let task = first.task().unwrap();
        assert!(other.task_job(&task).is_err());
        let job = first.task_job(&task).unwrap();
        first.close();
        assert!(!job.valid(&first));
        assert!(first.manual().is_err());
        assert!(first.task().is_err());
    }
}
