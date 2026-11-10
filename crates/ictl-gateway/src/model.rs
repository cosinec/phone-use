use crate::{
    commands::command_request,
    error::{ApiError, Result},
};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Model {
    client: reqwest::Client,
    endpoint: Option<reqwest::Url>,
    pub name: Option<String>,
    key: String,
    catalog: Arc<Mutex<Catalog>>,
}
#[derive(Default)]
struct Catalog {
    fetched: Option<Instant>,
    names: Vec<String>,
    failed: bool,
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
                    && valid_model_id(&name)
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
        Ok(Self { client, endpoint, name: ready.then_some(name), key, catalog: Arc::default() })
    }
    pub fn ready(&self) -> bool {
        self.endpoint.is_some()
    }
    async fn model_names(&self) -> (Vec<String>, bool) {
        let mut catalog = self.catalog.lock().await;
        let ttl = if catalog.failed { 15 } else { 60 };
        if catalog.fetched.is_none_or(|at| at.elapsed() >= Duration::from_secs(ttl)) {
            let fetch = async {
                let endpoint = self.endpoint.as_ref()?.as_str().strip_suffix("chat/completions")?;
                let mut response =
                    self.client.get(format!("{endpoint}models")).bearer_auth(&self.key).send().await.ok()?;
                if !response.status().is_success() || response.content_length().is_some_and(|n| n > 512 * 1024) {
                    return None;
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.ok()? {
                    if bytes.len() + chunk.len() > 512 * 1024 {
                        return None;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value: Value = serde_json::from_slice(&bytes).ok()?;
                let data = value["data"].as_array()?;
                if data.len() > 4096 {
                    return None;
                }
                let mut names: Vec<_> = data
                    .iter()
                    .filter_map(|v| v["id"].as_str())
                    .filter(|id| valid_model_id(id))
                    .map(str::to_owned)
                    .collect();
                names.sort();
                names.dedup();
                Some(names)
            };
            match tokio::time::timeout(Duration::from_secs(5), fetch).await {
                Ok(Some(names)) => {
                    catalog.names = names;
                    catalog.failed = false;
                }
                _ => catalog.failed = true,
            }
            catalog.fetched = Some(Instant::now());
        }
        let mut names = catalog.names.clone();
        if let Some(default) = &self.name
            && !names.contains(default)
        {
            names.insert(0, default.clone());
        }
        (names, catalog.failed)
    }
    pub async fn configuration(&self) -> Value {
        if !self.ready() {
            return json!({"aiReady":false,"model":null});
        }
        let (models, failed) = self.model_names().await;
        let mut config = json!({"aiReady":true,"model":self.name,"models":models});
        if failed {
            config["modelsError"] = json!("模型列表暂时无法更新，显示默认模型或上次列表。");
        }
        config
    }
    pub async fn select(&self, requested: Option<&Value>) -> Result<Self> {
        if !self.ready() {
            return Err(ApiError::unavailable("AI is not configured"));
        }
        let Some(requested) = requested else {
            return Ok(self.clone());
        };
        let name = requested
            .as_str()
            .filter(|s| valid_model_id(s))
            .ok_or_else(|| ApiError::new(400, "Invalid model selection"))?;
        if self.name.as_deref() != Some(name) && !self.model_names().await.0.iter().any(|s| s == name) {
            return Err(ApiError::new(400, "Model is unavailable; refresh the model list"));
        }
        let mut selected = self.clone();
        selected.name = Some(name.to_owned());
        Ok(selected)
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
            "queryOnly":observation["queryOnly"] == true,
            "elementsError":observation.get("elementsError").map(|_|"UI elements unavailable")}}).to_string()}),
        ];
        if let Some(image) = observation["imageBase64"].as_str() {
            content.push(image_content(image)?);
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
                return Err(ApiError::unavailable(format!(
                    "模型服务返回 HTTP {}，请检查所选模型的权限、额度和可用性。",
                    response.status().as_u16()
                )));
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
fn valid_model_id(name: &str) -> bool {
    !name.is_empty() && name.len() <= 256 && name.trim() == name && !name.chars().any(char::is_control)
}
fn image_content(image: &str) -> Result<Value> {
    if image.len() > 8 * 1024 * 1024
        || base64::engine::general_purpose::STANDARD.decode(image).map_or(true, |b| b.len() > 6 * 1024 * 1024)
    {
        return Err(ApiError::unavailable("Phone image exceeds model limit"));
    }
    Ok(json!({"type":"image_url","image_url":{"url":format!("data:image/jpeg;base64,{image}")}}))
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
