//! Session-owned, bounded temporary images. Public capabilities only read one image.
use crate::error::{ApiError, Result};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    io::Cursor,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_IMAGE: usize = 5 * 1024 * 1024;
const MAX_TOTAL: usize = 20 * 1024 * 1024;
pub const MAX_UPLOAD_BODY: usize = 7 * 1024 * 1024;
struct Entry {
    id: String,
    key: String,
    name: String,
    mime: String,
    size: usize,
    created: Instant,
}
impl Entry {
    fn metadata(&self) -> Value {
        json!({"id":self.id,"name":self.name,"mimeType":self.mime,"size":self.size})
    }
}
pub struct Attachments {
    directory: PathBuf,
    entries: Mutex<Vec<Entry>>,
}
#[derive(Clone)]
pub struct ReferenceImage {
    pub name: String,
    pub url: String,
    pub content: Value,
}
impl Attachments {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory, entries: Mutex::new(Vec::new()) }
    }
    pub async fn add(&self, input: Value) -> Result<Value> {
        if input.as_object().is_none_or(|o| o.keys().any(|k| !["name", "mimeType", "dataBase64"].contains(&k.as_str())))
        {
            return Err(ApiError::new(400, "无效的图片附件"));
        }
        let name = input["name"]
            .as_str()
            .filter(|n| !n.trim().is_empty() && n.chars().count() <= 120 && !n.contains(['\r', '\n', '\0']))
            .ok_or_else(|| ApiError::new(400, "图片名称无效"))?
            .to_owned();
        let mime = input["mimeType"]
            .as_str()
            .filter(|m| ["image/jpeg", "image/png"].contains(m))
            .ok_or_else(|| ApiError::new(400, "仅支持 JPEG、PNG 图片"))?
            .to_owned();
        let data = input["dataBase64"]
            .as_str()
            .filter(|s| s.len() <= MAX_IMAGE.div_ceil(3) * 4)
            .ok_or_else(|| ApiError::new(413, "单张图片不能超过 5 MiB"))?;
        let bytes =
            base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| ApiError::new(400, "图片编码无效"))?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE {
            return Err(ApiError::new(413, "单张图片不能超过 5 MiB"));
        }
        let expected = if mime == "image/jpeg" { image::ImageFormat::Jpeg } else { image::ImageFormat::Png };
        let bytes = tokio::task::spawn_blocking(move || {
            if image::guess_format(&bytes).ok() != Some(expected) {
                return Err(ApiError::new(400, "图片格式与文件类型不一致"));
            }
            let mut reader = image::ImageReader::with_format(Cursor::new(&bytes), expected);
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(8192);
            limits.max_image_height = Some(8192);
            limits.max_alloc = Some(128 * 1024 * 1024);
            reader.limits(limits);
            reader.decode().map_err(|_| ApiError::new(400, "图片损坏或尺寸超过限制"))?;
            Ok(bytes)
        })
        .await
        .map_err(|_| ApiError::unavailable("图片处理失败"))??;
        let mut entries = self.entries.lock().await;
        if entries.len() >= 6 || entries.iter().map(|e| e.size).sum::<usize>() + bytes.len() > MAX_TOTAL {
            return Err(ApiError::new(413, "每个会话最多 6 张图片，总计不能超过 20 MiB"));
        }
        let id = Uuid::new_v4().to_string();
        tokio::fs::write(self.directory.join(&id), &bytes).await.map_err(|_| ApiError::unavailable("图片保存失败"))?;
        let entry = Entry {
            id,
            key: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            name,
            mime,
            size: bytes.len(),
            created: Instant::now(),
        };
        let metadata = entry.metadata();
        entries.push(entry);
        Ok(metadata)
    }
    pub async fn delete(&self, id: &str) -> Result<()> {
        let mut entries = self.entries.lock().await;
        let index = entries.iter().position(|e| e.id == id).ok_or_else(|| ApiError::new(404, "图片不存在"))?;
        tokio::fs::remove_file(self.directory.join(&entries[index].id))
            .await
            .map_err(|_| ApiError::unavailable("图片删除失败"))?;
        entries.remove(index);
        Ok(())
    }
    pub async fn references(&self, ids: Option<&Value>, base: &str, session: &str) -> Result<Vec<ReferenceImage>> {
        let ids = match ids {
            None => return Ok(vec![]),
            Some(Value::Array(ids)) if ids.len() <= 6 => ids,
            _ => return Err(ApiError::new(400, "无效的任务图片列表")),
        };
        let entries = self.entries.lock().await;
        let mut seen = std::collections::HashSet::new();
        let mut images = Vec::new();
        for id in ids {
            let id = id
                .as_str()
                .filter(|id| seen.insert(id.to_string()))
                .ok_or_else(|| ApiError::new(400, "无效或重复的图片编号"))?;
            let entry =
                entries.iter().find(|e| e.id == id).ok_or_else(|| ApiError::new(404, "图片不属于当前会话或已删除"))?;
            if entry.created.elapsed() > Duration::from_secs(1800) {
                return Err(ApiError::new(410, "图片已过期，请重新添加"));
            }
            let bytes =
                tokio::fs::read(self.directory.join(id)).await.map_err(|_| ApiError::unavailable("图片读取失败"))?;
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            images.push(ReferenceImage {
                name: entry.name.clone(),
                url: format!("{}/api/sessions/{session}/media/{}", base.trim_end_matches('/'), entry.key),
                content: json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{data}",entry.mime)}}),
            });
        }
        Ok(images)
    }
    pub async fn serve(&self, key: &str) -> Result<Response> {
        let entries = self.entries.lock().await;
        let entry = entries
            .iter()
            .find(|e| e.key == key && e.created.elapsed() <= Duration::from_secs(1800))
            .ok_or_else(|| ApiError::new(404, "图片链接已失效"))?;
        let bytes =
            tokio::fs::read(self.directory.join(&entry.id)).await.map_err(|_| ApiError::new(404, "图片不存在"))?;
        let mut response = bytes.into_response();
        let headers = response.headers_mut();
        headers.insert("content-type", entry.mime.parse().unwrap());
        headers.insert("cache-control", "no-store, private".parse().unwrap());
        headers.insert("referrer-policy", "no-referrer".parse().unwrap());
        headers.insert("x-content-type-options", "nosniff".parse().unwrap());
        Ok(response)
    }
}
