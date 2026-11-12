//! Native diagnostics must never backpressure the daemon's stdout/stderr.
use std::{
    io,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufWriter},
    sync::mpsc,
};

const FILE_BYTES: u64 = 32 * 1024 * 1024;
const FILE_COUNT: usize = 8;
const QUEUE_CHUNKS: usize = 128; // 1 MiB, independent of disk throughput.

/// A slow or failed log disk drops diagnostics, never blocks phone traffic.
pub(crate) async fn drain(input: impl AsyncRead + Unpin, path: PathBuf) {
    let (sender, receiver) = mpsc::channel(QUEUE_CHUNKS);
    let dropped = Arc::new(AtomicU64::new(0));
    let label = path.display().to_string();
    let writer = tokio::spawn(record(receiver, dropped.clone(), path, FILE_BYTES, FILE_COUNT));
    pump(input, sender, dropped, label).await;
    // Pipe reading is already finished. Await final buffered data for clean shutdown.
    let _ = writer.await;
}

async fn pump(
    mut input: impl AsyncRead + Unpin,
    sender: mpsc::Sender<Vec<u8>>,
    dropped: Arc<AtomicU64>,
    label: String,
) {
    let mut buffer = [0; 8192];
    while let Ok(n) = input.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        if sender.try_send(buffer[..n].to_vec()).is_err() {
            let previous = dropped.fetch_add(n as u64, Ordering::Relaxed);
            if previous == 0 {
                eprintln!(
                    "{} event=native_log_overflow path={label} action=drop_diagnostics pipe_reading=continued",
                    chrono::Utc::now().to_rfc3339()
                );
            }
        }
    }
    let count = dropped.load(Ordering::Relaxed);
    if count > 0 {
        eprintln!(
            "{} event=native_log_drop_summary path={label} dropped_bytes={count}",
            chrono::Utc::now().to_rfc3339()
        );
    }
}

struct RotatingLog {
    path: PathBuf,
    file: BufWriter<tokio::fs::File>,
    bytes: u64,
    max: u64,
    count: usize,
}
impl RotatingLog {
    async fn open(path: PathBuf, max: u64, count: usize) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
            tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let file = Self::file(&path).await?;
        let bytes = file.metadata().await?.len();
        Ok(Self { path, file: BufWriter::with_capacity(64 * 1024, file), bytes, max, count })
    }
    async fn file(path: &Path) -> io::Result<tokio::fs::File> {
        let file = tokio::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(path).await?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600)).await?;
        Ok(file)
    }
    fn rotated(&self, n: usize) -> PathBuf {
        self.path.with_file_name(format!("{}.{}", self.path.file_name().unwrap().to_string_lossy(), n))
    }
    async fn rotate(&mut self) -> io::Result<()> {
        self.file.flush().await?;
        for n in (1..self.count - 1).rev() {
            match tokio::fs::rename(self.rotated(n), self.rotated(n + 1)).await {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                result => result?,
            }
        }
        tokio::fs::rename(&self.path, self.rotated(1)).await?;
        self.file = BufWriter::with_capacity(64 * 1024, Self::file(&self.path).await?);
        self.bytes = 0;
        Ok(())
    }
    async fn append(&mut self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            if self.bytes >= self.max {
                self.rotate().await?;
            }
            let n = bytes.len().min((self.max - self.bytes) as usize);
            self.file.write_all(&bytes[..n]).await?;
            self.bytes += n as u64;
            bytes = &bytes[n..];
        }
        Ok(())
    }
    async fn flush(&mut self) -> io::Result<()> {
        self.file.flush().await
    }
}

async fn record(mut receiver: mpsc::Receiver<Vec<u8>>, dropped: Arc<AtomicU64>, path: PathBuf, max: u64, count: usize) {
    let mut log = match RotatingLog::open(path.clone(), max, count).await {
        Ok(log) => log,
        Err(error) => {
            eprintln!(
                "{} event=native_log_disabled path={} error_kind={:?}",
                chrono::Utc::now().to_rfc3339(),
                path.display(),
                error.kind()
            );
            return;
        }
    };
    let mut reported = 0;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let result: io::Result<()> = async {
        loop {
            let data = tokio::select! {
                data = receiver.recv() => data,
                _ = tick.tick() => { log.flush().await?; continue; }
            };
            let total = dropped.load(Ordering::Relaxed);
            if total > reported {
                let marker = format!(
                    "\n{} event=native_log_dropped dropped_bytes={} total_dropped_bytes={total}\n",
                    chrono::Utc::now().to_rfc3339(),
                    total - reported
                );
                log.append(marker.as_bytes()).await?;
                reported = total;
            }
            match data {
                Some(bytes) => log.append(&bytes).await?,
                None => break,
            }
        }
        log.flush().await
    }
    .await;
    if let Err(error) = result {
        eprintln!(
            "{} event=native_log_disabled path={} error_kind={:?}",
            chrono::Utc::now().to_rfc3339(),
            path.display(),
            error.kind()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn daemon_diagnostics_survive_pipe_close() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs/daemon.stderr.log");
        let (mut writer, reader) = tokio::io::duplex(128);
        let task = tokio::spawn(drain(reader, path.clone()));
        writer.write_all(b"health timeout stage=connect\n").await.unwrap();
        drop(writer);
        task.await.unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"health timeout stage=connect\n");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    #[tokio::test]
    async fn rotation_preserves_exact_bytes_and_bounds_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs/stderr.log");
        let mut log = RotatingLog::open(path.clone(), 8, 3).await.unwrap();
        log.append(b"0123456789abcdefghij").await.unwrap();
        log.flush().await.unwrap();
        let mut all = tokio::fs::read(log.rotated(2)).await.unwrap();
        all.extend(tokio::fs::read(log.rotated(1)).await.unwrap());
        all.extend(tokio::fs::read(&path).await.unwrap());
        assert_eq!(all, b"0123456789abcdefghij");
        log.append(b"klmnopqrstuv").await.unwrap();
        log.flush().await.unwrap();
        assert!(!log.rotated(3).exists());
        assert_eq!(tokio::fs::read(log.rotated(2)).await.unwrap(), b"89abcdef");
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"opqrstuv");
    }
    #[tokio::test]
    async fn failed_log_storage_does_not_block_pipe() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("blocked");
        tokio::fs::write(&blocked, b"file, not a directory").await.unwrap();
        // Match the pump read buffer so the deadline measures log backpressure, not tiny-buffer scheduling.
        let (mut writer, reader) = tokio::io::duplex(8192);
        let task = tokio::spawn(drain(reader, blocked.join("stderr.log")));
        tokio::time::timeout(Duration::from_secs(5), async {
            writer.write_all(&vec![42; 2 * 1024 * 1024]).await.unwrap();
            drop(writer);
            task.await.unwrap();
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn stalled_logger_queue_never_backpressures_pipe_and_reports_drops() {
        let (sender, mut receiver) = mpsc::channel(1);
        let dropped = Arc::new(AtomicU64::new(0));
        // Match the pump read buffer so the deadline measures log backpressure, not tiny-buffer scheduling.
        let (mut writer, reader) = tokio::io::duplex(8192);
        let pump_task = tokio::spawn(pump(reader, sender, dropped.clone(), "fixture".into()));
        tokio::time::timeout(Duration::from_secs(5), async {
            writer.write_all(&vec![42; 2 * 1024 * 1024]).await.unwrap();
            drop(writer);
            pump_task.await.unwrap();
        })
        .await
        .unwrap();
        let kept = receiver.recv().await.unwrap().len() as u64;
        assert_eq!(kept + dropped.load(Ordering::Relaxed), 2 * 1024 * 1024);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log");
        record(receiver, dropped, path.clone(), 4096, 2).await;
        assert!(String::from_utf8(tokio::fs::read(path).await.unwrap()).unwrap().contains("event=native_log_dropped"));
    }
}
