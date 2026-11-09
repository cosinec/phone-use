use crate::gateway::Gateway;
use hyper::server::conn::http1::Builder;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpListener, task::JoinSet};

pub async fn serve(listener: TcpListener, gateway: Arc<Gateway>) -> anyhow::Result<()> {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let shutdown = async {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    };
    tokio::pin!(shutdown);
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => {
                let (socket, _) = accepted?;
                let router = gateway.router();
                let cancel = gateway.cancel.clone();
                connections.spawn(async move {
                    let mut builder = Builder::new();
                    builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10));
                    let connection = builder
                        .serve_connection(TokioIo::new(socket), TowerToHyperService::new(router))
                        .with_upgrades();
                    tokio::pin!(connection);
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            connection.as_mut().graceful_shutdown();
                            let _ = tokio::time::timeout(Duration::from_secs(5), connection.as_mut()).await;
                        },
                        _ = connection.as_mut() => {},
                    }
                });
            }
        }
    }
    gateway.close().await;
    if tokio::time::timeout(Duration::from_secs(6), async { while connections.join_next().await.is_some() {} })
        .await
        .is_err()
    {
        connections.abort_all();
    }
    Ok(())
}
