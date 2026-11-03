//! 验证临时不支持 Range 的来源恢复后，单流可安全切换回分段续传。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use reina_download::{
    CancellationToken, DownloadOptions, DownloadRequest, Outcome, Progress, download,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

struct UpgradeServer {
    address: std::net::SocketAddr,
    ranged_responses: Arc<AtomicUsize>,
}

impl UpgradeServer {
    async fn start(data: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let ranged_responses = Arc::new(AtomicUsize::new(0));
        tokio::spawn({
            let requests = Arc::clone(&requests);
            let ranged_responses = Arc::clone(&ranged_responses);
            async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        break;
                    };
                    let data = data.clone();
                    let requests = Arc::clone(&requests);
                    let ranged_responses = Arc::clone(&ranged_responses);
                    tokio::spawn(async move {
                        let _ = respond(stream, data, requests, ranged_responses).await;
                    });
                }
            }
        });
        Self {
            address,
            ranged_responses,
        }
    }

    fn url(&self) -> String {
        format!("http://{}/game.bin", self.address)
    }
}

async fn respond(
    mut stream: TcpStream,
    data: Vec<u8>,
    requests: Arc<AtomicUsize>,
    ranged_responses: Arc<AtomicUsize>,
) -> std::io::Result<()> {
    let mut request = Vec::new();
    let mut byte = [0_u8; 1];
    while !request.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await? == 0 {
            return Ok(());
        }
        request.push(byte[0]);
        if request.len() > 16 * 1024 {
            return Ok(());
        }
    }
    let text = String::from_utf8_lossy(&request);
    let range = text.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("range:")
            .map(str::to_owned)
    });
    // 前两次都是初始探测与确认探测：故意忽略 Range，使下载进入单流。
    let request_number = requests.fetch_add(1, Ordering::Relaxed) + 1;
    let use_range = request_number > 2 && range.is_some();
    let (body, header) = if use_range {
        let specification = range.unwrap();
        let value = specification.trim().strip_prefix("bytes=").unwrap();
        let (start, end) = value.split_once('-').unwrap();
        let start: usize = start.parse().unwrap();
        let end: usize = end.parse::<usize>().unwrap().min(data.len() - 1);
        let body = data[start..=end].to_vec();
        ranged_responses.fetch_add(1, Ordering::Relaxed);
        (
            body,
            format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                data.len(),
                end - start + 1
            ),
        )
    } else {
        (
            data.clone(),
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                data.len()
            ),
        )
    };
    stream.write_all(header.as_bytes()).await?;
    // 让单流保持足够久，确保后台探测会发生。
    for chunk in body.chunks(8 * 1024) {
        stream.write_all(chunk).await?;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(())
}

#[tokio::test]
async fn upgrades_from_single_stream_when_range_recovers() {
    let data = (0..1_000_000)
        .map(|index| ((index * 31 + index / 251) % 251) as u8)
        .collect::<Vec<_>>();
    let server = UpgradeServer::start(data.clone()).await;
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("game.bin");
    let (sender, _) = watch::channel(Progress::initial());
    let options = DownloadOptions {
        piece_size: 64 * 1024,
        initial_connections: 4,
        max_connections: 4,
        range_confirm_delay: Duration::from_millis(10),
        upgrade_probe_interval: Duration::from_millis(20),
        stall_timeout: Duration::from_secs(2),
        ..DownloadOptions::default()
    };

    let outcome = download(
        DownloadRequest {
            url: server.url(),
            target: target.clone(),
            expected_size: data.len() as u64,
            identity: Some("test-upgrade".to_string()),
        },
        options,
        reqwest::Client::new(),
        sender,
        CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome, Outcome::Completed);
    assert_eq!(std::fs::read(target).unwrap(), data);
    assert!(
        server.ranged_responses.load(Ordering::Relaxed) >= 2,
        "single stream never upgraded into segmented requests"
    );
}
