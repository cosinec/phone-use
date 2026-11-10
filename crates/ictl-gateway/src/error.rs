use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}
impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(503, message)
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for ApiError {}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
            Json(json!({"error":self.message})),
        )
            .into_response();
        response.headers_mut().insert("cache-control", "no-store".parse().unwrap());
        response
    }
}
pub type Result<T> = std::result::Result<T, ApiError>;

pub(crate) fn recoverable_wda_error(message: &str) -> bool {
    [
        "WDA request timed out (",
        "WDA disconnected after the request was sent (",
        "WDA unavailable:",
        "WDA unavailable (",
        "WDA 请求超时（",
        "WDA 在请求发出后断开（",
        "WDA 不可用：",
        "WDA 不可用(",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
        || matches!(
            message,
            "Native request timeout; sent action is not retried"
                | "Native response interrupted; sent action is not retried"
                | "Device response unavailable; action result is uncertain"
                | "WDA observation unavailable"
        )
}

pub(crate) fn recoverable_observation_error(message: &str) -> bool {
    recoverable_wda_error(message) || matches!(message, "Observation unavailable" | "Screenshot unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_observations_are_retryable_without_loosening_action_errors() {
        assert!(recoverable_observation_error("Observation unavailable"));
        assert!(recoverable_observation_error("Screenshot unavailable"));
        assert!(!recoverable_wda_error("Observation unavailable"));
        assert!(!recoverable_observation_error("Invalid native observation identity or image"));
    }

    #[test]
    fn recovery_only_accepts_known_device_transport_errors() {
        for message in [
            "WDA request timed out (it was sent): WDA request timed out",
            "WDA disconnected after the request was sent (check screen): interrupted",
            "WDA unavailable (starting)",
            "WDA 请求超时（请截图确认）：timeout",
            "WDA 在请求发出后断开（请核对）：interrupted",
            "WDA 不可用(正在启动 WDA)",
            "Native response interrupted; sent action is not retried",
        ] {
            assert!(recoverable_wda_error(message), "{message}");
        }
        for message in [
            "Task cancelled",
            "Observation device identity mismatch",
            "Invalid x",
            "WDA invalid element",
            "Model request timed out",
            "Native operation failed; sent actions are not retried",
        ] {
            assert!(!recoverable_wda_error(message), "{message}");
        }
    }
}
