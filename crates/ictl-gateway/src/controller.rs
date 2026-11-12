use crate::{android::AndroidController, native::NativeController};
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub enum Controller {
    Ios(NativeController),
    Android(AndroidController),
}
impl Controller {
    pub async fn request(&self, request: Value, timeout: Duration, cancel: CancellationToken) -> anyhow::Result<Value> {
        match self {
            Self::Ios(c) => c.request(request, timeout, cancel).await,
            Self::Android(c) => c.request(request, timeout, cancel).await,
        }
    }
    pub async fn request_with_deadline(
        &self,
        request: Value,
        timeout: Duration,
        cancel: CancellationToken,
        deadline: Option<ictl_protocol::ActionDeadline>,
    ) -> anyhow::Result<Value> {
        if deadline.is_some_and(|d| d.expired().unwrap_or(true)) {
            anyhow::bail!("Action expired before dispatch; request was not sent");
        }
        match self {
            Self::Ios(c) => c.request_with_deadline(request, timeout, cancel, deadline).await,
            Self::Android(c) => c.request(request, timeout, cancel).await,
        }
    }
    pub async fn snapshot(&self) -> Value {
        match self {
            Self::Ios(c) => c.snapshot().await,
            Self::Android(c) => c.snapshot(),
        }
    }
    pub async fn close(&self) -> anyhow::Result<()> {
        match self {
            Self::Ios(c) => c.close().await,
            Self::Android(c) => {
                c.close().await;
                Ok(())
            }
        }
    }
    pub async fn start_setup(&self) -> anyhow::Result<()> {
        match self {
            Self::Ios(c) => c.start_setup().await,
            Self::Android(_) => Ok(()),
        }
    }
    pub(crate) async fn start_setup_admitted(
        &self,
        admission: crate::control::Admission,
        deadline: ictl_protocol::ActionDeadline,
    ) -> anyhow::Result<()> {
        match self {
            Self::Ios(c) => c.start_setup_admitted(admission, deadline).await,
            Self::Android(_) => Ok(()),
        }
    }
    pub(crate) async fn setup_input_with_deadline(
        &self,
        input: &str,
        deadline: ictl_protocol::ActionDeadline,
    ) -> anyhow::Result<()> {
        match self {
            Self::Ios(c) => c.setup_input_with_deadline(input, Some(deadline)).await,
            Self::Android(_) => {
                anyhow::bail!("Android uses the on-device USB debugging authorization; no Apple account is needed")
            }
        }
    }
    pub async fn setup_input(&self, input: &str) -> anyhow::Result<()> {
        match self {
            Self::Ios(c) => c.setup_input(input).await,
            Self::Android(_) => {
                anyhow::bail!("Android uses the on-device USB debugging authorization; no Apple account is needed")
            }
        }
    }
}
