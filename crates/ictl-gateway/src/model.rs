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
            let mut messages = vec![
                json!({"role":"system","content":include_str!("model-prompt.txt")}),
                json!({"role":"user","content":content}),
            ];
            let choice = self.completion(&endpoint, &messages, 1024).await?;
            match decode_reply(&choice) {
                Ok(action) => Ok(action),
                Err(error) => {
                    eprintln!(
                        "Model reply rejected: model={} attempt=1 reason={error}",
                        self.name.as_deref().unwrap_or("")
                    );
                    // No device action has been dispatched. Re-plan once from the same
                    // observation, retaining the original task and confirmation rules.
                    messages.push(json!({"role":"user","content":format!(
                        "Your previous reply failed validation: {}. Return exactly one complete JSON action or done object using the original schema. Preserve the original task, safety and confirmation requirements. If you cannot proceed, return done with an explanation. Do not include markdown or extra text.",
                        error.message
                    )}));
                    let choice = self.completion(&endpoint, &messages, 2048).await?;
                    decode_reply(&choice).inspect_err(|error| {
                        eprintln!(
                            "Model reply rejected: model={} attempt=2 reason={error}",
                            self.name.as_deref().unwrap_or("")
                        );
                    })
                }
            }
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(ApiError::unavailable("Model request cancelled")),
            result = tokio::time::timeout(Duration::from_secs(60), operation) => {
                result.unwrap_or_else(|_| Err(ApiError::unavailable("Model request timed out")))
            }
        }
    }

    async fn completion(&self, endpoint: &reqwest::Url, messages: &[Value], max_tokens: u32) -> Result<Value> {
        let payload = json!({"model":self.name,"messages":messages,"temperature":0,"max_tokens":max_tokens});
        let mut response = self
            .client
            .post(endpoint.clone())
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
        let envelope: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::unavailable("Model provider returned an invalid JSON envelope"))?;
        let choice = envelope["choices"]
            .as_array()
            .and_then(|choices| choices.first())
            .ok_or_else(|| ApiError::unavailable("Model provider response is missing choices[0]"))?;
        if choice["finish_reason"] == "content_filter"
            || choice["message"]["refusal"].as_str().is_some_and(|s| !s.is_empty())
        {
            return Err(ApiError::unavailable("模型拒绝生成本次操作，请调整任务内容。"));
        }
        Ok(choice.clone())
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

fn invalid_reply(detail: &str) -> ApiError {
    ApiError::unavailable(format!("Invalid model reply: {detail}"))
}

fn decode_reply(choice: &Value) -> Result<Value> {
    if choice["finish_reason"] == "length" {
        return Err(invalid_reply("response was truncated (finish_reason=length)"));
    }
    let content = &choice["message"]["content"];
    let text = if let Some(text) = content.as_str() {
        text.to_owned()
    } else if let Some(parts) = content.as_array() {
        parts
            .iter()
            .map(|part| match part["type"].as_str() {
                Some("text" | "output_text") => part["text"].as_str(),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| invalid_reply("message.content must contain text parts"))?
            .join("")
    } else {
        return Err(invalid_reply("message.content must be text"));
    };
    let text = text.trim().trim_start_matches('\u{feff}').trim();
    let json = if text.starts_with("```") && text.ends_with("```") && text.len() >= 6 {
        let (language, json) =
            text[3..text.len() - 3].split_once('\n').ok_or_else(|| invalid_reply("incomplete JSON code fence"))?;
        if !language.trim().is_empty() && !language.trim().eq_ignore_ascii_case("json") {
            return Err(invalid_reply("code fence must contain JSON"));
        }
        json.trim()
    } else {
        text
    };
    let reply = serde_json::from_str(json)
        .map_err(|error| invalid_reply(&format!("invalid JSON at line {}, column {}", error.line(), error.column())))?;
    validate_reply(reply)
}

pub fn validate_reply(mut value: Value) -> Result<Value> {
    let obj = value.as_object().ok_or_else(|| invalid_reply("expected a JSON object"))?;
    if obj.get("type").and_then(Value::as_str) == Some("done") {
        if obj.keys().any(|k| !["type", "message"].contains(&k.as_str())) {
            return Err(invalid_reply("done only accepts type and message fields"));
        }
        if !valid_string(&value["message"], 4000) {
            return Err(invalid_reply("message must be nonempty text of at most 4000 characters"));
        }
        return Ok(value);
    }
    if value["type"] != "action" {
        return Err(invalid_reply("type must be action or done"));
    }
    if obj.keys().any(|k| !["type", "tool", "args", "reason", "requiresConfirmation"].contains(&k.as_str())) {
        return Err(invalid_reply("action contains unsupported fields"));
    }
    if !valid_string(&value["reason"], 2000) {
        return Err(invalid_reply("reason must be nonempty text of at most 2000 characters"));
    }
    if value.get("requiresConfirmation").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid_reply("requiresConfirmation must be a boolean"));
    }
    let tool = value["tool"].as_str().ok_or_else(|| invalid_reply("tool must be text"))?;
    let args = value.get("args").cloned().unwrap_or(json!({}));
    command_request(tool, &args).map_err(|error| {
        if error.message.starts_with("Unknown or unsupported tool") {
            invalid_reply("tool is not supported")
        } else {
            invalid_reply(&format!("args: {}", error.message))
        }
    })?;
    value["args"] = args;
    if value.get("requiresConfirmation").is_none() {
        value["requiresConfirmation"] = json!(false);
    }
    Ok(value)
}
fn valid_string(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= max)
}
