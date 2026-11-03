//! Shionlib 安装协议：先仅接收并预览，经用户确认和来源复核后创建暂停任务。

use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::{Component, Path},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{App, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const INSTALL_SCHEME: &str = "reinamanager";
const DEV_INSTALL_SCHEME: &str = "reinamanager-test";
const CUSTOM_INSTALL_SCHEME: &str = "reinamanager-custom";
const INSTALL_HOST: &str = "install";
const PROTOCOL_VERSION: u32 = 1;
const SHIONLIB_PROVIDER: &str = "shionlib";
const MAX_PENDING_PREVIEWS: usize = 8;
const PENDING_REQUEST_TTL_SECONDS: i64 = 15 * 60;
const SUPPORTED_PARAMS: &[&str] = &[
    "v",
    "provider",
    "resource_id",
    "url",
    "file_name",
    "archive_format",
    "archive_password",
    "size",
    "checksum_algo",
    "checksum",
    "expires_at",
    "bgm_id",
    "vndb_id",
    "hikarinagi_id",
    "title",
];
const SUPPORTED_ARCHIVE_FORMATS: &[&str] = &[
    "7z", "zip", "rar", "tar", "tar.gz", "tar.bz2", "tar.xz", "tar.zst",
];

fn is_install_scheme(scheme: &str) -> bool {
    scheme == INSTALL_SCHEME
        || scheme == CUSTOM_INSTALL_SCHEME
        || (cfg!(debug_assertions) && scheme == DEV_INSTALL_SCHEME)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ShionlibInstallPreview {
    pub request_id: String,
    pub title: String,
    pub resource_id: String,
    pub file_name: String,
    pub archive_format: String,
    pub size: i64,
    pub checksum_algorithm: Option<String>,
    pub download_host: String,
    pub expires_at: Option<i64>,
}

#[derive(Clone, Debug)]
struct PendingShionlibRequest {
    preview: ShionlibInstallPreview,
    download_url: Url,
    checksum: Option<ShionlibChecksum>,
    install_details: crate::download_tasks::ShionlibInstallTaskDetails,
    received_at: i64,
    dedup_key: String,
}

#[derive(Clone, Debug)]
struct ShionlibChecksum {
    algorithm: String,
    value: String,
}

#[derive(Default)]
struct PendingProtocolData {
    previews: VecDeque<ShionlibInstallPreview>,
    preview_keys: HashSet<String>,
    requests: HashMap<String, PendingShionlibRequest>,
    confirming: HashSet<String>,
    rejections: VecDeque<String>,
}

#[derive(Default)]
pub struct ShionlibProtocolState {
    pending: Mutex<PendingProtocolData>,
    next_request_id: AtomicU64,
}

impl ShionlibProtocolState {
    fn push_preview(
        &self,
        mut preview: ShionlibInstallPreview,
        download_url: Url,
        checksum: Option<ShionlibChecksum>,
        install_details: crate::download_tasks::ShionlibInstallTaskDetails,
    ) -> bool {
        let key = format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            preview.resource_id, preview.file_name, preview.size, preview.download_host
        );
        let mut pending = self.pending.lock();
        purge_expired_requests(&mut pending);
        if pending.preview_keys.contains(&key) {
            return false;
        }
        if pending.requests.len() >= MAX_PENDING_PREVIEWS {
            pending
                .rejections
                .push_back("待确认的 Shionlib 请求过多，已忽略，请重新从网站发起一次".to_string());
            return false;
        }
        let request_id = format!(
            "shionlib-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        preview.request_id = request_id.clone();
        pending.preview_keys.insert(key.clone());
        pending.requests.insert(
            request_id,
            PendingShionlibRequest {
                preview: preview.clone(),
                download_url,
                checksum,
                install_details,
                received_at: chrono::Utc::now().timestamp(),
                dedup_key: key,
            },
        );
        pending.previews.push_back(preview);
        true
    }

    fn push_rejection(&self, message: String) {
        self.pending.lock().rejections.push_back(message);
    }

    fn take_previews(&self) -> Vec<ShionlibInstallPreview> {
        let mut pending = self.pending.lock();
        purge_expired_requests(&mut pending);
        pending.previews.drain(..).collect()
    }

    fn take_rejections(&self) -> Vec<String> {
        self.pending.lock().rejections.drain(..).collect()
    }

    fn begin_confirmation(&self, request_id: &str) -> Result<PendingShionlibRequest, String> {
        let mut pending = self.pending.lock();
        purge_expired_requests(&mut pending);
        let request = pending.requests.get(request_id).cloned().ok_or_else(|| {
            "该 Shionlib 请求已过期、已使用或不存在，请返回网站重新选择".to_string()
        })?;
        if !pending.confirming.insert(request_id.to_string()) {
            return Err("该 Shionlib 请求正在创建下载任务，请勿重复提交".to_string());
        }
        Ok(request)
    }

    fn finish_confirmation(&self, request_id: &str, consume: bool) {
        let mut pending = self.pending.lock();
        pending.confirming.remove(request_id);
        if consume && let Some(request) = pending.requests.remove(request_id) {
            pending.preview_keys.remove(&request.dedup_key);
        }
    }
}

fn purge_expired_requests(pending: &mut PendingProtocolData) {
    let now = chrono::Utc::now().timestamp();
    let expired_ids: Vec<String> = pending
        .requests
        .iter()
        .filter_map(|(request_id, request)| {
            let expires_at = request
                .preview
                .expires_at
                .unwrap_or(request.received_at + PENDING_REQUEST_TTL_SECONDS);
            (expires_at <= now).then(|| request_id.clone())
        })
        .collect();
    for request_id in expired_ids {
        if let Some(request) = pending.requests.remove(&request_id) {
            pending.preview_keys.remove(&request.dedup_key);
        }
        pending.confirming.remove(&request_id);
    }
    let active_request_ids: HashSet<String> = pending.requests.keys().cloned().collect();
    pending
        .previews
        .retain(|preview| active_request_ids.contains(&preview.request_id));
}

#[tauri::command]
pub fn take_pending_shionlib_install_previews(
    state: State<'_, ShionlibProtocolState>,
) -> Vec<ShionlibInstallPreview> {
    state.take_previews()
}

#[tauri::command]
pub fn take_pending_shionlib_install_rejections(
    state: State<'_, ShionlibProtocolState>,
) -> Vec<String> {
    state.take_rejections()
}

#[tauri::command]
pub async fn create_shionlib_download_task(
    app: tauri::AppHandle,
    state: State<'_, ShionlibProtocolState>,
    db: State<'_, sea_orm::DatabaseConnection>,
    request_id: String,
    auto_import: Option<bool>,
    auto_delete: Option<bool>,
) -> Result<crate::entity::tasks::Model, String> {
    let request = state.begin_confirmation(&request_id)?;
    let expected_checksum = request
        .checksum
        .as_ref()
        .map(|checksum| {
            crate::download_tasks::checksum_from_shionlib(&checksum.algorithm, &checksum.value)
        })
        .transpose();
    let expected_checksum = match expected_checksum {
        Ok(checksum) => checksum,
        Err(error) => {
            state.finish_confirmation(&request_id, false);
            return Err(error);
        }
    };
    let result = crate::download_tasks::create_paused_shionlib_install_task(
        db.inner(),
        &request.preview.title,
        request.download_url,
        request.preview.size,
        &request.preview.file_name,
        expected_checksum,
        request.preview.expires_at,
        request.install_details,
    )
    .await;
    state.finish_confirmation(&request_id, result.is_ok());
    let task = result?;
    let task = crate::download_tasks::set_task_automation(
        db.inner(),
        task.id,
        auto_import.unwrap_or(false),
        auto_import.unwrap_or(false) && auto_delete.unwrap_or(false),
    )
    .await?;
    match crate::download_tasks::spawn_task(app, db.inner().clone(), task.id) {
        Ok(()) => crate::download_tasks::find_task(db.inner(), task.id).await,
        Err(_) => Ok(task),
    }
}

pub fn setup_shionlib_install_protocol(app: &App) {
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            enqueue_shionlib_install_url(&handle, url);
        }
    });

    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                enqueue_shionlib_install_url(app.handle(), url);
            }
        }
        Ok(None) => {}
        Err(error) => log::warn!("读取启动 Shionlib 请求失败: {error}"),
    }

    // 开发版不抢占系统 URL 协议，避免覆盖用户正式安装的关联。
    #[cfg(not(debug_assertions))]
    if let Err(error) = app.deep_link().register_all() {
        log::warn!("注册 ReinaManager 安装协议失败: {error}");
    }
}

pub(crate) fn enqueue_shionlib_install_url(app: &tauri::AppHandle, url: Url) {
    // 单实例回调会同时带来普通启动参数；它们可能被 URL 解析器识别为
    // Windows 盘符等其它 scheme，不能把这些非 ReinaManager 链接提示为拒绝请求。
    if !is_install_scheme(url.scheme()) {
        return;
    }
    let state = app.state::<ShionlibProtocolState>();
    match parse_shionlib_install_request(url) {
        Ok((preview, download_url, checksum, install_details)) => {
            if state.push_preview(preview, download_url, checksum, install_details) {
                let _ = app.emit("shionlib-install-preview-received", ());
            }
        }
        Err(message) => {
            log::warn!("拒绝 Shionlib 安装请求: {message}");
            state.push_rejection(message);
            let _ = app.emit("shionlib-install-preview-rejected", ());
        }
    }
}

#[cfg(test)]
pub fn parse_shionlib_install_url(url: Url) -> Result<ShionlibInstallPreview, String> {
    parse_shionlib_install_request(url).map(|(preview, _, _, _)| preview)
}

fn parse_shionlib_install_request(
    url: Url,
) -> Result<
    (
        ShionlibInstallPreview,
        Url,
        Option<ShionlibChecksum>,
        crate::download_tasks::ShionlibInstallTaskDetails,
    ),
    String,
> {
    if !is_install_scheme(url.scheme()) || url.host_str() != Some(INSTALL_HOST) {
        return Err("协议地址必须是已注册的 ReinaManager 安装协议://install".to_string());
    }

    let mut params = HashMap::new();
    for (key, value) in url.query_pairs() {
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("安装请求包含重复参数".to_string());
        }
    }
    if let Some(unknown) = params
        .keys()
        .find(|key| !SUPPORTED_PARAMS.contains(&key.as_str()))
    {
        return Err(format!("安装请求包含未知参数: {unknown}"));
    }
    let version = required(&params, "v")?
        .parse::<u32>()
        .map_err(|_| "协议版本无效".to_string())?;
    if version != PROTOCOL_VERSION {
        return Err(format!("不支持的协议版本: {version}"));
    }
    let provider = required(&params, "provider")?.trim().to_ascii_lowercase();
    if provider != SHIONLIB_PROVIDER {
        return Err("当前只接受 Shionlib 发起的资源请求".to_string());
    }
    let resource_id = bounded_text(required(&params, "resource_id")?, "资源 ID", 256)?;
    let title = bounded_text(required(&params, "title")?, "资源标题", 200)?;
    let file_name = validate_file_name(required(&params, "file_name")?)?;
    let archive_format = normalize_archive_format(required(&params, "archive_format")?);
    if !SUPPORTED_ARCHIVE_FORMATS.contains(&archive_format.as_str()) {
        return Err("不支持的压缩格式".to_string());
    }
    if let Some(password) = params.get("archive_password")
        && password.chars().count() > 256
    {
        return Err("压缩包密码过长".to_string());
    }
    let metadata = crate::download_tasks::ShionlibMetadataHints {
        bgm_id: optional_bounded_text(&params, "bgm_id", "元数据 ID", 128)?,
        vndb_id: optional_bounded_text(&params, "vndb_id", "元数据 ID", 128)?,
        hikarinagi_id: optional_bounded_text(&params, "hikarinagi_id", "元数据 ID", 128)?,
    };
    let size = required(&params, "size")?
        .parse::<i64>()
        .map_err(|_| "文件大小无效".to_string())?;
    if size <= 0 {
        return Err("文件大小无效".to_string());
    }
    let expires_at = params
        .get("expires_at")
        .map(|value| value.parse::<i64>().map_err(|_| "过期时间无效".to_string()))
        .transpose()?;
    if expires_at.is_some_and(|value| value <= chrono::Utc::now().timestamp()) {
        return Err("该资源链接已过期，请返回 Shionlib 重新选择".to_string());
    }
    let checksum = validate_checksum(&params)?;
    let checksum_algorithm = checksum.as_ref().map(|checksum| checksum.algorithm.clone());

    let download_url =
        Url::parse(required(&params, "url")?).map_err(|_| "下载地址无效".to_string())?;
    if download_url.scheme() != "https" || download_url.host_str().is_none() {
        return Err("下载地址必须是带主机名的 HTTPS 地址".to_string());
    }
    if !download_url.username().is_empty() || download_url.password().is_some() {
        return Err("下载地址不能包含账户信息".to_string());
    }
    let download_host = download_url
        .host_str()
        .ok_or_else(|| "下载地址缺少主机名".to_string())?
        .to_ascii_lowercase();
    if is_local_or_private_host(&download_host) {
        return Err("下载地址不能指向本机、局域网或保留地址".to_string());
    }

    Ok((
        ShionlibInstallPreview {
            request_id: String::new(),
            title,
            resource_id: resource_id.clone(),
            file_name,
            archive_format: archive_format.clone(),
            size,
            checksum_algorithm,
            download_host,
            expires_at,
        },
        download_url,
        checksum,
        crate::download_tasks::ShionlibInstallTaskDetails {
            resource_id,
            archive_format,
            metadata,
        },
    ))
}

fn required<'a>(params: &'a HashMap<String, String>, name: &str) -> Result<&'a str, String> {
    params
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| format!("缺少参数: {name}"))
}

fn bounded_text(value: &str, label: &str, max_chars: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars || value.chars().any(char::is_control)
    {
        return Err(format!("{label} 无效"));
    }
    Ok(value.to_string())
}

fn optional_bounded_text(
    params: &HashMap<String, String>,
    name: &str,
    label: &str,
    max_chars: usize,
) -> Result<Option<String>, String> {
    params
        .get(name)
        .map(|value| bounded_text(value, label, max_chars))
        .transpose()
}

fn validate_file_name(value: &str) -> Result<String, String> {
    let value = bounded_text(value, "文件名", 180)?;
    let mut components = Path::new(&value).components();
    let is_single_name = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !value.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*']);
    if !is_single_name || matches!(value.as_str(), "." | "..") {
        return Err("文件名无效".to_string());
    }
    Ok(value)
}

fn normalize_archive_format(value: &str) -> String {
    match value
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "tgz" => "tar.gz".to_string(),
        "tbz" | "tbz2" => "tar.bz2".to_string(),
        "txz" => "tar.xz".to_string(),
        "tzst" => "tar.zst".to_string(),
        value => value.to_string(),
    }
}

fn validate_checksum(params: &HashMap<String, String>) -> Result<Option<ShionlibChecksum>, String> {
    match (params.get("checksum_algo"), params.get("checksum")) {
        (None, None) => Ok(None),
        (Some(algorithm), Some(value)) => {
            let algorithm = algorithm.trim().to_ascii_lowercase();
            if !matches!(algorithm.as_str(), "sha256" | "blake3")
                || value.len() != 64
                || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("来源校验信息无效".to_string());
            }
            Ok(Some(ShionlibChecksum {
                algorithm,
                value: value.to_ascii_lowercase(),
            }))
        }
        _ => Err("来源校验信息不完整".to_string()),
    }
}

fn is_local_or_private_host(host: &str) -> bool {
    if matches!(host, "localhost" | "localhost.")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return true;
    }
    let Ok(address) = host.parse::<IpAddr>() else {
        return false;
    };
    match address {
        IpAddr::V4(address) => is_private_ipv4(address),
        IpAddr::V6(address) => is_private_ipv6(address),
    }
}

fn is_private_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_unspecified()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || octets[0] >= 224
}

fn is_private_ipv6(address: Ipv6Addr) -> bool {
    address.is_loopback()
        || address.is_unspecified()
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || address.is_multicast()
        || address.to_ipv4_mapped().is_some_and(is_private_ipv4)
}

#[cfg(test)]
mod tests {
    use super::{
        ShionlibProtocolState, parse_shionlib_install_request, parse_shionlib_install_url,
    };
    use url::Url;

    fn valid_url() -> Url {
        Url::parse("reinamanager://install?v=1&provider=shionlib&resource_id=42&url=https%3A%2F%2Fcdn.example.com%2Fgame.7z%3Ftoken%3Dsecret&file_name=game.7z&archive_format=7z&size=123&checksum_algo=sha256&checksum=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=4102444800&title=Test%20Game").unwrap()
    }

    #[test]
    fn parses_only_the_safe_preview_fields() {
        let preview = parse_shionlib_install_url(valid_url()).unwrap();
        assert_eq!(preview.title, "Test Game");
        assert_eq!(preview.download_host, "cdn.example.com");
        assert_eq!(preview.checksum_algorithm.as_deref(), Some("sha256"));
    }

    #[test]
    fn accepts_the_public_custom_install_scheme() {
        let custom_url = Url::parse(
            "reinamanager-custom://install?v=1&provider=shionlib&resource_id=42&url=https%3A%2F%2Fcdn.example.com%2Fgame.7z&file_name=game.7z&archive_format=7z&size=123&title=Test",
        )
        .unwrap();
        assert!(parse_shionlib_install_url(custom_url).is_ok());
    }

    #[test]
    fn rejects_other_providers_and_local_downloads() {
        let other_provider = Url::parse("reinamanager://install?v=1&provider=other&resource_id=42&url=https%3A%2F%2Fcdn.example.com%2Fgame.7z&file_name=game.7z&archive_format=7z&size=123&title=Test").unwrap();
        assert!(parse_shionlib_install_url(other_provider).is_err());
        let local = Url::parse("reinamanager://install?v=1&provider=shionlib&resource_id=42&url=https%3A%2F%2F127.0.0.1%2Fgame.7z&file_name=game.7z&archive_format=7z&size=123&title=Test").unwrap();
        assert!(parse_shionlib_install_url(local).is_err());
    }

    #[test]
    fn rejects_unknown_or_expired_requests() {
        let unknown = Url::parse("reinamanager://install?v=1&provider=shionlib&resource_id=42&url=https%3A%2F%2Fcdn.example.com%2Fgame.7z&file_name=game.7z&archive_format=7z&size=123&title=Test&extra=value").unwrap();
        assert!(parse_shionlib_install_url(unknown).is_err());
        let expired = Url::parse("reinamanager://install?v=1&provider=shionlib&resource_id=42&url=https%3A%2F%2Fcdn.example.com%2Fgame.7z&file_name=game.7z&archive_format=7z&size=123&expires_at=1&title=Test").unwrap();
        assert!(parse_shionlib_install_url(expired).is_err());
    }

    #[test]
    fn keeps_the_download_url_in_memory_until_one_confirmation() {
        let (preview, download_url, checksum, install_details) =
            parse_shionlib_install_request(valid_url()).unwrap();
        let state = ShionlibProtocolState::default();
        assert!(state.push_preview(preview, download_url, checksum, install_details));
        let preview = state.take_previews().pop().unwrap();
        let request = state.begin_confirmation(&preview.request_id).unwrap();
        assert_eq!(request.download_url.host_str(), Some("cdn.example.com"));
        assert!(state.begin_confirmation(&preview.request_id).is_err());
        state.finish_confirmation(&preview.request_id, true);
        assert!(state.begin_confirmation(&preview.request_id).is_err());
    }

    #[test]
    fn keeps_only_valid_non_sensitive_metadata_for_the_install_task() {
        let url = Url::parse("reinamanager://install?v=1&provider=shionlib&resource_id=42&url=https%3A%2F%2Fcdn.example.com%2Fgame.7z&file_name=game.7z&archive_format=7z&size=123&bgm_id=123&vndb_id=v456&hikarinagi_id=789&archive_password=not-stored&title=Test").unwrap();
        let (_, _, _, details) = parse_shionlib_install_request(url).unwrap();
        assert_eq!(details.resource_id, "42");
        assert_eq!(details.archive_format, "7z");
        assert_eq!(details.metadata.bgm_id.as_deref(), Some("123"));
        assert_eq!(details.metadata.vndb_id.as_deref(), Some("v456"));
        assert_eq!(details.metadata.hikarinagi_id.as_deref(), Some("789"));
    }
}
