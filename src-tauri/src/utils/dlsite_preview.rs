use std::sync::OnceLock;
use std::time::Duration;

use tauri::http::{Response, StatusCode};
use tauri_plugin_http::reqwest::{Client, header};
use url::Url;

const DLSITE_PREVIEW_CONNECT_TIMEOUT_SECS: u64 = 10;
const DLSITE_PREVIEW_TIMEOUT_SECS: u64 = 60;
const DLSITE_PREVIEW_USER_AGENT: &str = concat!(
    "AnneLuckyyy/ReinaManager-Custom/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/AnneLuckyyy/ReinaManager-Custom)"
);

static DLSITE_PREVIEW_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn dlsite_preview_http_client() -> &'static Client {
    DLSITE_PREVIEW_HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(DLSITE_PREVIEW_CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(DLSITE_PREVIEW_TIMEOUT_SECS))
            .user_agent(DLSITE_PREVIEW_USER_AGENT)
            .build()
            .expect("failed to build DLsite preview http client")
    })
}

fn make_status_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("failed to build DLsite preview status response")
}

fn make_image_response(bytes: Vec<u8>, content_type: Option<&str>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(
            "Content-Type",
            content_type
                .filter(|value| value.starts_with("image/"))
                .unwrap_or("application/octet-stream"),
        )
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .expect("failed to build DLsite preview image response")
}

fn is_allowed_dlsite_image(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("img.dlsite.jp") | Some("img.dlsite.com")
        )
}

/// 只为添加窗口的 DLsite 候选缩略图提供内存中转。
///
/// 该协议严格限制来源域名，不写入文件或数据库；它复用导入后封面可用的原生
/// HTTP 客户端，避免 DLsite CDN 拒绝 WebView 的裸图片请求。
pub fn register_dlsite_preview_protocol<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        "reina-dlsite-preview",
        |_app, request, responder| {
            let request_uri = request.uri().to_string();

            tauri::async_runtime::spawn(async move {
                let parsed = match Url::parse(&request_uri) {
                    Ok(url) => url,
                    Err(_) => {
                        responder.respond(make_status_response(StatusCode::BAD_REQUEST));
                        return;
                    }
                };

                let Some(source_url) = parsed
                    .query_pairs()
                    .find(|(key, _)| key == "url")
                    .map(|(_, value)| value.into_owned())
                else {
                    responder.respond(make_status_response(StatusCode::BAD_REQUEST));
                    return;
                };

                let source_url = match Url::parse(&source_url) {
                    Ok(url) if is_allowed_dlsite_image(&url) => url,
                    Ok(_) => {
                        responder.respond(make_status_response(StatusCode::FORBIDDEN));
                        return;
                    }
                    Err(_) => {
                        responder.respond(make_status_response(StatusCode::BAD_REQUEST));
                        return;
                    }
                };

                let response = match dlsite_preview_http_client()
                    .get(source_url.as_str())
                    .header(
                        header::ACCEPT,
                        "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    )
                    .header(header::COOKIE, "adultchecked=1; locale=ja")
                    .header(header::REFERER, "https://www.dlsite.com/")
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => response,
                    Ok(response) => {
                        log::debug!(
                            "DLsite candidate preview returned status {}",
                            response.status()
                        );
                        responder.respond(make_status_response(StatusCode::BAD_GATEWAY));
                        return;
                    }
                    Err(error) => {
                        log::debug!("DLsite candidate preview request failed: {}", error);
                        responder.respond(make_status_response(StatusCode::BAD_GATEWAY));
                        return;
                    }
                };

                let content_type = response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let bytes = match response.bytes().await {
                    Ok(bytes) if !bytes.is_empty() => bytes.to_vec(),
                    Ok(_) => {
                        responder.respond(make_status_response(StatusCode::BAD_GATEWAY));
                        return;
                    }
                    Err(error) => {
                        log::debug!("DLsite candidate preview body failed: {}", error);
                        responder.respond(make_status_response(StatusCode::BAD_GATEWAY));
                        return;
                    }
                };

                responder.respond(make_image_response(bytes, content_type.as_deref()));
            });
        },
    )
}
