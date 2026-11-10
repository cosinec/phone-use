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
    pub async fn setup_input(&self, input: &str) -> anyhow::Result<()> {
        match self {
            Self::Ios(c) => c.setup_input(input).await,
            Self::Android(_) => {
                anyhow::bail!("Android uses the on-device USB debugging authorization; no Apple account is needed")
            }
        }
    }
}
