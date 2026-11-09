use axum::{
    http::Method,
    response::{IntoResponse, Response},
};
use percent_encoding::percent_decode_str;
use std::path::{Component, Path};

pub async fn serve(root: &Path, method: &Method, path: &str) -> Option<Response> {
    if *method != Method::GET && *method != Method::HEAD {
        return None;
    }
    let path = percent_decode_str(path).decode_utf8().ok()?;
    if path == "/api"
        || path.starts_with("/api/")
        || path.starts_with("/ios/")
        || path.contains(['\0', '\\'])
        || path.split('/').any(|p| p.starts_with('.'))
    {
        return None;
    }
    let relative = Path::new(path.trim_start_matches('/'));
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let candidate = root.join(relative);
    let file = match tokio::fs::metadata(&candidate).await {
        Ok(info) if info.is_file() => candidate,
        Ok(_) if path == "/" => root.join("index.html"),
        Err(e)
            if e.kind() == std::io::ErrorKind::NotFound
                && relative.extension().is_none()
                && !path.starts_with("/assets/") =>
        {
            root.join("index.html")
        }
        _ => return None,
    };
    let resolved_root = tokio::fs::canonicalize(root).await.ok()?;
    let resolved = tokio::fs::canonicalize(&file).await.ok()?;
    if !resolved.starts_with(&resolved_root) || resolved == resolved_root {
        return None;
    }
    let bytes = tokio::fs::read(&resolved).await.ok()?;
    let length = bytes.len();
    let mime = match file.extension().and_then(|v| v.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    let mut response = if *method == Method::HEAD { Vec::new() } else { bytes }.into_response();
    let headers = response.headers_mut();
    headers.insert("content-type", mime.parse().unwrap());
    headers.insert("content-length", length.to_string().parse().unwrap());
    headers.insert("cache-control", "no-cache".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    Some(response)
}
