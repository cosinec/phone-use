use ictl_gateway::{
    gateway::{Config, Gateway},
    model::Model,
};
use std::{collections::HashMap, path::PathBuf};

fn main() {
    if let Err(error) = start() {
        eprintln!("Gateway startup failed: {error}");
        std::process::exit(1);
    }
}
fn start() -> anyhow::Result<()> {
    // Load native and gateway overrides before Tokio creates worker threads.
    if let Err(error) = dotenvy::from_path(".env")
        && !matches!(&error, dotenvy::Error::Io(e) if e.kind() == std::io::ErrorKind::NotFound)
    {
        anyhow::bail!("Invalid .env configuration");
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run())
}
async fn run() -> anyhow::Result<()> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let value = |key: &str, default: &str| env.get(key).cloned().unwrap_or_else(|| default.to_owned());
    let host = value("HOST", "127.0.0.1");
    let port = value("PORT", "8787").parse::<u16>()?;
    let origins = value("ALLOWED_ORIGINS", &format!("http://127.0.0.1:{port},http://localhost:{port}"))
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    let public_url =
        env.get("PUBLIC_BASE_URL").filter(|s| !s.trim().is_empty()).map(|s| reqwest::Url::parse(s)).transpose()?;
    if let Some(url) = &public_url {
        anyhow::ensure!(
            ["http", "https"].contains(&url.scheme()) && url.username().is_empty() && url.password().is_none(),
            "HTTP(S) PUBLIC_BASE_URL required"
        );
    }
    let default_dist =
        if std::path::Path::new("browser-control/dist").is_dir() { "browser-control/dist" } else { "dist" };
    let config = Config {
        token: value("CONTROL_ACCESS_TOKEN", ""),
        origins,
        public_url,
        runtime: PathBuf::from(value("RUNTIME_DIR", ".runtime")),
        native: PathBuf::from(value("ICTL_BIN", "iphone-control")),
        web_dist: PathBuf::from(value("WEB_DIST_DIR", default_dist)),
    };
    let model = Model::new(&env)?;
    let gateway = Gateway::new(config, model).await?;
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    println!("Gateway listening http://{}", listener.local_addr()?);
    ictl_gateway::server::serve(listener, gateway).await
}
