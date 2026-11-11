//! Read exactly one bounded MJPEG frame, then release the connection.
use std::io::{Error, ErrorKind, Result};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_HEADER: usize = 16 * 1024;
const MAX_FRAME: usize = 2 * 1024 * 1024;

fn invalid() -> Error {
    Error::new(ErrorKind::InvalidData, "Invalid MJPEG response")
}

async fn line<R: AsyncBufRead + Unpin>(input: &mut R, remaining: &mut usize) -> Result<String> {
    let mut bytes = Vec::new();
    input.take((*remaining + 1) as u64).read_until(b'\n', &mut bytes).await?;
    if bytes.is_empty() || bytes.len() > *remaining {
        return Err(invalid());
    }
    *remaining -= bytes.len();
    Ok(std::str::from_utf8(&bytes).map_err(|_| invalid())?.trim_end_matches(['\r', '\n']).to_owned())
}

pub(crate) async fn capture<S: idevice::ReadWrite + ?Sized>(socket: &mut S) -> Result<Vec<u8>> {
    socket.write_all(b"GET / HTTP/1.0\r\nHost: localhost:9100\r\nConnection: close\r\n\r\n").await?;
    socket.flush().await?;
    let mut input = BufReader::new(socket);
    let mut budget = MAX_HEADER;
    if line(&mut input, &mut budget).await?.split_whitespace().nth(1) != Some("200") {
        return Err(invalid());
    }
    let mut multipart = false;
    loop {
        let header = line(&mut input, &mut budget).await?;
        if header.is_empty() {
            break;
        }
        if let Some((key, value)) = header.split_once(':') {
            if key.eq_ignore_ascii_case("transfer-encoding") {
                return Err(invalid());
            }
            if key.eq_ignore_ascii_case("content-type") {
                multipart = value.trim().to_ascii_lowercase().starts_with("multipart/x-mixed-replace");
            }
        }
    }
    if !multipart {
        return Err(invalid());
    }
    budget = MAX_HEADER;
    let mut length = None;
    loop {
        let header = line(&mut input, &mut budget).await?;
        if header.is_empty() && length.is_some() {
            break;
        }
        if let Some((key, value)) = header.split_once(':')
            && key.eq_ignore_ascii_case("content-length")
        {
            let size = value.trim().parse::<usize>().map_err(|_| invalid())?;
            if length.is_some() || !(4..=MAX_FRAME).contains(&size) {
                return Err(invalid());
            }
            length = Some(size);
        }
    }
    let mut jpeg = vec![0; length.ok_or_else(invalid)?];
    input.read_exact(&mut jpeg).await?;
    if !jpeg.starts_with(b"\xff\xd8") || !jpeg.ends_with(b"\xff\xd9") {
        return Err(invalid());
    }
    Ok(jpeg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captures_fragmented_first_frame_without_waiting_for_eof_or_next_frame() {
        let (mut server, mut client) = tokio::io::duplex(64);
        let peer = tokio::spawn(async move {
            let mut request = BufReader::new(&mut server);
            let mut budget = MAX_HEADER;
            assert_eq!(line(&mut request, &mut budget).await.unwrap(), "GET / HTTP/1.0");
            while !line(&mut request, &mut budget).await.unwrap().is_empty() {}
            let response = b"HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n--frame\r\nContent-Length: 4\r\n\r\n\xff\xd8\xff\xd9";
            for byte in response {
                server.write_all(&[*byte]).await.unwrap();
            }
            std::future::pending::<()>().await;
        });
        let jpeg =
            tokio::time::timeout(std::time::Duration::from_secs(1), capture(&mut client)).await.unwrap().unwrap();
        assert_eq!(jpeg, b"\xff\xd8\xff\xd9");
        peer.abort();
    }

    #[tokio::test]
    async fn rejects_invalid_or_unbounded_frames() {
        for response in [
            b"HTTP/1.0 500 Error\r\n\r\n".to_vec(),
            b"HTTP/1.0 200 OK\r\nContent-Type: image/png\r\n\r\n".to_vec(),
            b"HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec(),
            b"HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace\r\n\r\n--frame\r\nContent-Length: 999999999\r\n\r\n".to_vec(),
            b"HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace\r\n\r\n--frame\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\n".to_vec(),
            b"HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace\r\n\r\n--frame\r\nContent-Length: 4\r\n\r\nxxxx".to_vec(),
            vec![b'x'; MAX_HEADER + 1],
        ] {
            let (mut server, mut client) = tokio::io::duplex(64);
            let peer = tokio::spawn(async move {
                let mut request = BufReader::new(&mut server);
                let mut budget = MAX_HEADER;
                while !line(&mut request, &mut budget).await.unwrap().is_empty() {}
                let _ = server.write_all(&response).await;
            });
            assert!(capture(&mut client).await.is_err());
            peer.await.unwrap();
        }
    }
}
