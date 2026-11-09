use crate::{
    commands::command_request,
    error::{ApiError, Result},
};
use base64::Engine;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Model {
    client: reqwest::Client,
    endpoint: Option<reqwest::Url>,
    pub name: Option<String>,
    key: String,
}
impl Model {
    pub fn new(env: &HashMap<String, String>) -> anyhow::Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let get = |k: &str| env.get(k).cloned().unwrap_or_default().trim().to_owned();
        let base = get("LLM_BASE_URL");
        let name = get("LLM_MODEL");
        let key = get("LLM_API_KEY");
        let ready = !base.is_empty() && !name.is_empty() && !key.is_empty();
        let endpoint = if ready {
            let url = reqwest::Url::parse(&(base.trim_end_matches('/').to_owned() + "/chat/completions"))?;
            anyhow::ensure!(
                ["http", "https"].contains(&url.scheme())
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && name.len() <= 128
                    && !name.contains(['\r', '\n', '\0'])
                    && !key.contains(['\r', '\n', '\0']),
                "Invalid model configuration"
            );
            Some(url)
        } else {
            None
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self { client, endpoint, name: ready.then_some(name), key })
    }
    pub fn ready(&self) -> bool {
        self.endpoint.is_some()
    }
    pub async fn generate(
        &self,
        instruction: &str,
        observation: Value,
        history: Vec<Value>,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let endpoint = self.endpoint.clone().ok_or_else(|| ApiError::unavailable("AI is not configured"))?;
        let mut content = vec![
            json!({"type":"text","text":json!({"instruction":instruction,"recentHistory":history,"observation":{
            "caption":truncate(observation["caption"].as_str().unwrap_or(""),1000),"elementsText":truncate(observation["elementsText"].as_str().unwrap_or(""),16384),
            "elementsError":observation.get("elementsError").map(|_|"UI elements unavailable")}}).to_string()}),
        ];
        if let Some(image) = observation["imageBase64"].as_str() {
            if image.len() > 8 * 1024 * 1024
                || base64::engine::general_purpose::STANDARD.decode(image).map_or(true, |b| b.len() > 6 * 1024 * 1024)
            {
                return Err(ApiError::unavailable("Phone image exceeds model limit"));
            }
            content.push(json!({"type":"image_url","image_url":{"url":format!("data:image/jpeg;base64,{image}")}}));
        }
        let operation = async {
            let payload = json!({
                "model": self.name,
                "messages": [
                    {"role": "system", "content": include_str!("model-prompt.txt")},
                    {"role": "user", "content": content}
                ],
                "temperature": 0,
                "max_tokens": 1024
            });
            let mut response = self
                .client
                .post(endpoint)
                .bearer_auth(&self.key)
                .json(&payload)
                .send()
                .await
                .map_err(|_| ApiError::unavailable("Model provider request failed"))?;
            if !response.status().is_success() {
                return Err(ApiError::unavailable("Model provider request failed"));
            }
            if response.content_length().is_some_and(|n| n > 65536) {
                return Err(ApiError::unavailable("Model response too large"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) =
                response.chunk().await.map_err(|_| ApiError::unavailable("Model provider request failed"))?
            {
                if bytes.len() + chunk.len() > 65536 {
                    return Err(ApiError::unavailable("Model response too large"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let parse = || -> Option<Value> {
                let envelope: Value = serde_json::from_slice(&bytes).ok()?;
                serde_json::from_str(envelope["choices"][0]["message"]["content"].as_str()?).ok()
            };
            validate_reply(parse().ok_or_else(|| ApiError::unavailable("Invalid model JSON response"))?)
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(ApiError::unavailable("Model request cancelled")),
            result = tokio::time::timeout(Duration::from_secs(60), operation) => {
                result.unwrap_or_else(|_| Err(ApiError::unavailable("Model request timed out")))
            }
        }
    }
}
fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}
pub fn validate_reply(mut value: Value) -> Result<Value> {
    let invalid = || ApiError::unavailable("Invalid model reply");
    let obj = value.as_object().ok_or_else(invalid)?;
    if obj.get("type").and_then(Value::as_str) == Some("done") {
        if obj.keys().any(|k| !["type", "message"].contains(&k.as_str())) || !valid_string(&value["message"], 4000) {
            return Err(invalid());
        }
        return Ok(value);
    }
    if value["type"] != "action"
        || obj.keys().any(|k| !["type", "tool", "args", "reason", "requiresConfirmation"].contains(&k.as_str()))
        || !valid_string(&value["reason"], 2000)
        || value.get("requiresConfirmation").is_some_and(|v| !v.is_boolean())
    {
        return Err(invalid());
    }
    let tool = value["tool"].as_str().ok_or_else(invalid)?;
    let args = value.get("args").cloned().unwrap_or(json!({}));
    let args_obj = args.as_object().ok_or_else(invalid)?;
    if args_obj.values().any(|v| !v.is_string() && !v.is_boolean() && !v.is_number()) {
        return Err(invalid());
    }
    command_request(tool, &args).map_err(|_| invalid())?;
    value["args"] = args;
    if value.get("requiresConfirmation").is_none() {
        value["requiresConfirmation"] = json!(false);
    }
    Ok(value)
}
fn valid_string(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= max)
}
