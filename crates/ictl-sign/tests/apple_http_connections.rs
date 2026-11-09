use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::Duration,
};

fn read_headers(stream: &mut TcpStream) -> std::io::Result<bool> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    let mut headers = Vec::new();
    let mut byte = [0];
    while !headers.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte)? == 0 {
            return Ok(false);
        }
        headers.push(byte[0]);
    }
    Ok(true)
}

#[tokio::test]
async fn apple_posts_use_fresh_connections_when_a_peer_rejects_keep_alive_reuse() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut first, _) = listener.accept().unwrap();
        assert!(read_headers(&mut first).unwrap());
        first.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").unwrap();

        // Reproduce the observed peer closing a reused connection after receiving
        // the next request. A fresh connection receives a normal response.
        if read_headers(&mut first).unwrap() {
            return;
        }
        let (mut second, _) = listener.accept().unwrap();
        assert!(read_headers(&mut second).unwrap());
        second.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").unwrap();
    });

    let client = plume_core::client().unwrap();
    let first = client.post(&url).timeout(Duration::from_secs(3)).send().await.unwrap();
    assert_eq!(first.text().await.unwrap(), "ok");
    let second = client.post(&url).timeout(Duration::from_secs(3)).send().await;
    assert!(second.is_ok(), "Apple POST reused a rejected connection: {second:?}");
    assert_eq!(second.unwrap().text().await.unwrap(), "ok");
    server.join().unwrap();
}
