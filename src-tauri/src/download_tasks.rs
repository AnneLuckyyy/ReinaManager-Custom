//! 当前改版的受控下载任务。
//!
//! 普通任务只下载到用户明确设置的游戏下载目录；Shionlib 安装任务在用户
//! 确认来源后，可继续解压并整理到其已确认的游戏安装目录，但绝不执行其中内容。

use crate::database::dto::InsertGameData;
use crate::database::repository::{
    games_repository::GamesRepository, settings_repository::DbSettingsExt,
};
use crate::entity::{bgm_data::BgmData, custom_data::CustomData, games, tasks, user};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use parking_lot::Mutex;
use percent_encoding::percent_decode_str;
use reina_download::{
    CancellationToken, DownloadOptions, DownloadRequest, Outcome, Progress, adopt_legacy_prefix,
    artifact_paths, control_path, download,
};
use reqwest::{
    header::{ETAG, LAST_MODIFIED},
    redirect::Policy,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sevenz_rust2::{
    Archive, ArchiveEntry, Error as SevenZError, Password, decompress_with_extract_fn,
    decompress_with_extract_fn_and_password,
};
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::{io::AsyncWriteExt, sync::watch};
use url::Url;
use walkdir::WalkDir;

const MAX_CONCURRENT_DOWNLOADS: usize = 1;
const PROGRESS_WRITE_INTERVAL: Duration = Duration::from_millis(500);
const CHECKSUM_FAILURE_PREFIX: &str = "来源校验失败：";
const SOURCE_CHANGED_FAILURE_PREFIX: &str = "来源文件已变化：";
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const STAGING_SUFFIX: &str = ".staging";
pub(crate) const TASK_KIND_DOWNLOAD: &str = "download";
pub(crate) const TASK_KIND_SHIONLIB_INSTALL: &str = "shionlib_install";
const INSTALL_STAGE_DOWNLOADING: &str = "downloading";
const INSTALL_STAGE_EXTRACTING: &str = "extracting";
const INSTALL_STAGE_ORGANIZING: &str = "organizing";
const INSTALL_STAGE_SCANNING: &str = "scanning";
const INSTALL_STAGE_MATCHING_METADATA: &str = "matching_metadata";
const INSTALL_STAGE_INSTALLED_PENDING_IMPORT: &str = "installed_pending_import";
const INSTALL_STAGE_IMPORTED: &str = "imported";
const INSTALL_ERROR_ARCHIVE: &str = "archive_extract_failed";
const INSTALL_ERROR_ORGANIZING: &str = "install_organize_failed";
const INSTALL_ERROR_SCAN: &str = "executable_scan_failed";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ShionlibInstallResult {
    version: u8,
    install_path: String,
    file_count: i64,
    source_staging_retained: bool,
    #[serde(default)]
    executable_candidates: Vec<String>,
    #[serde(default)]
    selected_executable: Option<String>,
    #[serde(default)]
    metadata_match: Option<ShionlibMetadataMatch>,
    #[serde(default)]
    imported_game_id: Option<i32>,
    #[serde(default)]
    created_new_game: Option<bool>,
}

/// 仅记录安装任务与现有未安装资料的只读比对结果；不会在此阶段创建或改写游戏。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct ShionlibMetadataMatch {
    version: u8,
    state: String,
    #[serde(default)]
    game_id: Option<i32>,
    #[serde(default)]
    matched_by: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct MetadataSourceMatches {
    eligible_game_ids: Vec<i32>,
    already_installed_game_ids: Vec<i32>,
}

/// 只保存可用于后续资料匹配的来源标识；不含下载地址、密码或账户信息。
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub(crate) struct ShionlibMetadataHints {
    pub bgm_id: Option<String>,
    pub vndb_id: Option<String>,
    pub hikarinagi_id: Option<String>,
}

/// 已经由协议层验证、可写入安装任务的非敏感来源信息。
#[derive(Clone, Debug)]
pub(crate) struct ShionlibInstallTaskDetails {
    pub resource_id: String,
    pub archive_format: String,
    pub metadata: ShionlibMetadataHints,
}

#[derive(Clone, Debug)]
pub(crate) struct RemoteChecksum {
    algorithm: String,
    value: String,
}

pub(crate) fn checksum_from_shionlib(
    algorithm: &str,
    hexadecimal_value: &str,
) -> Result<RemoteChecksum, String> {
    let algorithm = algorithm.to_ascii_lowercase();
    if !matches!(algorithm.as_str(), "sha256" | "blake3")
        || hexadecimal_value.len() != 64
        || !hexadecimal_value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Shionlib 来源校验信息无效".to_string());
    }
    if algorithm == "blake3" {
        return Ok(RemoteChecksum {
            algorithm,
            value: hexadecimal_value.to_ascii_lowercase(),
        });
    }
    let bytes = hexadecimal_value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(|| "Shionlib 来源校验信息无效".to_string())?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(|| "Shionlib 来源校验信息无效".to_string())?;
            Ok((high * 16 + low) as u8)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(RemoteChecksum {
        algorithm,
        value: STANDARD.encode(bytes),
    })
}

#[derive(Clone, Debug)]
struct RemoteFileInfo {
    total: i64,
    file_name: String,
    checksum: Option<RemoteChecksum>,
    etag: Option<String>,
    last_modified: Option<String>,
}

fn https_only_redirects() -> Policy {
    Policy::custom(|attempt| {
        if attempt.url().scheme() == "https" {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

/// 下载器只读取当前用户已启用的静态 Windows 代理；不保存、修改或读取 PAC。
fn build_download_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().redirect(https_only_redirects());
    if let Some(proxy_url) = crate::utils::system_proxy::get_windows_system_proxy() {
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|error| format!("系统代理地址无效: {error}"))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|error| format!("创建下载请求失败: {error}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskControl {
    Running,
    Pause,
    Cancel,
}

#[derive(Default)]
pub struct DownloadTaskState {
    running: Mutex<HashMap<i64, watch::Sender<TaskControl>>>,
    importing_games: Mutex<HashSet<i64>>,
}

impl DownloadTaskState {
    fn start(&self, task_id: i64) -> Result<watch::Receiver<TaskControl>, String> {
        let mut running = self.running.lock();
        if running.contains_key(&task_id) {
            return Err("下载任务已经在运行".to_string());
        }
        if running.len() >= MAX_CONCURRENT_DOWNLOADS {
            return Err("已有下载任务正在进行，请等待或暂停后再继续".to_string());
        }
        let (sender, receiver) = watch::channel(TaskControl::Running);
        running.insert(task_id, sender);
        Ok(receiver)
    }

    fn begin_game_import(&self, task_id: i64) -> Result<(), String> {
        let mut importing_games = self.importing_games.lock();
        if !importing_games.insert(task_id) {
            return Err("该安装任务正在添加到游戏库".to_string());
        }
        Ok(())
    }

    fn finish_game_import(&self, task_id: i64) {
        self.importing_games.lock().remove(&task_id);
    }

    fn request(&self, task_id: i64, control: TaskControl) -> bool {
        self.running
            .lock()
            .get(&task_id)
            .is_some_and(|sender| sender.send(control).is_ok())
    }

    fn finish(&self, task_id: i64) {
        self.running.lock().remove(&task_id);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDownloadTaskData {
    pub title: String,
    pub url: String,
}

fn validate_request(data: &CreateDownloadTaskData) -> Result<Url, String> {
    if data.title.trim().is_empty() || data.title.trim().len() > 200 {
        return Err("任务名称不能为空且不能超过 200 个字符".to_string());
    }
    let url = Url::parse(data.url.trim()).map_err(|_| "下载地址无效".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("下载地址仅支持带主机名的 HTTPS 地址".to_string());
    }
    Ok(url)
}

fn download_path(task: &tasks::Model) -> PathBuf {
    PathBuf::from(&task.root_path).join(format!(".reina-task-{}.download", task.id))
}

fn completed_path(task: &tasks::Model) -> Option<PathBuf> {
    let file_name = task.file_name.as_deref()?;
    if sanitize_file_name(file_name, "download.bin") != file_name {
        return None;
    }
    Some(PathBuf::from(&task.root_path).join(file_name))
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadArchiveInspection {
    pub archive_format: String,
    pub is_multipart: bool,
    pub part_index: Option<i64>,
    pub password_status: String,
    pub readable: bool,
    pub entry_count: Option<i64>,
    pub unpacked_size: Option<i64>,
    pub has_staging: bool,
    pub note: String,
}

fn archive_format_and_part_index(file_name: &str) -> Option<(&'static str, Option<i64>)> {
    let lower = file_name.to_ascii_lowercase();
    for format in ["7z", "zip", "rar"] {
        let marker = format!(".{format}.");
        if let Some((_, raw_part)) = lower.rsplit_once(&marker)
            && !raw_part.is_empty()
            && raw_part.bytes().all(|byte| byte.is_ascii_digit())
        {
            let part_index = raw_part.parse::<i64>().ok().filter(|index| *index > 0)?;
            return Some((format, Some(part_index)));
        }
        if lower.ends_with(&format!(".{format}")) {
            return Some((format, None));
        }
    }
    for format in ["tar.gz", "tar.bz2", "tar.xz", "tar.zst", "tar"] {
        if lower.ends_with(&format!(".{format}")) {
            return Some((format, None));
        }
    }
    None
}

fn inspect_7z_archive(
    archive_path: &Path,
    archive_format: String,
    part_index: Option<i64>,
) -> DownloadArchiveInspection {
    match Archive::open(archive_path) {
        Ok(archive) => {
            let entry_count = i64::try_from(archive.files.len()).ok();
            let unpacked_size = archive
                .files
                .iter()
                .filter(|entry| entry.has_stream)
                .try_fold(0_u64, |total, entry| total.checked_add(entry.size))
                .and_then(|total| i64::try_from(total).ok());
            let requires_password = archive
                .blocks
                .iter()
                .flat_map(|block| &block.coders)
                .any(|coder| coder.encoder_method_id() == [0x06, 0xF1, 0x07, 0x01]);
            DownloadArchiveInspection {
                archive_format,
                is_multipart: part_index.is_some(),
                part_index,
                password_status: if requires_password {
                    "required".to_string()
                } else {
                    "not_required".to_string()
                },
                readable: true,
                entry_count,
                unpacked_size,
                has_staging: false,
                note: "本次仅读取压缩包目录，不会解压、修改文件或保存密码。".to_string(),
            }
        }
        Err(SevenZError::PasswordRequired | SevenZError::MaybeBadPassword(_)) => {
            DownloadArchiveInspection {
                archive_format,
                is_multipart: part_index.is_some(),
                part_index,
                password_status: "required".to_string(),
                readable: false,
                entry_count: None,
                unpacked_size: None,
                has_staging: false,
                note: "压缩包需要密码才能读取目录；本轮不会索取、传输或保存密码。".to_string(),
            }
        }
        Err(_) => DownloadArchiveInspection {
            archive_format,
            is_multipart: part_index.is_some(),
            part_index,
            password_status: "unknown".to_string(),
            readable: false,
            entry_count: None,
            unpacked_size: None,
            has_staging: false,
            note: "无法安全读取 7z 目录：文件可能损坏、分卷不完整或使用了当前读取器不支持的方式。"
                .to_string(),
        },
    }
}

fn inspect_completed_archive_file(
    archive_path: &Path,
    file_name: &str,
) -> Result<DownloadArchiveInspection, String> {
    let (archive_format, part_index) = archive_format_and_part_index(file_name)
        .ok_or_else(|| "完成文件不是可识别的压缩包格式".to_string())?;
    if archive_format != "7z" {
        return Ok(DownloadArchiveInspection {
            archive_format: archive_format.to_string(),
            is_multipart: part_index.is_some(),
            part_index,
            password_status: "unknown".to_string(),
            readable: false,
            entry_count: None,
            unpacked_size: None,
            has_staging: false,
            note: "当前仅安全读取 7z 目录；此格式已识别，但暂不解析、不解压，也不会调用系统或第三方解压程序。".to_string(),
        });
    }
    Ok(inspect_7z_archive(
        archive_path,
        archive_format.to_string(),
        part_index,
    ))
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadArchiveStagingResult {
    pub staging_name: String,
    pub entry_count: i64,
    pub unpacked_size: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadArchiveMoveResult {
    pub target_folder_name: String,
    pub target_path: String,
    pub file_count: i64,
    pub source_staging_retained: bool,
}

#[derive(Clone, Debug)]
struct StagingEntry {
    relative_path: PathBuf,
    is_directory: bool,
    size: u64,
}

fn staging_path(task: &tasks::Model) -> PathBuf {
    PathBuf::from(&task.root_path).join(format!(".reina-task-{}{}", task.id, STAGING_SUFFIX))
}

fn install_staging_path(task: &tasks::Model, install_root: &Path) -> PathBuf {
    install_root.join(format!(".reina-install-task-{}{}", task.id, STAGING_SUFFIX))
}

#[cfg(target_os = "windows")]
fn available_space(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{Win32::Storage::FileSystem::GetDiskFreeSpaceExW, core::PCWSTR};

    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available = 0_u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide_path.as_ptr()), Some(&mut available), None, None) }
        .map_err(|error| format!("无法读取游戏下载目录的可用空间: {error}"))?;
    Ok(available)
}

#[cfg(not(target_os = "windows"))]
fn available_space(_path: &Path) -> Result<u64, String> {
    Err("当前平台无法安全读取游戏下载目录的可用空间".to_string())
}

fn validate_target_folder_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty()
        || name.len() > 120
        || matches!(name, "." | "..")
        || name.contains(['/', '\\', ':'])
        || name.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err("目标游戏文件夹名称无效".to_string());
    }
    let upper = name.trim_end_matches([' ', '.']).to_ascii_uppercase();
    let reserved_stem = upper.split('.').next().unwrap_or_default();
    if upper.is_empty()
        || matches!(
            reserved_stem,
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
    {
        return Err("目标游戏文件夹名称不能使用 Windows 保留名".to_string());
    }
    Ok(name.to_string())
}

fn validate_existing_directory(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label}必须是绝对路径"));
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("读取{label}失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label}不是安全目录"));
    }
    Ok(())
}

fn safe_staging_relative_path(path: &Path) -> Result<PathBuf, String> {
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(name) if !name.is_empty() => relative.push(name),
            _ => return Err("临时解压区包含不安全路径".to_string()),
        }
    }
    if relative.as_os_str().is_empty() {
        return Err("临时解压区包含不安全路径".to_string());
    }
    Ok(relative)
}

fn scan_staging_entries(staging: &Path) -> Result<(Vec<StagingEntry>, u64, i64), String> {
    let mut entries = Vec::new();
    let mut total_size = 0_u64;
    let mut file_count = 0_i64;
    for entry in WalkDir::new(staging).min_depth(1).follow_links(false) {
        let entry = entry.map_err(|error| format!("读取临时解压区失败: {error}"))?;
        let file_type = entry.file_type();
        if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
            return Err("临时解压区包含不安全链接或特殊文件".to_string());
        }
        let relative = entry
            .path()
            .strip_prefix(staging)
            .map_err(|_| "临时解压区路径无效".to_string())?;
        let relative_path = safe_staging_relative_path(relative)?;
        let size = if file_type.is_file() {
            let size = entry
                .metadata()
                .map_err(|error| format!("读取临时解压文件失败: {error}"))?
                .len();
            total_size = total_size
                .checked_add(size)
                .ok_or_else(|| "临时解压区大小计算溢出".to_string())?;
            file_count = file_count
                .checked_add(1)
                .ok_or_else(|| "临时解压区文件数量过多".to_string())?;
            size
        } else {
            0
        };
        if entries.len() >= MAX_ARCHIVE_ENTRIES {
            return Err("临时解压区条目过多，已拒绝移动".to_string());
        }
        entries.push(StagingEntry {
            relative_path,
            is_directory: file_type.is_dir(),
            size,
        });
    }
    Ok((entries, total_size, file_count))
}

fn create_target_transfer_directory(parent: &Path, task_id: i64) -> Result<PathBuf, String> {
    let now = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    for index in 0..128 {
        let candidate = parent.join(format!(".reina-transfer-{task_id}-{now}-{index}.staging"));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建目标临时目录失败: {error}")),
        }
    }
    Err("无法创建唯一的目标临时目录".to_string())
}

fn copy_staging_entries(
    staging: &Path,
    transfer: &Path,
    entries: &[StagingEntry],
) -> Result<(), String> {
    for entry in entries.iter().filter(|entry| entry.is_directory) {
        fs::create_dir_all(transfer.join(&entry.relative_path))
            .map_err(|error| format!("创建目标子目录失败: {error}"))?;
    }
    for entry in entries.iter().filter(|entry| !entry.is_directory) {
        let source = staging.join(&entry.relative_path);
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("读取临时解压文件失败: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != entry.size
        {
            return Err("临时解压区在移动过程中发生变化，已停止".to_string());
        }
        let destination = transfer.join(&entry.relative_path);
        let parent = destination
            .parent()
            .ok_or_else(|| "目标文件没有安全父目录".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建目标目录失败: {error}"))?;
        let mut source_file =
            fs::File::open(&source).map_err(|error| format!("读取临时解压文件失败: {error}"))?;
        let mut destination_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| format!("创建目标文件失败: {error}"))?;
        let copied = std::io::copy(&mut source_file, &mut destination_file)
            .map_err(|error| format!("复制临时解压文件失败: {error}"))?;
        destination_file
            .flush()
            .map_err(|error| format!("写入目标文件失败: {error}"))?;
        if copied != entry.size {
            return Err("临时解压文件大小在移动过程中发生变化，已停止".to_string());
        }
    }
    Ok(())
}

fn is_cross_device_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(17) | Some(18))
}

fn move_staging_to_target(
    task: &tasks::Model,
    target_parent: &Path,
    target_folder_name: &str,
) -> Result<DownloadArchiveMoveResult, String> {
    move_staging_directory_to_target(
        &staging_path(task),
        target_parent,
        target_folder_name,
        task.id,
        "临时解压区",
    )
}

fn move_staging_directory_to_target(
    staging: &Path,
    target_parent: &Path,
    target_folder_name: &str,
    task_id: i64,
    staging_label: &str,
) -> Result<DownloadArchiveMoveResult, String> {
    validate_existing_directory(target_parent, "目标父目录")?;
    let target_name = validate_target_folder_name(target_folder_name)?;
    let metadata = fs::symlink_metadata(staging)
        .map_err(|error| format!("读取{staging_label}失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{staging_label}不是安全目录，已拒绝移动"));
    }
    if target_parent.starts_with(staging) {
        return Err(format!("目标目录不能位于{staging_label}内"));
    }
    let target = target_parent.join(&target_name);
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err("目标游戏文件夹已存在，已拒绝覆盖".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("检查目标游戏文件夹失败: {error}")),
    }
    let (entries, total_size, file_count) = scan_staging_entries(staging)?;
    match fs::rename(staging, &target) {
        Ok(()) => {
            return Ok(DownloadArchiveMoveResult {
                target_folder_name: target_name,
                target_path: target.to_string_lossy().to_string(),
                file_count,
                source_staging_retained: false,
            });
        }
        Err(error) if !is_cross_device_error(&error) => {
            return Err(format!("移动临时解压区失败: {error}"));
        }
        Err(_) => {}
    }
    let safety_margin = std::cmp::max(64 * 1024 * 1024, total_size / 20);
    let required = total_size
        .checked_add(safety_margin)
        .ok_or_else(|| "目标目录所需空间过大".to_string())?;
    let available = available_space(target_parent)?;
    if available < required {
        return Err(format!(
            "目标父目录可用空间不足：至少需要 {} MiB，当前仅有 {} MiB",
            required.div_ceil(1024 * 1024),
            available / (1024 * 1024)
        ));
    }
    let transfer = create_target_transfer_directory(target_parent, task_id)?;
    let transfer_result = copy_staging_entries(staging, &transfer, &entries);
    if let Err(error) = transfer_result {
        let cleanup_result = fs::remove_dir_all(&transfer);
        return match cleanup_result {
            Ok(()) => Err(format!("跨盘复制失败，已清理目标临时目录: {error}")),
            Err(cleanup_error) => Err(format!(
                "跨盘复制失败，原临时解压区仍保留；目标临时目录清理失败: {cleanup_error}"
            )),
        };
    }
    if let Err(error) = fs::rename(&transfer, &target) {
        let cleanup_result = fs::remove_dir_all(&transfer);
        return match cleanup_result {
            Ok(()) => Err(format!(
                "发布目标游戏文件夹失败，已清理目标临时目录: {error}"
            )),
            Err(cleanup_error) => Err(format!(
                "发布目标游戏文件夹失败，原临时解压区仍保留；目标临时目录清理失败: {cleanup_error}"
            )),
        };
    }
    let source_staging_retained = fs::remove_dir_all(staging).is_err();
    Ok(DownloadArchiveMoveResult {
        target_folder_name: target_name,
        target_path: target.to_string_lossy().to_string(),
        file_count,
        source_staging_retained,
    })
}

fn automatic_install_folder_base(task: &tasks::Model) -> String {
    let sanitized = task
        .title
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim().trim_end_matches([' ', '.']);
    let candidate = trimmed.chars().take(100).collect::<String>();
    validate_target_folder_name(&candidate).unwrap_or_else(|_| format!("Game {}", task.id))
}

fn reserve_install_folder_name(install_root: &Path, task: &tasks::Model) -> Result<String, String> {
    let base = automatic_install_folder_base(task);
    for index in 1..=10_000 {
        let candidate = if index == 1 {
            base.clone()
        } else {
            let suffix = format!(" ({index})");
            let available = 120_usize.saturating_sub(suffix.len());
            format!(
                "{}{}",
                base.chars().take(available).collect::<String>(),
                suffix
            )
        };
        let candidate = validate_target_folder_name(&candidate)?;
        match fs::symlink_metadata(install_root.join(&candidate)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => return Err(format!("检查游戏安装目录失败: {error}")),
        }
    }
    Err("无法为安装任务保留唯一游戏文件夹名称".to_string())
}

fn single_install_payload_directory(staging: &Path) -> Result<Option<PathBuf>, String> {
    let entries =
        fs::read_dir(staging).map_err(|error| format!("读取安装临时目录失败: {error}"))?;
    let entries = entries
        .map(|entry| entry.map_err(|error| format!("读取安装临时目录失败: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    if entries.len() != 1 {
        return Ok(None);
    }
    let entry = &entries[0];
    let metadata =
        fs::symlink_metadata(entry.path()).map_err(|error| format!("读取安装内容失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(None);
    }
    Ok(Some(entry.path()))
}

fn move_install_staging_to_target(
    task: &tasks::Model,
    install_root: &Path,
) -> Result<DownloadArchiveMoveResult, String> {
    let staging = install_staging_path(task, install_root);
    let payload = single_install_payload_directory(&staging)?.unwrap_or_else(|| staging.clone());
    let target_name = reserve_install_folder_name(install_root, task)?;
    let result = move_staging_directory_to_target(
        &payload,
        install_root,
        &target_name,
        task.id,
        "安装临时目录",
    )?;
    if payload != staging {
        match fs::remove_dir(&staging) {
            Ok(()) => {}
            Err(_error) => {
                return Ok(DownloadArchiveMoveResult {
                    source_staging_retained: true,
                    ..result
                });
            }
        }
    }
    Ok(result)
}

fn path_comparison_key(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_string_lossy().to_string()
    }
}

fn validate_game_title(value: &str) -> Result<String, String> {
    let title = value.trim();
    if title.is_empty() || title.chars().count() > 200 || title.chars().any(char::is_control) {
        return Err("游戏名称不能为空、不能超过 200 个字符且不能包含控制字符".to_string());
    }
    Ok(title.to_string())
}

fn validate_regular_game_executable(
    target_directory: &Path,
    executable_path: &Path,
) -> Result<PathBuf, String> {
    validate_existing_directory(target_directory, "目标游戏目录")?;
    if !executable_path.is_absolute() {
        return Err("游戏启动程序必须是绝对路径".to_string());
    }
    if executable_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
    {
        return Err("请选择目标游戏目录内的 .exe 启动程序".to_string());
    }
    let metadata = fs::symlink_metadata(executable_path)
        .map_err(|error| format!("读取游戏启动程序失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("游戏启动程序不是安全的普通文件".to_string());
    }
    let target_directory = fs::canonicalize(target_directory)
        .map_err(|error| format!("解析目标游戏目录失败: {error}"))?;
    let executable = fs::canonicalize(executable_path)
        .map_err(|error| format!("解析游戏启动程序失败: {error}"))?;
    if !executable.starts_with(&target_directory) {
        return Err("启动程序不在已移动的目标游戏目录内".to_string());
    }
    Ok(executable)
}

const EXCLUDED_INSTALL_EXE_PATTERNS: &[&str] = &[
    "unins",
    "uninst",
    "uninstall",
    "setup",
    "install",
    "dxsetup",
    "vcredist",
    "vc_redist",
    "dotnetfx",
    "oalinst",
    "crashhandler",
    "crash_handler",
    "crashreport",
    "crash_report",
    "bugreport",
    "bug_report",
    "unitycrashandler",
];

fn scan_install_executable_candidates(install_path: &Path) -> Result<Vec<String>, String> {
    validate_existing_directory(install_path, "已整理的游戏目录")?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(install_path).map_err(|error| format!("读取游戏目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取游戏目录项失败: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取游戏目录项类型失败: {error}"))?;
        if file_type.is_symlink()
            || !file_type.is_file()
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
        {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let lower = file_name.to_ascii_lowercase();
        if EXCLUDED_INSTALL_EXE_PATTERNS
            .iter()
            .any(|pattern| lower.contains(pattern))
        {
            continue;
        }
        candidates.push(file_name);
    }
    let game_name = install_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    candidates.sort_by_cached_key(|candidate| {
        let lower = candidate.to_ascii_lowercase();
        (
            lower.contains("startup"),
            !(lower.contains("chs") || lower.contains("cn")),
            !game_name.is_empty() && !lower.contains(&game_name),
            candidate.len(),
            lower,
        )
    });
    Ok(candidates)
}

fn stored_game_uses_path(game: &games::Model, executable_key: &str) -> bool {
    let primary_matches = game
        .localpath
        .as_deref()
        .is_some_and(|path| path_comparison_key(Path::new(path)) == executable_key);
    primary_matches
        || game
            .custom_data
            .as_ref()
            .and_then(|custom_data| custom_data.extra_local_paths.as_ref())
            .is_some_and(|paths| {
                paths
                    .iter()
                    .any(|path| path_comparison_key(Path::new(path)) == executable_key)
            })
}

fn safe_archive_relative_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim_end_matches(['/', '\\']);
    if trimmed.is_empty()
        || trimmed.starts_with(['/', '\\'])
        || trimmed.contains(':')
        || trimmed.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err("压缩包包含不安全路径".to_string());
    }
    let mut result = PathBuf::new();
    for part in trimmed.split(['/', '\\']) {
        if part.is_empty() || matches!(part, "." | "..") {
            return Err("压缩包包含不安全路径".to_string());
        }
        result.push(part);
    }
    Ok(result)
}

fn preflight_7z_archive(archive_path: &Path, password: &str) -> Result<(i64, i64), String> {
    let archive =
        Archive::open_with_password(archive_path, &Password::from(password)).map_err(|error| {
            match error {
                SevenZError::PasswordRequired | SevenZError::MaybeBadPassword(_) => {
                    "压缩包密码无效或需要密码".to_string()
                }
                _ => "无法安全读取 7z 压缩包目录".to_string(),
            }
        })?;
    if archive.files.len() > MAX_ARCHIVE_ENTRIES {
        return Err("压缩包条目过多，已拒绝解压".to_string());
    }
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for entry in &archive.files {
        if entry.is_anti_item
            || (entry.has_windows_attributes && entry.windows_attributes & 0x400 != 0)
        {
            return Err("压缩包包含不安全的链接或删除条目".to_string());
        }
        let path = safe_archive_relative_path(&entry.name)?;
        let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
        if !paths.insert(normalized) {
            return Err("压缩包包含会互相覆盖的重复路径".to_string());
        }
        if entry.has_stream {
            total = total
                .checked_add(entry.size)
                .ok_or_else(|| "压缩包解压空间计算溢出".to_string())?;
        }
    }
    Ok((
        i64::try_from(archive.files.len()).map_err(|_| "压缩包条目过多".to_string())?,
        i64::try_from(total).map_err(|_| "压缩包预计解压空间过大".to_string())?,
    ))
}

fn safe_extract_entry(
    staging: &Path,
    entry: &ArchiveEntry,
    reader: &mut dyn Read,
) -> Result<bool, SevenZError> {
    let relative = safe_archive_relative_path(&entry.name).map_err(std::io::Error::other)?;
    let output = staging.join(relative);
    if entry.is_directory {
        fs::create_dir_all(output)?;
        return Ok(true);
    }
    let parent = output
        .parent()
        .ok_or_else(|| std::io::Error::other("压缩包文件没有安全父目录"))?;
    fs::create_dir_all(parent)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)?;
    std::io::copy(reader, &mut file)?;
    file.flush()?;
    Ok(true)
}

fn extract_7z_to_staging(
    archive_path: &Path,
    staging: &Path,
    password: &str,
) -> Result<(i64, i64), String> {
    let (entry_count, unpacked_size) = preflight_7z_archive(archive_path, password)?;
    let parent = staging
        .parent()
        .ok_or_else(|| "无法确定临时解压目录位置".to_string())?;
    let unpacked =
        u64::try_from(unpacked_size).map_err(|_| "压缩包预计解压空间无效".to_string())?;
    let safety_margin = std::cmp::max(64 * 1024 * 1024, unpacked / 20);
    let required = unpacked
        .checked_add(safety_margin)
        .ok_or_else(|| "压缩包预计解压空间过大".to_string())?;
    let available = available_space(parent)?;
    if available < required {
        return Err(format!(
            "游戏下载目录可用空间不足：安全解压至少需要 {} MiB，当前仅有 {} MiB",
            required.div_ceil(1024 * 1024),
            available / (1024 * 1024)
        ));
    }
    fs::create_dir(staging).map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => {
            "该任务已有临时解压区，请先完成或清理后再试".to_string()
        }
        _ => format!("创建临时解压区失败: {error}"),
    })?;
    let extraction = (|| -> Result<(), SevenZError> {
        let source = fs::File::open(archive_path)?;
        if password.is_empty() {
            decompress_with_extract_fn(source, staging, |entry, reader, _| {
                safe_extract_entry(staging, entry, reader)
            })
        } else {
            decompress_with_extract_fn_and_password(
                source,
                staging,
                Password::from(password),
                |entry, reader, _| safe_extract_entry(staging, entry, reader),
            )
        }
    })();
    if let Err(error) = extraction {
        let _ = fs::remove_dir_all(staging);
        return Err(format!("解压失败，已清理本次临时区: {error}"));
    }
    Ok((entry_count, unpacked_size))
}

fn trim_filename(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn sanitize_file_name(value: &str, fallback: &str) -> String {
    let raw_name = value.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    let mut name: String = raw_name
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect();
    name = name.trim().trim_matches('.').to_string();
    if name.is_empty() || name == "." || name == ".." {
        name = fallback.to_string();
    }
    if Path::new(&name).extension().is_none() {
        name.push_str(".bin");
    }
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        name.insert(0, '_');
    }
    trim_filename(&name, 120)
}

fn filename_with_suffix(file_name: &str, suffix: i64) -> String {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    let suffix = format!(" ({suffix})");
    let extension_text = extension
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let available =
        120usize.saturating_sub(suffix.chars().count() + extension_text.chars().count());
    format!(
        "{}{}{}",
        trim_filename(stem, available),
        suffix,
        extension_text
    )
}

async fn reserve_file_name(
    db: &DatabaseConnection,
    root_path: &str,
    requested: &str,
    task_id: i64,
) -> Result<String, String> {
    let base = sanitize_file_name(requested, "download.bin");
    let tasks_in_root = tasks::Entity::find()
        .filter(tasks::Column::RootPath.eq(root_path))
        .all(db)
        .await
        .map_err(|error| format!("读取下载任务失败: {error}"))?;
    for candidate in std::iter::once(base.clone())
        .chain((1..100).map(|offset| filename_with_suffix(&base, task_id + offset)))
    {
        let used_by_task = tasks_in_root.iter().any(|task| {
            task.id != task_id
                && task
                    .file_name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&candidate))
        });
        let exists = tokio::fs::try_exists(PathBuf::from(root_path).join(&candidate))
            .await
            .map_err(|error| format!("检查下载目标文件失败: {error}"))?;
        if !used_by_task && !exists {
            return Ok(candidate);
        }
    }
    Err("下载目录中存在过多同名文件，请先整理后重试".to_string())
}

fn parse_content_disposition_filename(value: &str) -> Option<String> {
    let mut fallback = None;
    for part in value.split(';').skip(1) {
        let Some((key, raw_value)) = part.trim().split_once('=') else {
            continue;
        };
        let raw_value = raw_value.trim().trim_matches('"');
        if key.trim().eq_ignore_ascii_case("filename*") {
            let encoded = raw_value
                .split_once("''")
                .map(|(_, value)| value)
                .unwrap_or(raw_value);
            if let Ok(decoded) = percent_decode_str(encoded).decode_utf8() {
                return Some(decoded.into_owned());
            }
        }
        if key.trim().eq_ignore_ascii_case("filename") && !raw_value.is_empty() {
            fallback = Some(raw_value.replace("\\\"", "\""));
        }
    }
    fallback
}

fn filename_from_response(response: &reqwest::Response) -> String {
    let from_header = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_disposition_filename);
    let from_url = response
        .url()
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .and_then(|segment| percent_decode_str(segment).decode_utf8().ok())
        .map(|value| value.into_owned());
    sanitize_file_name(
        from_header
            .or(from_url)
            .as_deref()
            .unwrap_or("download.bin"),
        "download.bin",
    )
}

fn parse_digest_value(value: &str) -> Option<RemoteChecksum> {
    for item in value.split(',') {
        let (raw_algorithm, raw_value) = item.trim().split_once('=')?;
        let algorithm = match raw_algorithm.trim().to_ascii_lowercase().as_str() {
            "sha-256" => "sha256",
            "sha-512" => "sha512",
            _ => continue,
        };
        let encoded = raw_value.trim().trim_matches('"').trim_matches(':');
        let decoded = STANDARD.decode(encoded).ok()?;
        let expected_len = if algorithm == "sha256" { 32 } else { 64 };
        if decoded.len() == expected_len {
            return Some(RemoteChecksum {
                algorithm: algorithm.to_string(),
                value: STANDARD.encode(decoded),
            });
        }
    }
    None
}

fn checksum_from_response(response: &reqwest::Response) -> Option<RemoteChecksum> {
    ["content-digest", "digest"]
        .into_iter()
        .filter_map(|name| response.headers().get(name))
        .filter_map(|value| value.to_str().ok())
        .find_map(parse_digest_value)
}

pub(crate) async fn find_task(
    db: &DatabaseConnection,
    task_id: i64,
) -> Result<tasks::Model, String> {
    tasks::Entity::find_by_id(task_id)
        .one(db)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "下载任务不存在".to_string())
}

async fn update_task(
    db: &DatabaseConnection,
    task: tasks::Model,
    status: Option<&str>,
    progress: Option<i64>,
    error_message: Option<Option<String>>,
) -> Result<tasks::Model, String> {
    let mut active: tasks::ActiveModel = task.into();
    if let Some(status) = status {
        active.status = Set(status.to_string());
    }
    if let Some(progress) = progress {
        active.progress_current = Set(progress);
    }
    if let Some(error_message) = error_message {
        active.error_message = Set(error_message);
    }
    active.updated_at = Set(chrono::Utc::now().timestamp());
    active.update(db).await.map_err(|error| error.to_string())
}

async fn update_task_file_details(
    db: &DatabaseConnection,
    task: tasks::Model,
    file_name: Option<String>,
    checksum: Option<RemoteChecksum>,
    etag: Option<String>,
    last_modified: Option<String>,
) -> Result<tasks::Model, String> {
    let mut active: tasks::ActiveModel = task.into();
    active.file_name = Set(file_name);
    active.checksum_algorithm = Set(checksum.as_ref().map(|value| value.algorithm.clone()));
    active.checksum_value = Set(checksum.map(|value| value.value));
    active.remote_etag = Set(etag);
    active.remote_last_modified = Set(last_modified);
    active.updated_at = Set(chrono::Utc::now().timestamp());
    active.update(db).await.map_err(|error| error.to_string())
}

async fn update_task_file_name(
    db: &DatabaseConnection,
    task: tasks::Model,
    file_name: String,
) -> Result<tasks::Model, String> {
    let mut active: tasks::ActiveModel = task.into();
    active.file_name = Set(Some(file_name));
    active.updated_at = Set(chrono::Utc::now().timestamp());
    active.update(db).await.map_err(|error| error.to_string())
}

async fn mark_failed(db: &DatabaseConnection, task_id: i64, message: String) {
    if let Ok(task) = find_task(db, task_id).await {
        let _ = update_task(db, task, Some("failed"), None, Some(Some(message))).await;
    }
}

async fn update_install_task_state(
    db: &DatabaseConnection,
    task: tasks::Model,
    status: &str,
    stage: &str,
    error_code: Option<&str>,
    error_message: Option<String>,
    install_result: Option<String>,
) -> Result<tasks::Model, String> {
    let mut active: tasks::ActiveModel = task.into();
    active.status = Set(status.to_string());
    active.install_stage = Set(Some(stage.to_string()));
    active.error_code = Set(error_code.map(ToOwned::to_owned));
    active.error_message = Set(error_message);
    if let Some(install_result) = install_result {
        active.install_result_json = Set(Some(install_result));
    }
    active.updated_at = Set(chrono::Utc::now().timestamp());
    active.update(db).await.map_err(|error| error.to_string())
}

async fn begin_task_run(
    db: &DatabaseConnection,
    task: tasks::Model,
) -> Result<tasks::Model, String> {
    let is_shionlib_install = task.task_kind == TASK_KIND_SHIONLIB_INSTALL;
    let mut active: tasks::ActiveModel = task.into();
    active.status = Set("running".to_string());
    active.error_message = Set(None);
    if is_shionlib_install {
        active.error_code = Set(None);
    }
    active.updated_at = Set(chrono::Utc::now().timestamp());
    active.update(db).await.map_err(|error| error.to_string())
}

fn validate_root_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("游戏下载目录必须是绝对路径".to_string());
    }
    Ok(path)
}

async fn inspect_remote_file(url: &Url) -> Result<RemoteFileInfo, String> {
    let response = build_download_client()?
        .head(url.clone())
        .send()
        .await
        .map_err(|error| format!("无法读取下载文件信息: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载地址返回 HTTP {}", response.status()));
    }
    let total = response
        .content_length()
        .filter(|size| *size > 0 && *size <= i64::MAX as u64)
        .map(|size| size as i64)
        .ok_or_else(|| "下载地址没有提供可验证的文件大小，已拒绝创建任务".to_string())?;
    Ok(RemoteFileInfo {
        total,
        file_name: filename_from_response(&response),
        checksum: checksum_from_response(&response),
        etag: response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        last_modified: response
            .headers()
            .get(LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
    })
}

fn has_source_checksum(task: &tasks::Model) -> bool {
    task.checksum_algorithm.is_some() && task.checksum_value.is_some()
}

fn download_identity(task: &tasks::Model) -> Option<String> {
    task.checksum_algorithm
        .as_deref()
        .zip(task.checksum_value.as_deref())
        .map(|(algorithm, value)| format!("{}:{value}", algorithm.to_ascii_lowercase()))
}

async fn ensure_download_space(root_path: &Path, target: &Path, total: i64) -> Result<(), String> {
    let total = u64::try_from(total).map_err(|_| "下载文件大小无效".to_string())?;
    let existing = match tokio::fs::metadata(target).await {
        Ok(metadata) => metadata.len().min(total),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(format!("读取临时下载文件失败: {error}")),
    };
    let available = available_space(root_path)?;
    if available.saturating_add(existing) < total {
        return Err("游戏下载目录可用空间不足，已在开始下载前停止".to_string());
    }
    Ok(())
}

async fn remove_download_artifacts(task: &tasks::Model) -> Result<(), String> {
    for path in artifact_paths(&download_path(task)) {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("清理任务下载文件失败: {error}")),
        }
    }
    Ok(())
}

fn source_version_changed(task: &tasks::Model, remote: &RemoteFileInfo) -> bool {
    remote.total != task.progress_total
        || task
            .remote_etag
            .as_deref()
            .zip(remote.etag.as_deref())
            .is_some_and(|(stored, current)| stored != current)
        || task
            .remote_last_modified
            .as_deref()
            .zip(remote.last_modified.as_deref())
            .is_some_and(|(stored, current)| stored != current)
}

async fn check_resume_source(task: &tasks::Model) -> Result<Option<String>, String> {
    if task
        .source_expires_at
        .is_some_and(|expires_at| expires_at <= chrono::Utc::now().timestamp())
    {
        return Err("Shionlib 下载链接已过期，请返回网站重新选择资源".to_string());
    }
    let is_shionlib_task = task.source_expires_at.is_some();
    if has_source_checksum(task) && !is_shionlib_task {
        return Ok(None);
    }
    let temporary_path = download_path(task);
    let partial_length = match tokio::fs::metadata(&temporary_path).await {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(format!("读取临时下载文件失败: {error}")),
    };
    if partial_length == 0 && !is_shionlib_task {
        return Ok(None);
    }
    let url = Url::parse(&task.url).map_err(|_| "已保存的下载地址无效".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("已保存的下载地址不再是带主机名的 HTTPS 地址".to_string());
    }
    let remote = inspect_remote_file(&url).await?;
    if source_version_changed(task, &remote) {
        return Ok(Some(format!(
            "{SOURCE_CHANGED_FAILURE_PREFIX}继续前检测到来源文件的大小或版本标记已改变；临时文件已保留，请确认来源后点击“重新下载”"
        )));
    }
    Ok(None)
}

async fn verify_completed_file(task: &tasks::Model, path: PathBuf) -> Result<(), String> {
    let (Some(algorithm), Some(expected)) = (
        task.checksum_algorithm.as_deref(),
        task.checksum_value.as_deref(),
    ) else {
        return Ok(());
    };
    let algorithm = algorithm.to_string();
    let algorithm_for_hashing = algorithm.clone();
    let expected = expected.to_string();
    let actual = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let mut buffer = [0_u8; 1024 * 1024];
        match algorithm_for_hashing.as_str() {
            "sha256" => {
                let mut hasher = Sha256::new();
                loop {
                    let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
                    if count == 0 {
                        break;
                    }
                    hasher.update(&buffer[..count]);
                }
                Ok(STANDARD.encode(hasher.finalize()))
            }
            "sha512" => {
                let mut hasher = Sha512::new();
                loop {
                    let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
                    if count == 0 {
                        break;
                    }
                    hasher.update(&buffer[..count]);
                }
                Ok(STANDARD.encode(hasher.finalize()))
            }
            "blake3" => {
                let mut hasher = blake3::Hasher::new();
                loop {
                    let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
                    if count == 0 {
                        break;
                    }
                    hasher.update(&buffer[..count]);
                }
                Ok(hasher.finalize().to_hex().to_string())
            }
            _ => Err("不支持的来源校验算法".to_string()),
        }
    })
    .await
    .map_err(|error| format!("校验任务异常: {error}"))??;
    if actual != expected {
        return Err(format!(
            "{CHECKSUM_FAILURE_PREFIX}服务器提供的 {} 与下载文件不一致；文件已保留，请确认来源后点击“重新下载”",
            algorithm.to_ascii_uppercase()
        ));
    }
    Ok(())
}

fn completed_shionlib_archive_matches_declared_size(task: &tasks::Model) -> bool {
    if task.task_kind != TASK_KIND_SHIONLIB_INSTALL || task.progress_total <= 0 {
        return false;
    }
    let Some(path) = completed_path(task) else {
        return false;
    };
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_file()
        && !metadata.file_type().is_symlink()
        && metadata.len() == task.progress_total as u64
}

async fn completed_shionlib_archive_is_ready(task: &tasks::Model) -> Result<bool, String> {
    if !completed_shionlib_archive_matches_declared_size(task) {
        return Ok(false);
    }
    let archive_path =
        completed_path(task).ok_or_else(|| "已完成的 Shionlib 安装包路径无效".to_string())?;
    verify_completed_file(task, archive_path).await?;
    Ok(true)
}

async fn mark_shionlib_archive_ready(
    db: &DatabaseConnection,
    task: tasks::Model,
) -> Result<tasks::Model, String> {
    let total = task.progress_total;
    update_task(db, task, Some("running"), Some(total), Some(None)).await
}

async fn publish_completed_file(
    db: &DatabaseConnection,
    task: tasks::Model,
    temporary_path: &Path,
) -> Result<tasks::Model, String> {
    let Some(file_name) = task.file_name.as_deref() else {
        return Ok(task);
    };
    let reserved_name = reserve_file_name(db, &task.root_path, file_name, task.id).await?;
    let task = if reserved_name != file_name {
        update_task_file_name(db, task, reserved_name).await?
    } else {
        task
    };
    let destination =
        completed_path(&task).ok_or_else(|| "下载文件名不安全，已保留临时文件".to_string())?;
    match tokio::fs::hard_link(temporary_path, &destination).await {
        Ok(()) => tokio::fs::remove_file(temporary_path)
            .await
            .map_err(|error| format!("发布下载文件后清理临时文件失败: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err("下载目录中已有同名文件，已保留临时文件，请重新下载".to_string());
        }
        Err(_) => {
            let mut source = tokio::fs::File::open(temporary_path)
                .await
                .map_err(|error| format!("读取临时下载文件失败: {error}"))?;
            let mut destination_file = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&destination)
                .await
                .map_err(|error| format!("创建完成下载文件失败: {error}"))?;
            if let Err(error) = tokio::io::copy(&mut source, &mut destination_file).await {
                let _ = tokio::fs::remove_file(&destination).await;
                return Err(format!("发布下载文件失败: {error}"));
            }
            destination_file
                .flush()
                .await
                .map_err(|error| format!("保存完成下载文件失败: {error}"))?;
            tokio::fs::remove_file(temporary_path)
                .await
                .map_err(|error| format!("发布下载文件后清理临时文件失败: {error}"))?;
        }
    }
    Ok(task)
}

pub(crate) fn spawn_task(
    app: AppHandle,
    db: DatabaseConnection,
    task_id: i64,
) -> Result<(), String> {
    let control = app.state::<DownloadTaskState>().start(task_id)?;
    tauri::async_runtime::spawn(async move {
        let result = run_download_task(&app, &db, task_id, control).await;
        if let Err(message) = result {
            mark_failed(&db, task_id, message).await;
        }
        app.state::<DownloadTaskState>().finish(task_id);
        if let Err(error) = start_next_queued_download(&app, &db, task_id).await {
            log::warn!("尝试继续下一下载任务失败: {error}");
        }
    });
    Ok(())
}

/// 下载槽释放后按创建顺序启动下一等待项。失败/暂停的当前任务不会被重新启动。
async fn start_next_queued_download(
    app: &AppHandle,
    db: &DatabaseConnection,
    previous_task_id: i64,
) -> Result<(), String> {
    if !app.state::<DownloadTaskState>().running.lock().is_empty() {
        return Ok(());
    }
    let candidates = tasks::Entity::find()
        .filter(tasks::Column::Status.eq("paused"))
        .filter(tasks::Column::Id.ne(previous_task_id))
        .order_by_asc(tasks::Column::CreatedAt)
        .all(db)
        .await
        .map_err(|error| format!("读取等待下载任务失败: {error}"))?;
    for task in candidates {
        if spawn_task(app.clone(), db.clone(), task.id).is_ok() {
            return Ok(());
        }
    }
    Ok(())
}

async fn run_download_task(
    app: &AppHandle,
    db: &DatabaseConnection,
    task_id: i64,
    mut control: watch::Receiver<TaskControl>,
) -> Result<(), String> {
    let task = begin_task_run(db, find_task(db, task_id).await?).await?;
    if completed_shionlib_archive_is_ready(&task).await? {
        let task = mark_shionlib_archive_ready(db, task).await?;
        return finish_shionlib_install(app, db, task).await;
    }
    let root_path = validate_root_path(&task.root_path)?;
    tokio::fs::create_dir_all(&root_path)
        .await
        .map_err(|error| format!("创建游戏下载目录失败: {error}"))?;
    let target = download_path(&task);
    let total = task.progress_total;
    ensure_download_space(&root_path, &target, total).await?;

    let existing_length = match tokio::fs::metadata(&target).await {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(format!("读取临时下载文件失败: {error}")),
    };
    let total_u64 = u64::try_from(total).map_err(|_| "下载文件大小无效".to_string())?;
    if existing_length > total_u64 {
        return Err("临时下载文件大小超过来源声明，已保留文件且未继续下载".to_string());
    }
    if existing_length == total_u64 && !control_path(&target).exists() {
        verify_completed_file(&task, target.clone()).await?;
        let task = publish_completed_file(db, task, &target).await?;
        if task.task_kind == TASK_KIND_SHIONLIB_INSTALL {
            let task = mark_shionlib_archive_ready(db, task).await?;
            return finish_shionlib_install(app, db, task).await;
        }
        update_task(db, task, Some("completed"), Some(total), Some(None)).await?;
        return Ok(());
    }

    // 旧下载器只保存了顺序写入的临时文件。只有数据库进度与实际长度完全
    // 一致、且本次“继续”已完成来源复查时，才原子创建新控制文件接续它。
    if existing_length > 0 && existing_length < total_u64 && !control_path(&target).exists() {
        let recorded = u64::try_from(task.progress_current).unwrap_or_default();
        if recorded != existing_length {
            return Err("旧临时文件与已记录进度不一致，已保留文件，避免错误续传".to_string());
        }
        adopt_legacy_prefix(
            &target,
            total_u64,
            existing_length,
            download_identity(&task),
            task.remote_etag.clone(),
            task.remote_last_modified.clone(),
        )
        .map_err(|error| format!("接入旧下载断点失败，文件已保留: {error}"))?;
    }

    let client = build_download_client()?;
    let (progress_sender, mut progress_receiver) = watch::channel(Progress::initial());
    let cancellation = CancellationToken::new();
    let request = DownloadRequest {
        url: task.url.clone(),
        target: target.clone(),
        expected_size: total_u64,
        identity: download_identity(&task),
    };
    let transfer = download(
        request,
        DownloadOptions::default(),
        client,
        progress_sender,
        cancellation.clone(),
    );
    tokio::pin!(transfer);
    let mut requested_control = None;
    let mut last_persisted = i64::try_from(existing_length).unwrap_or(0);
    let mut last_write = Instant::now();
    let outcome = loop {
        tokio::select! {
            result = &mut transfer => break result,
            changed = control.changed() => {
                let next = changed.map(|_| *control.borrow()).unwrap_or(TaskControl::Cancel);
                requested_control = Some(next);
                cancellation.cancel();
            }
            changed = progress_receiver.changed() => {
                if changed.is_err() { continue; }
                let progress = *progress_receiver.borrow();
                let received = i64::try_from(progress.committed.min(total_u64)).unwrap_or(total);
                if progress.initialized && (received - last_persisted >= 512 * 1024 || last_write.elapsed() >= PROGRESS_WRITE_INTERVAL) {
                    let current = find_task(db, task_id).await?;
                    update_task(db, current, Some("running"), Some(received), Some(None)).await?;
                    last_persisted = received;
                    last_write = Instant::now();
                }
            }
        }
    };
    let committed =
        i64::try_from(progress_receiver.borrow().committed.min(total_u64)).unwrap_or(total);
    match outcome.map_err(|error| format!("下载中断: {error}"))? {
        Outcome::Cancelled => {
            let current = find_task(db, task_id).await?;
            let status = if requested_control == Some(TaskControl::Pause) {
                "paused"
            } else {
                "cancelled"
            };
            update_task(db, current, Some(status), Some(committed), Some(None)).await?;
            Ok(())
        }
        Outcome::Completed => {
            let task = find_task(db, task_id).await?;
            verify_completed_file(&task, target.clone()).await?;
            let task = publish_completed_file(db, task, &target).await?;
            if task.task_kind == TASK_KIND_SHIONLIB_INSTALL {
                let task = mark_shionlib_archive_ready(db, task).await?;
                return finish_shionlib_install(app, db, task).await;
            }
            update_task(db, task, Some("completed"), Some(total), Some(None)).await?;
            Ok(())
        }
    }
}

async fn finish_shionlib_install(
    app: &AppHandle,
    db: &DatabaseConnection,
    task: tasks::Model,
) -> Result<(), String> {
    if task.install_stage.as_deref() == Some(INSTALL_STAGE_SCANNING)
        && let Some(result) = task
            .install_result_json
            .as_deref()
            .and_then(|value| serde_json::from_str::<ShionlibInstallResult>(value).ok())
    {
        return scan_and_finish_shionlib_install(db, task, result).await;
    }
    let Some(install_root) = task.install_root_path.as_deref() else {
        let _ = update_install_task_state(
            db,
            task,
            "failed",
            INSTALL_STAGE_DOWNLOADING,
            Some(INSTALL_ERROR_ORGANIZING),
            Some("该 Shionlib 任务没有已确认的游戏安装目录；请重新从网站发起资源请求".to_string()),
            None,
        )
        .await;
        return Ok(());
    };
    let install_root = PathBuf::from(install_root);
    if let Err(error) = validate_existing_directory(&install_root, "游戏安装目录") {
        let _ = update_install_task_state(
            db,
            task,
            "failed",
            INSTALL_STAGE_DOWNLOADING,
            Some(INSTALL_ERROR_ORGANIZING),
            Some(error),
            None,
        )
        .await;
        return Ok(());
    }
    let staging = install_staging_path(&task, &install_root);
    let has_staging = matches!(fs::symlink_metadata(&staging), Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir());
    let task = if has_staging {
        update_install_task_state(
            db,
            task,
            "running",
            INSTALL_STAGE_ORGANIZING,
            None,
            None,
            None,
        )
        .await?
    } else {
        let task = update_install_task_state(
            db,
            task,
            "running",
            INSTALL_STAGE_EXTRACTING,
            None,
            None,
            None,
        )
        .await?;
        let Some(archive_path) = completed_path(&task) else {
            return Err("已完成的 Shionlib 安装包路径无效".to_string());
        };
        let Some(archive_format) = task.archive_format.clone() else {
            return Err("Shionlib 安装任务缺少压缩格式信息".to_string());
        };
        let app = app.clone();
        let extraction = tauri::async_runtime::spawn_blocking(move || {
            crate::install_archive::extract_install_archive(
                &app,
                &archive_path,
                &archive_format,
                None,
                &staging,
            )
        })
        .await
        .map_err(|error| format!("等待安装包解压结束失败: {error}"));
        if let Err(error) = extraction.and_then(|result| result.map_err(|error| error.message())) {
            let current = find_task(db, task.id).await?;
            update_install_task_state(
                db,
                current,
                "failed",
                INSTALL_STAGE_EXTRACTING,
                Some(INSTALL_ERROR_ARCHIVE),
                Some(error),
                None,
            )
            .await?;
            return Ok(());
        }
        find_task(db, task.id).await?
    };
    let task = update_install_task_state(
        db,
        task,
        "running",
        INSTALL_STAGE_ORGANIZING,
        None,
        None,
        None,
    )
    .await?;
    let install_root = install_root.clone();
    let task_for_move = task.clone();
    let move_result = tauri::async_runtime::spawn_blocking(move || {
        move_install_staging_to_target(&task_for_move, &install_root)
    })
    .await
    .map_err(|error| format!("等待安装目录整理结束失败: {error}"));
    let move_result = match move_result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let current = find_task(db, task.id).await?;
            update_install_task_state(
                db,
                current,
                "failed",
                INSTALL_STAGE_ORGANIZING,
                Some(INSTALL_ERROR_ORGANIZING),
                Some(error),
                None,
            )
            .await?;
            return Ok(());
        }
        Err(error) => {
            let current = find_task(db, task.id).await?;
            update_install_task_state(
                db,
                current,
                "failed",
                INSTALL_STAGE_ORGANIZING,
                Some(INSTALL_ERROR_ORGANIZING),
                Some(error),
                None,
            )
            .await?;
            return Ok(());
        }
    };
    let result = ShionlibInstallResult {
        version: 1,
        install_path: move_result.target_path,
        file_count: move_result.file_count,
        source_staging_retained: move_result.source_staging_retained,
        executable_candidates: Vec::new(),
        selected_executable: None,
        metadata_match: None,
        imported_game_id: None,
        created_new_game: None,
    };
    scan_and_finish_shionlib_install(db, task, result).await
}

async fn scan_and_finish_shionlib_install(
    db: &DatabaseConnection,
    task: tasks::Model,
    mut result: ShionlibInstallResult,
) -> Result<(), String> {
    let task = update_install_task_state(
        db,
        task,
        "running",
        INSTALL_STAGE_SCANNING,
        None,
        None,
        None,
    )
    .await?;
    let install_path = PathBuf::from(&result.install_path);
    let scan_result = tauri::async_runtime::spawn_blocking(move || {
        scan_install_executable_candidates(&install_path)
    })
    .await
    .map_err(|error| format!("等待启动程序扫描结束失败: {error}"));
    let candidates = match scan_result {
        Ok(Ok(candidates)) => candidates,
        Ok(Err(error)) | Err(error) => {
            let current = find_task(db, task.id).await?;
            let partial = serde_json::to_string(&result).map_err(|serialization_error| {
                format!("保存安装结果失败: {serialization_error}")
            })?;
            update_install_task_state(
                db,
                current,
                "failed",
                INSTALL_STAGE_SCANNING,
                Some(INSTALL_ERROR_SCAN),
                Some(error),
                Some(partial),
            )
            .await?;
            return Ok(());
        }
    };
    result.selected_executable = (candidates.len() == 1).then(|| candidates[0].clone());
    result.executable_candidates = candidates;
    let task = update_install_task_state(
        db,
        task,
        "running",
        INSTALL_STAGE_MATCHING_METADATA,
        None,
        None,
        None,
    )
    .await?;
    result.metadata_match = Some(match_shionlib_metadata(db, &task).await.unwrap_or_else(
        |error| ShionlibMetadataMatch {
            version: 1,
            state: "read_failed".to_string(),
            game_id: None,
            matched_by: None,
            note: Some(format!(
                "未读取现有游戏资料，后续入库前需要重新确认：{error}"
            )),
        },
    ));
    let result =
        serde_json::to_string(&result).map_err(|error| format!("保存启动程序候选失败: {error}"))?;
    let completed = update_install_task_state(
        db,
        task,
        "completed",
        INSTALL_STAGE_INSTALLED_PENDING_IMPORT,
        None,
        None,
        Some(result),
    )
    .await?;
    try_auto_import_shionlib_game(db, &completed).await?;
    Ok(())
}

/// 仅在唯一启动程序且资料精确命中一个无本地路径的现有卡片时自动入库。
/// 其它情况保留为待入库，绝不按名称猜测或创建新卡片。
async fn try_auto_import_shionlib_game(
    db: &DatabaseConnection,
    task: &tasks::Model,
) -> Result<(), String> {
    if !task.auto_import
        || task.status != "completed"
        || task.install_stage.as_deref() != Some(INSTALL_STAGE_INSTALLED_PENDING_IMPORT)
    {
        return Ok(());
    }
    let Some(result) = task
        .install_result_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<ShionlibInstallResult>(value).ok())
    else {
        return Ok(());
    };
    let can_import = result.executable_candidates.len() == 1
        && result.selected_executable.as_deref().is_some()
        && result
            .metadata_match
            .as_ref()
            .is_some_and(|matched| matched.state == "matched_existing");
    if !can_import {
        return Ok(());
    }
    let imported = import_shionlib_installed_game_inner(
        db,
        ImportShionlibInstalledGameData {
            task_id: task.id,
            executable_name: result.selected_executable.unwrap_or_default(),
            title: task.title.clone(),
            bgm_id: None,
            bgm_data: None,
        },
    )
    .await;
    if imported.is_ok() && task.auto_delete {
        delete_download_task_inner(db, task.id).await?;
    }
    Ok(())
}

async fn match_shionlib_metadata<C: ConnectionTrait>(
    db: &C,
    task: &tasks::Model,
) -> Result<ShionlibMetadataMatch, String> {
    let hints = task
        .metadata_json
        .as_deref()
        .map(serde_json::from_str::<ShionlibMetadataHints>)
        .transpose()
        .map_err(|error| format!("任务保存的资料标识无法识别: {error}"))?
        .unwrap_or_default();
    let bgm_id = non_empty_metadata_id(hints.bgm_id);
    let vndb_id = non_empty_metadata_id(hints.vndb_id);
    let has_hikarinagi_id = non_empty_metadata_id(hints.hikarinagi_id).is_some();
    let bgm_matches = match bgm_id.as_deref() {
        Some(id) => Some(find_metadata_source_matches(db, games::Column::BgmId, id).await?),
        None => None,
    };
    let vndb_matches = match vndb_id.as_deref() {
        Some(id) => Some(find_metadata_source_matches(db, games::Column::VndbId, id).await?),
        None => None,
    };
    Ok(resolve_shionlib_metadata_match(
        bgm_matches,
        vndb_matches,
        has_hikarinagi_id,
    ))
}

fn non_empty_metadata_id(value: Option<String>) -> Option<String> {
    value.and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()))
}

fn shionlib_new_game_bgm_metadata(
    hints: &ShionlibMetadataHints,
    data: &ImportShionlibInstalledGameData,
) -> Result<(String, Option<String>, Option<BgmData>), String> {
    let expected_id = hints
        .bgm_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let supplied_id = data
        .bgm_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let Some(expected_id) = expected_id else {
        if supplied_id.is_some() || data.bgm_data.is_some() {
            return Err("任务未提供 Bangumi 标识，不能写入未核对的 Bangumi 资料".to_string());
        }
        return Ok(("custom".to_string(), None, None));
    };

    if supplied_id != Some(expected_id) || data.bgm_data.is_none() {
        return Err(
            "Bangumi 资料尚未成功获取；任务保持待入库，请检查 Bangumi 登录和网络后重试".to_string(),
        );
    }

    Ok((
        "bgm".to_string(),
        Some(expected_id.to_string()),
        data.bgm_data.clone(),
    ))
}

async fn find_metadata_source_matches<C: ConnectionTrait>(
    db: &C,
    column: games::Column,
    external_id: &str,
) -> Result<MetadataSourceMatches, String> {
    let games = games::Entity::find()
        .filter(column.eq(external_id))
        .all(db)
        .await
        .map_err(|error| format!("读取现有游戏资料失败: {error}"))?;
    let mut matches = MetadataSourceMatches::default();
    for game in games {
        if game.localpath.is_none() {
            matches.eligible_game_ids.push(game.id);
        } else {
            matches.already_installed_game_ids.push(game.id);
        }
    }
    matches.eligible_game_ids.sort_unstable();
    matches.eligible_game_ids.dedup();
    matches.already_installed_game_ids.sort_unstable();
    matches.already_installed_game_ids.dedup();
    Ok(matches)
}

fn resolve_shionlib_metadata_match(
    bgm_matches: Option<MetadataSourceMatches>,
    vndb_matches: Option<MetadataSourceMatches>,
    has_hikarinagi_id: bool,
) -> ShionlibMetadataMatch {
    let sources = [
        ("Bangumi", bgm_matches.as_ref()),
        ("VNDB", vndb_matches.as_ref()),
    ];
    let source_has_ambiguity = sources.iter().any(|(_, matches)| {
        matches.is_some_and(|matches| {
            matches.eligible_game_ids.len() > 1
                || (!matches.eligible_game_ids.is_empty()
                    && !matches.already_installed_game_ids.is_empty())
        })
    });
    let eligible_game_ids = sources
        .iter()
        .filter_map(|(_, matches)| matches.as_ref())
        .flat_map(|matches| matches.eligible_game_ids.iter().copied())
        .collect::<HashSet<_>>();
    let already_installed_game_ids = sources
        .iter()
        .filter_map(|(_, matches)| matches.as_ref())
        .flat_map(|matches| matches.already_installed_game_ids.iter().copied())
        .collect::<HashSet<_>>();
    if source_has_ambiguity || eligible_game_ids.len() > 1 {
        return ShionlibMetadataMatch {
            version: 1,
            state: "ambiguous".to_string(),
            game_id: None,
            matched_by: None,
            note: Some("资料编号命中了多个或互相矛盾的现有记录；后续不会自动合并".to_string()),
        };
    }
    if eligible_game_ids.len() == 1 && already_installed_game_ids.is_empty() {
        let game_id = *eligible_game_ids.iter().next().expect("one game id exists");
        let matched_by = sources
            .iter()
            .filter_map(|(name, matches)| {
                matches
                    .as_ref()
                    .filter(|matches| matches.eligible_game_ids.contains(&game_id))
                    .map(|_| *name)
            })
            .collect::<Vec<_>>()
            .join(" + ");
        return ShionlibMetadataMatch {
            version: 1,
            state: "matched_existing".to_string(),
            game_id: Some(game_id),
            matched_by: Some(matched_by),
            note: Some("仅识别到未设置本地路径的现有资料；本阶段尚未写入游戏库".to_string()),
        };
    }
    if !already_installed_game_ids.is_empty() {
        return ShionlibMetadataMatch {
            version: 1,
            state: "already_installed_protected".to_string(),
            game_id: None,
            matched_by: None,
            note: Some(
                "同一资料编号已关联到已有本地路径的游戏；为保护现有路径，后续不会自动改写"
                    .to_string(),
            ),
        };
    }
    if has_hikarinagi_id && bgm_matches.is_none() && vndb_matches.is_none() {
        return ShionlibMetadataMatch {
            version: 1,
            state: "unsupported_hint_only".to_string(),
            game_id: None,
            matched_by: None,
            note: Some("当前改版没有 Hikarinagi 本地标识，未按名称猜测匹配".to_string()),
        };
    }
    ShionlibMetadataMatch {
        version: 1,
        state: "no_match".to_string(),
        game_id: None,
        matched_by: None,
        note: Some("未命中可安全关联的现有资料；后续将准备创建新记录".to_string()),
    }
}

#[tauri::command]
pub async fn create_download_task(
    app: tauri::AppHandle,
    db: State<'_, DatabaseConnection>,
    data: CreateDownloadTaskData,
) -> Result<tasks::Model, String> {
    let url = validate_request(&data)?;
    let created =
        create_paused_download_task(db.inner(), data.title.trim(), url, None, None, None, None)
            .await?;
    match spawn_task(app, db.inner().clone(), created.id) {
        Ok(()) => find_task(db.inner(), created.id).await,
        Err(_) => Ok(created),
    }
}

pub(crate) async fn create_paused_download_task(
    db: &DatabaseConnection,
    title: &str,
    url: Url,
    expected_size: Option<i64>,
    suggested_file_name: Option<&str>,
    expected_checksum: Option<RemoteChecksum>,
    source_expires_at: Option<i64>,
) -> Result<tasks::Model, String> {
    if title.trim().is_empty() || title.trim().len() > 200 {
        return Err("任务名称不能为空且不能超过 200 个字符".to_string());
    }
    let settings: user::Model = db.get_settings().await?;
    let root_path = settings
        .download_root_path_value()
        .ok_or_else(|| "请先在路径管理中设置游戏下载目录".to_string())?;
    validate_root_path(root_path)?;
    let remote = inspect_remote_file(&url).await?;
    if expected_size.is_some_and(|size| size != remote.total) {
        return Err("资源声明的文件大小与下载服务器返回的大小不一致，未创建任务".to_string());
    }
    let checksum = match (expected_checksum, remote.checksum) {
        (Some(expected), Some(remote))
            if expected.algorithm == remote.algorithm && expected.value != remote.value =>
        {
            return Err("Shionlib 与下载服务器提供的校验信息不一致，未创建任务".to_string());
        }
        (Some(expected), _) => Some(expected),
        (None, remote) => remote,
    };
    let now = chrono::Utc::now().timestamp();
    let created = tasks::ActiveModel {
        title: Set(title.trim().to_string()),
        status: Set("paused".to_string()),
        task_kind: Set(TASK_KIND_DOWNLOAD.to_string()),
        url: Set(url.to_string()),
        root_path: Set(root_path.to_string()),
        progress_current: Set(0),
        progress_total: Set(remote.total),
        file_name: Set(None),
        checksum_algorithm: Set(None),
        checksum_value: Set(None),
        remote_etag: Set(None),
        remote_last_modified: Set(None),
        source_expires_at: Set(source_expires_at),
        install_stage: Set(None),
        install_root_path: Set(None),
        source_provider: Set(None),
        source_resource_id: Set(None),
        archive_format: Set(None),
        metadata_json: Set(None),
        install_result_json: Set(None),
        error_code: Set(None),
        auto_import: Set(false),
        auto_delete: Set(false),
        error_message: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await
    .map_err(|error| format!("创建下载任务失败: {error}"))?;
    let requested_file_name = suggested_file_name.unwrap_or(&remote.file_name);
    let file_name = match reserve_file_name(db, root_path, requested_file_name, created.id).await {
        Ok(file_name) => file_name,
        Err(error) => {
            let _ = tasks::Entity::delete_by_id(created.id).exec(db).await;
            return Err(error);
        }
    };
    let created = update_task_file_details(
        db,
        created,
        Some(file_name),
        checksum,
        remote.etag,
        remote.last_modified,
    )
    .await?;
    Ok(created)
}

/// 为已经完成用户确认与来源大小复核的 Shionlib 请求补充安装任务信息。
///
/// 当前仍沿用既有“暂停后由用户继续下载”的行为；这些字段只为后续自动
/// 安装状态机提供恢复所需的非敏感上下文，绝不保存压缩包密码。
pub(crate) async fn create_paused_shionlib_install_task(
    db: &DatabaseConnection,
    title: &str,
    url: Url,
    expected_size: i64,
    suggested_file_name: &str,
    expected_checksum: Option<RemoteChecksum>,
    source_expires_at: Option<i64>,
    details: ShionlibInstallTaskDetails,
) -> Result<tasks::Model, String> {
    let configured_install_root = db
        .get_settings()
        .await?
        .install_root_path
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "请先在路径管理中设置游戏安装目录".to_string())?;
    validate_existing_directory(Path::new(&configured_install_root), "游戏安装目录")?;
    let task = create_paused_download_task(
        db,
        title,
        url,
        Some(expected_size),
        Some(suggested_file_name),
        expected_checksum,
        source_expires_at,
    )
    .await?;
    let metadata_json = serde_json::to_string(&details.metadata)
        .map_err(|error| format!("保存 Shionlib 资料标识失败: {error}"))?;
    let mut active: tasks::ActiveModel = task.clone().into();
    active.task_kind = Set(TASK_KIND_SHIONLIB_INSTALL.to_string());
    active.install_root_path = Set(Some(configured_install_root));
    active.source_provider = Set(Some("shionlib".to_string()));
    active.source_resource_id = Set(Some(details.resource_id));
    active.archive_format = Set(Some(details.archive_format));
    active.metadata_json = Set(Some(metadata_json));
    active.install_stage = Set(Some(INSTALL_STAGE_DOWNLOADING.to_string()));
    active.updated_at = Set(chrono::Utc::now().timestamp());
    match active.update(db).await {
        Ok(task) => Ok(task),
        Err(error) => {
            let _ = tasks::Entity::delete_by_id(task.id).exec(db).await;
            Err(format!("创建 Shionlib 安装任务失败: {error}"))
        }
    }
}

#[tauri::command]
pub async fn list_download_tasks(
    db: State<'_, DatabaseConnection>,
) -> Result<Vec<tasks::Model>, String> {
    tasks::Entity::find()
        .order_by_desc(tasks::Column::UpdatedAt)
        .all(db.inner())
        .await
        .map_err(|error| format!("读取下载任务失败: {error}"))
}

#[tauri::command]
pub async fn inspect_completed_download_archive(
    db: State<'_, DatabaseConnection>,
    task_id: i64,
) -> Result<DownloadArchiveInspection, String> {
    let task = find_task(db.inner(), task_id).await?;
    if task.status != "completed" {
        return Err("只有已完成的下载任务可以检查压缩包".to_string());
    }
    let file_name = task
        .file_name
        .clone()
        .ok_or_else(|| "旧下载任务没有可安全检查的完成文件名".to_string())?;
    let archive_path =
        completed_path(&task).ok_or_else(|| "完成文件名不符合安全规则，无法检查".to_string())?;
    let metadata = tokio::fs::symlink_metadata(&archive_path)
        .await
        .map_err(|error| format!("读取完成文件失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err("完成文件不是普通文件，已拒绝检查".to_string());
    }
    let staging = staging_path(&task);
    let has_staging = match tokio::fs::symlink_metadata(&staging).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("临时解压区不是安全目录，已拒绝检查".to_string());
        }
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("读取临时解压区失败: {error}")),
    };
    let mut inspection = tauri::async_runtime::spawn_blocking(move || {
        inspect_completed_archive_file(&archive_path, &file_name)
    })
    .await
    .map_err(|error| format!("等待压缩包检查结束失败: {error}"))??;
    inspection.has_staging = has_staging;
    Ok(inspection)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractCompletedArchiveData {
    pub task_id: i64,
    pub password: Option<String>,
}

#[tauri::command]
pub async fn extract_completed_download_archive(
    db: State<'_, DatabaseConnection>,
    data: ExtractCompletedArchiveData,
) -> Result<DownloadArchiveStagingResult, String> {
    let task = find_task(db.inner(), data.task_id).await?;
    if task.status != "completed" {
        return Err("只有已完成的下载任务可以解压".to_string());
    }
    let file_name = task
        .file_name
        .clone()
        .ok_or_else(|| "旧下载任务没有可安全解压的完成文件名".to_string())?;
    let (format, part_index) = archive_format_and_part_index(&file_name)
        .ok_or_else(|| "完成文件不是可识别的压缩包格式".to_string())?;
    if format != "7z" || part_index.is_some() {
        return Err("当前仅支持非分卷 7z 的安全临时解压".to_string());
    }
    let password = data.password.unwrap_or_default();
    if password.len() > 512 || password.contains('\0') {
        return Err("压缩包密码格式无效".to_string());
    }
    let archive_path =
        completed_path(&task).ok_or_else(|| "完成文件名不符合安全规则，无法解压".to_string())?;
    let metadata = tokio::fs::symlink_metadata(&archive_path)
        .await
        .map_err(|error| format!("读取完成文件失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err("完成文件不是普通文件，已拒绝解压".to_string());
    }
    let staging = staging_path(&task);
    let task_id = task.id;
    let (entry_count, unpacked_size) = tauri::async_runtime::spawn_blocking(move || {
        extract_7z_to_staging(&archive_path, &staging, &password)
    })
    .await
    .map_err(|error| format!("等待解压结束失败: {error}"))??;
    Ok(DownloadArchiveStagingResult {
        staging_name: format!(".reina-task-{task_id}{STAGING_SUFFIX}"),
        entry_count,
        unpacked_size,
    })
}

#[tauri::command]
pub async fn discard_completed_download_archive_staging(
    db: State<'_, DatabaseConnection>,
    task_id: i64,
) -> Result<(), String> {
    let task = find_task(db.inner(), task_id).await?;
    let staging = staging_path(&task);
    let metadata = match tokio::fs::symlink_metadata(&staging).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取临时解压区失败: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("临时解压区不是安全目录，已拒绝清理".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || fs::remove_dir_all(&staging))
        .await
        .map_err(|error| format!("等待临时区清理结束失败: {error}"))?
        .map_err(|error| format!("清理临时解压区失败: {error}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCompletedArchiveStagingData {
    pub task_id: i64,
    pub target_parent: String,
    pub target_folder_name: String,
}

#[tauri::command]
pub async fn move_completed_download_archive_staging(
    db: State<'_, DatabaseConnection>,
    data: MoveCompletedArchiveStagingData,
) -> Result<DownloadArchiveMoveResult, String> {
    if data.target_parent.trim().is_empty() {
        return Err("请先选择目标游戏父目录".to_string());
    }
    let task = find_task(db.inner(), data.task_id).await?;
    if task.status != "completed" {
        return Err("只有已完成的下载任务可以移动临时解压区".to_string());
    }
    let target_parent = PathBuf::from(data.target_parent.trim());
    tauri::async_runtime::spawn_blocking(move || {
        move_staging_to_target(&task, &target_parent, &data.target_folder_name)
    })
    .await
    .map_err(|error| format!("等待临时解压区移动结束失败: {error}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterMovedDownloadGameData {
    pub task_id: i64,
    pub target_directory: String,
    pub executable_path: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct RegisteredDownloadGame {
    pub game_id: i32,
}

#[tauri::command]
pub async fn register_moved_download_game(
    db: State<'_, DatabaseConnection>,
    data: RegisterMovedDownloadGameData,
) -> Result<RegisteredDownloadGame, String> {
    let task = find_task(db.inner(), data.task_id).await?;
    if task.status != "completed" {
        return Err("只有已完成的下载任务可以手动添加游戏".to_string());
    }
    let title = validate_game_title(&data.title)?;
    let executable = validate_regular_game_executable(
        Path::new(data.target_directory.trim()),
        Path::new(data.executable_path.trim()),
    )?;
    let executable_key = path_comparison_key(&executable);
    let existing_games = games::Entity::find()
        .all(db.inner())
        .await
        .map_err(|error| format!("检查已有游戏路径失败: {error}"))?;
    if existing_games
        .iter()
        .any(|game| stored_game_uses_path(game, &executable_key))
    {
        return Err("该启动程序已属于现有游戏，未新增重复记录".to_string());
    }
    let match_name = executable
        .parent()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned);
    let executable_path = executable.to_string_lossy().to_string();
    let game = GamesRepository::insert(
        db.inner(),
        InsertGameData {
            bgm_id: None,
            vndb_id: None,
            ymgal_id: None,
            kun_id: None,
            dlsite_id: None,
            id_type: "custom".to_string(),
            date: None,
            localpath: Some(executable_path.clone()),
            launch_type: "local".to_string(),
            steam_launch_id: None,
            steam_monitor_path: None,
            savepath: None,
            autosave: None,
            maxbackups: None,
            clear: None,
            le_launch: None,
            magpie: None,
            vndb_data: None,
            bgm_data: None,
            ymgal_data: None,
            kun_data: None,
            dlsite_data: None,
            custom_data: Some(CustomData {
                name: Some(title),
                extra_local_paths: Some(vec![executable_path]),
                backup_match_name: match_name,
                ..Default::default()
            }),
        },
    )
    .await
    .map_err(|error| format!("创建游戏记录失败: {error}"))?;
    Ok(RegisteredDownloadGame { game_id: game.id })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportShionlibInstalledGameData {
    pub task_id: i64,
    pub executable_name: String,
    pub title: String,
    pub bgm_id: Option<String>,
    pub bgm_data: Option<BgmData>,
}

#[derive(Debug, Serialize)]
pub struct ImportedShionlibGame {
    pub game_id: i32,
    pub created_new_game: bool,
    pub executable_path: String,
}

#[tauri::command]
pub async fn import_shionlib_installed_game(
    db: State<'_, DatabaseConnection>,
    task_state: State<'_, DownloadTaskState>,
    data: ImportShionlibInstalledGameData,
) -> Result<ImportedShionlibGame, String> {
    let task_id = data.task_id;
    task_state.begin_game_import(task_id)?;
    let result = import_shionlib_installed_game_inner(db.inner(), data).await;
    task_state.finish_game_import(task_id);
    result
}

async fn import_shionlib_installed_game_inner(
    db: &DatabaseConnection,
    data: ImportShionlibInstalledGameData,
) -> Result<ImportedShionlibGame, String> {
    let task = find_task(db, data.task_id).await?;
    if task.task_kind != TASK_KIND_SHIONLIB_INSTALL
        || task.status != "completed"
        || task.install_stage.as_deref() != Some(INSTALL_STAGE_INSTALLED_PENDING_IMPORT)
    {
        return Err("只有等待入库的 Shionlib 安装任务可以添加到游戏库".to_string());
    }
    let title = validate_game_title(&data.title)?;
    let mut result = task
        .install_result_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<ShionlibInstallResult>(value).ok())
        .ok_or_else(|| "安装结果无效，无法安全添加游戏".to_string())?;
    if result.imported_game_id.is_some() {
        return Err("该 Shionlib 任务已经添加到游戏库".to_string());
    }
    let install_path = PathBuf::from(&result.install_path);
    let executable = resolve_shionlib_install_executable(&install_path, &data.executable_name)?;
    let executable_path = executable.to_string_lossy().to_string();
    let executable_key = path_comparison_key(&executable);
    let match_name = executable
        .parent()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned);
    let hints = task
        .metadata_json
        .as_deref()
        .map(serde_json::from_str::<ShionlibMetadataHints>)
        .transpose()
        .map_err(|error| format!("任务保存的资料标识无法识别: {error}"))?
        .unwrap_or_default();

    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("无法开始游戏入库事务: {error}"))?;
    let fresh_match = match_shionlib_metadata(&transaction, &task).await?;
    let recorded_match = result
        .metadata_match
        .as_ref()
        .ok_or_else(|| "资料核对结果缺失，请勿对旧任务直接自动入库".to_string())?;
    if fresh_match.state != recorded_match.state || fresh_match.game_id != recorded_match.game_id {
        return Err("现有游戏资料已变化；未写入任何内容，请重新核对后再添加".to_string());
    }
    let existing_games = games::Entity::find()
        .all(&transaction)
        .await
        .map_err(|error| format!("检查已有游戏路径失败: {error}"))?;
    if existing_games
        .iter()
        .any(|game| stored_game_uses_path(game, &executable_key))
    {
        return Err("该启动程序已属于现有游戏，未新增或修改记录".to_string());
    }

    let now = chrono::Utc::now().timestamp() as i32;
    let (game_id, created_new_game) = match fresh_match.state.as_str() {
        "matched_existing" => {
            let game_id = fresh_match
                .game_id
                .ok_or_else(|| "资料匹配结果无效，未写入任何内容".to_string())?;
            let game = games::Entity::find_by_id(game_id)
                .one(&transaction)
                .await
                .map_err(|error| format!("读取待关联游戏失败: {error}"))?
                .ok_or_else(|| "待关联游戏已不存在，未写入任何内容".to_string())?;
            if game.localpath.is_some() {
                return Err("待关联游戏已设置本地路径，未覆盖现有路径".to_string());
            }
            let custom_data = with_imported_executable(
                game.custom_data.clone(),
                &executable_path,
                match_name.clone(),
                None,
            );
            let mut active: games::ActiveModel = game.into();
            active.localpath = Set(Some(executable_path.clone()));
            active.custom_data = Set(Some(custom_data));
            active.updated_at = Set(Some(now));
            let game = active
                .update(&transaction)
                .await
                .map_err(|error| format!("关联现有游戏失败: {error}"))?;
            (game.id, false)
        }
        "no_match" | "unsupported_hint_only" => {
            let (id_type, bgm_id, bgm_data) = shionlib_new_game_bgm_metadata(&hints, &data)?;
            let custom_data =
                with_imported_executable(None, &executable_path, match_name, Some(title));
            let game = games::ActiveModel {
                id: NotSet,
                bgm_id: Set(bgm_id),
                vndb_id: Set(non_empty_metadata_id(hints.vndb_id)),
                ymgal_id: Set(None),
                kun_id: Set(None),
                dlsite_id: Set(None),
                id_type: Set(id_type),
                date: Set(None),
                localpath: Set(Some(executable_path.clone())),
                launch_type: Set("local".to_string()),
                steam_launch_id: Set(None),
                steam_monitor_path: Set(None),
                savepath: NotSet,
                autosave: NotSet,
                maxbackups: NotSet,
                clear: Set(Some(1)),
                le_launch: NotSet,
                magpie: NotSet,
                vndb_data: Set(None),
                bgm_data: Set(bgm_data),
                ymgal_data: Set(None),
                kun_data: Set(None),
                dlsite_data: Set(None),
                custom_data: Set(Some(custom_data)),
                created_at: Set(Some(now)),
                updated_at: Set(Some(now)),
            }
            .insert(&transaction)
            .await
            .map_err(|error| format!("创建游戏记录失败: {error}"))?;
            (game.id, true)
        }
        "ambiguous" | "already_installed_protected" | "read_failed" => {
            return Err("资料匹配不满足自动入库条件，未写入任何内容".to_string());
        }
        _ => return Err("资料匹配状态无效，未写入任何内容".to_string()),
    };
    result.imported_game_id = Some(game_id);
    result.created_new_game = Some(created_new_game);
    let install_result =
        serde_json::to_string(&result).map_err(|error| format!("保存入库结果失败: {error}"))?;
    let mut active_task: tasks::ActiveModel = task.into();
    active_task.install_stage = Set(Some(INSTALL_STAGE_IMPORTED.to_string()));
    active_task.error_code = Set(None);
    active_task.error_message = Set(None);
    active_task.install_result_json = Set(Some(install_result));
    active_task.updated_at = Set(chrono::Utc::now().timestamp());
    active_task
        .update(&transaction)
        .await
        .map_err(|error| format!("保存任务入库状态失败: {error}"))?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("提交游戏入库事务失败: {error}"))?;
    Ok(ImportedShionlibGame {
        game_id,
        created_new_game,
        executable_path,
    })
}

fn resolve_shionlib_install_executable(
    install_path: &Path,
    requested_name: &str,
) -> Result<PathBuf, String> {
    let requested_name = requested_name.trim();
    if requested_name.is_empty()
        || Path::new(requested_name).components().count() != 1
        || Path::new(requested_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(requested_name)
    {
        return Err("请选择安装目录根目录中的启动程序".to_string());
    }
    let candidates = scan_install_executable_candidates(install_path)?;
    if !candidates
        .iter()
        .any(|candidate| candidate == requested_name)
    {
        return Err("所选启动程序已变化或不符合安全条件，未写入任何内容".to_string());
    }
    Ok(install_path.join(requested_name))
}

fn with_imported_executable(
    existing: Option<CustomData>,
    executable_path: &str,
    backup_match_name: Option<String>,
    new_game_title: Option<String>,
) -> CustomData {
    let mut custom_data = existing.unwrap_or_default();
    if custom_data.name.is_none() {
        custom_data.name = new_game_title;
    }
    let executable_key = path_comparison_key(Path::new(executable_path));
    let paths = custom_data.extra_local_paths.get_or_insert_with(Vec::new);
    if !paths
        .iter()
        .any(|path| path_comparison_key(Path::new(path)) == executable_key)
    {
        paths.push(executable_path.to_string());
    }
    if custom_data.backup_match_name.is_none() && custom_data.backup_match_name_manual != Some(true)
    {
        custom_data.backup_match_name = backup_match_name;
    }
    custom_data
}

#[tauri::command]
pub async fn resume_download_task(
    app: tauri::AppHandle,
    db: State<'_, DatabaseConnection>,
    task_id: i64,
) -> Result<tasks::Model, String> {
    let task = find_task(db.inner(), task_id).await?;
    if !matches!(task.status.as_str(), "paused" | "failed" | "cancelled") {
        return Err("当前任务不能继续下载".to_string());
    }
    if task
        .error_message
        .as_deref()
        .is_some_and(|message| message.starts_with(CHECKSUM_FAILURE_PREFIX))
    {
        return Err("来源校验失败后请点击“重新下载”，以明确删除该任务的临时文件".to_string());
    }
    let has_completed_shionlib_archive = completed_shionlib_archive_is_ready(&task).await?;
    if !has_completed_shionlib_archive {
        if let Some(message) = check_resume_source(&task).await? {
            return update_task(db.inner(), task, Some("failed"), None, Some(Some(message))).await;
        }
    }
    let task = update_task(db.inner(), task, Some("running"), None, Some(None)).await?;
    if let Err(error) = spawn_task(app, db.inner().clone(), task.id) {
        update_task(db.inner(), task, Some("paused"), None, None).await?;
        return Err(format!("{error}；任务已保持暂停"));
    }
    find_task(db.inner(), task_id).await
}

#[tauri::command]
pub async fn restart_download_task(
    app: tauri::AppHandle,
    db: State<'_, DatabaseConnection>,
    task_id: i64,
) -> Result<tasks::Model, String> {
    let task = find_task(db.inner(), task_id).await?;
    let restart_required = task.error_message.as_deref().is_some_and(|message| {
        message.starts_with(CHECKSUM_FAILURE_PREFIX)
            || message.starts_with(SOURCE_CHANGED_FAILURE_PREFIX)
    });
    if task.status != "failed" || !restart_required {
        return Err("只有来源校验失败或来源文件已变化的任务可以重新下载".to_string());
    }
    remove_download_artifacts(&task).await?;
    let task = update_task(db.inner(), task, Some("paused"), Some(0), Some(None)).await?;
    if let Err(error) = spawn_task(app, db.inner().clone(), task.id) {
        update_task(db.inner(), task, Some("paused"), None, None).await?;
        return Err(format!("{error}；任务已保持暂停"));
    }
    find_task(db.inner(), task_id).await
}

#[tauri::command]
pub async fn pause_download_task(
    app: tauri::AppHandle,
    db: State<'_, DatabaseConnection>,
    task_id: i64,
) -> Result<tasks::Model, String> {
    if !app
        .state::<DownloadTaskState>()
        .request(task_id, TaskControl::Pause)
    {
        return Err("下载任务当前未运行".to_string());
    }
    find_task(db.inner(), task_id).await
}

#[tauri::command]
pub async fn cancel_download_task(
    app: tauri::AppHandle,
    db: State<'_, DatabaseConnection>,
    task_id: i64,
) -> Result<tasks::Model, String> {
    if !app
        .state::<DownloadTaskState>()
        .request(task_id, TaskControl::Cancel)
    {
        return Err("下载任务当前未运行".to_string());
    }
    find_task(db.inner(), task_id).await
}

#[tauri::command]
pub async fn delete_download_task(
    db: State<'_, DatabaseConnection>,
    task_id: i64,
) -> Result<(), String> {
    delete_download_task_inner(db.inner(), task_id).await
}

/// 与用户点击“删除任务”完全相同的清理逻辑。它只处理任务专属文件，
/// 安装完成的游戏目录从不属于删除范围。
async fn delete_download_task_inner(db: &DatabaseConnection, task_id: i64) -> Result<(), String> {
    let task = find_task(db, task_id).await?;
    if task.status == "running" {
        return Err("请先暂停或取消下载任务，再删除".to_string());
    }
    let staging = staging_path(&task);
    match tokio::fs::symlink_metadata(&staging).await {
        Ok(_) => {
            return Err("该任务仍有临时解压区，请先在压缩包检查中确认并清理后再删除".to_string());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("读取临时解压区失败: {error}")),
    }
    if task.task_kind == TASK_KIND_SHIONLIB_INSTALL {
        if let Some(install_root) = task.install_root_path.as_deref() {
            let install_staging = install_staging_path(&task, Path::new(install_root));
            match tokio::fs::symlink_metadata(&install_staging).await {
                Ok(_) => {
                    return Err(
                        "该安装任务仍有安装临时目录，请先继续完成或确认清理后再删除".to_string()
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("读取安装临时目录失败: {error}")),
            }
        }
    }
    remove_download_artifacts(&task).await?;
    if let Some(path) = completed_path(&task) {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("删除完成下载文件失败: {error}")),
        }
    }
    tasks::Entity::delete_by_id(task_id)
        .exec(db)
        .await
        .map_err(|error| format!("删除下载任务失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn update_download_task_automation(
    db: State<'_, DatabaseConnection>,
    task_id: i64,
    auto_import: bool,
    auto_delete: bool,
) -> Result<tasks::Model, String> {
    set_task_automation(db.inner(), task_id, auto_import, auto_delete).await
}

pub(crate) async fn set_task_automation(
    db: &DatabaseConnection,
    task_id: i64,
    auto_import: bool,
    auto_delete: bool,
) -> Result<tasks::Model, String> {
    let task = find_task(db, task_id).await?;
    let mut active: tasks::ActiveModel = task.into();
    active.auto_import = Set(auto_import);
    active.auto_delete = Set(auto_import && auto_delete);
    active.updated_at = Set(chrono::Utc::now().timestamp());
    active
        .update(db)
        .await
        .map_err(|error| format!("保存下载自动化设置失败: {error}"))
}

pub async fn pause_interrupted_download_tasks(db: &DatabaseConnection) -> Result<(), String> {
    let active = tasks::Entity::find()
        .filter(tasks::Column::Status.eq("running"))
        .all(db)
        .await
        .map_err(|error| error.to_string())?;
    for task in active {
        update_task(db, task, Some("paused"), None, Some(None)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ImportShionlibInstalledGameData, MetadataSourceMatches, RemoteFileInfo, STANDARD,
        ShionlibMetadataHints, TASK_KIND_DOWNLOAD, TASK_KIND_SHIONLIB_INSTALL,
        archive_format_and_part_index, completed_shionlib_archive_matches_declared_size,
        extract_7z_to_staging, inspect_completed_archive_file, move_install_staging_to_target,
        move_staging_to_target, parse_content_disposition_filename, parse_digest_value,
        resolve_shionlib_metadata_match, safe_archive_relative_path, sanitize_file_name,
        scan_install_executable_candidates, shionlib_new_game_bgm_metadata, source_version_changed,
        validate_game_title, validate_regular_game_executable, validate_target_folder_name,
        with_imported_executable,
    };
    use crate::backup::archive::create_7z_archive;
    use crate::entity::{bgm_data::BgmData, custom_data::CustomData, tasks};
    use base64::Engine as _;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn sanitizes_untrusted_filename_without_losing_extension() {
        assert_eq!(
            sanitize_file_name("../../CON?.zip", "download.bin"),
            "_CON.zip"
        );
        assert_eq!(sanitize_file_name("作品", "download.bin"), "作品.bin");
    }

    #[test]
    fn new_shionlib_game_uses_only_the_confirmed_bangumi_snapshot() {
        let hints = ShionlibMetadataHints {
            bgm_id: Some("123".to_string()),
            vndb_id: Some("v456".to_string()),
            hikarinagi_id: None,
        };
        let data = ImportShionlibInstalledGameData {
            task_id: 1,
            executable_name: "Game.exe".to_string(),
            title: "Game".to_string(),
            bgm_id: Some("123".to_string()),
            bgm_data: Some(BgmData {
                name: Some("Bangumi Game".to_string()),
                ..Default::default()
            }),
        };

        let (id_type, bgm_id, bgm_data) = shionlib_new_game_bgm_metadata(&hints, &data).unwrap();
        assert_eq!(id_type, "bgm");
        assert_eq!(bgm_id.as_deref(), Some("123"));
        assert_eq!(
            bgm_data.and_then(|value| value.name).as_deref(),
            Some("Bangumi Game")
        );

        let mismatched = ImportShionlibInstalledGameData {
            bgm_id: Some("999".to_string()),
            ..data
        };
        assert!(shionlib_new_game_bgm_metadata(&hints, &mismatched).is_err());
    }

    #[test]
    fn recognizes_archive_formats_and_numbered_volumes() {
        assert_eq!(
            archive_format_and_part_index("Game.7z.001"),
            Some(("7z", Some(1)))
        );
        assert_eq!(
            archive_format_and_part_index("Game.tar.zst"),
            Some(("tar.zst", None))
        );
        assert_eq!(archive_format_and_part_index("Game.exe"), None);
    }

    #[test]
    fn reads_completed_7z_directory_without_extracting() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-download-inspection-{unique}"));
        let source = root.join("source");
        let archive = root.join("game.7z");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("game.txt"), b"inspection only").unwrap();
        create_7z_archive(&source, &archive).unwrap();

        let inspection = inspect_completed_archive_file(&archive, "game.7z").unwrap();

        assert!(inspection.readable);
        assert_eq!(inspection.archive_format, "7z");
        assert_eq!(inspection.password_status, "not_required");
        assert!(inspection.entry_count.unwrap_or_default() >= 1);
        assert!(inspection.unpacked_size.unwrap_or_default() >= 15);
        assert!(archive.is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_7z_only_to_a_new_task_staging_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-download-staging-{unique}"));
        let source = root.join("source");
        let archive = root.join("game.7z");
        let staging = root.join(".reina-task-1.staging");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("game.txt"), b"staged only").unwrap();
        create_7z_archive(&source, &archive).unwrap();

        let (entry_count, unpacked_size) = extract_7z_to_staging(&archive, &staging, "").unwrap();
        let extracted = walkdir::WalkDir::new(&staging)
            .into_iter()
            .filter_map(Result::ok)
            .find(|entry| entry.file_type().is_file() && entry.file_name() == "game.txt")
            .unwrap();

        assert!(entry_count >= 1);
        assert!(unpacked_size >= 11);
        assert_eq!(fs::read(extracted.path()).unwrap(), b"staged only");
        assert!(archive.is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_unsafe_archive_relative_paths() {
        assert!(safe_archive_relative_path("../game.exe").is_err());
        assert!(safe_archive_relative_path(r"C:\game.exe").is_err());
        assert!(safe_archive_relative_path("/game.exe").is_err());
        assert_eq!(
            safe_archive_relative_path(r"folder\game.exe").unwrap(),
            std::path::PathBuf::from("folder").join("game.exe")
        );
    }

    #[test]
    fn refuses_windows_reserved_target_folder_names() {
        assert!(validate_target_folder_name("COM1.txt").is_err());
        assert!(validate_target_folder_name("Game/Name").is_err());
        assert_eq!(validate_target_folder_name("My Game").unwrap(), "My Game");
    }

    #[test]
    fn accepts_only_regular_executables_inside_the_selected_game_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-download-register-{unique}"));
        let game_directory = root.join("game");
        let executable = game_directory.join("Game.exe");
        let outside = root.join("Other.exe");
        fs::create_dir_all(&game_directory).unwrap();
        fs::write(&executable, b"not executed").unwrap();
        fs::write(&outside, b"not executed").unwrap();

        assert!(validate_regular_game_executable(&game_directory, &executable).is_ok());
        assert!(validate_regular_game_executable(&game_directory, &outside).is_err());
        assert!(validate_game_title("My Game").is_ok());
        assert!(validate_game_title(" ").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_candidate_scan_uses_only_safe_direct_executables() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-install-scan-{unique}"));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("Game.exe"), b"not executed").unwrap();
        fs::write(root.join("Game_chs.exe"), b"not executed").unwrap();
        fs::write(root.join("uninstall.exe"), b"not executed").unwrap();
        fs::write(root.join("nested").join("Nested.exe"), b"not executed").unwrap();

        let candidates = scan_install_executable_candidates(&root).unwrap();

        assert_eq!(candidates, ["Game_chs.exe", "Game.exe"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installation_metadata_match_only_accepts_one_uninstalled_exact_id() {
        let result = resolve_shionlib_metadata_match(
            Some(MetadataSourceMatches {
                eligible_game_ids: vec![7],
                already_installed_game_ids: vec![],
            }),
            Some(MetadataSourceMatches {
                eligible_game_ids: vec![7],
                already_installed_game_ids: vec![],
            }),
            false,
        );

        assert_eq!(result.state, "matched_existing");
        assert_eq!(result.game_id, Some(7));
        assert_eq!(result.matched_by.as_deref(), Some("Bangumi + VNDB"));
    }

    #[test]
    fn installation_metadata_match_keeps_conflicting_or_installed_records_out_of_auto_import() {
        let conflicting = resolve_shionlib_metadata_match(
            Some(MetadataSourceMatches {
                eligible_game_ids: vec![7],
                already_installed_game_ids: vec![],
            }),
            Some(MetadataSourceMatches {
                eligible_game_ids: vec![8],
                already_installed_game_ids: vec![],
            }),
            false,
        );
        let installed = resolve_shionlib_metadata_match(
            Some(MetadataSourceMatches {
                eligible_game_ids: vec![],
                already_installed_game_ids: vec![7],
            }),
            None,
            false,
        );

        assert_eq!(conflicting.state, "ambiguous");
        assert_eq!(conflicting.game_id, None);
        assert_eq!(installed.state, "already_installed_protected");
        assert_eq!(installed.game_id, None);
    }

    #[test]
    fn installation_metadata_match_never_guesses_from_hikarinagi_or_title() {
        let result = resolve_shionlib_metadata_match(None, None, true);

        assert_eq!(result.state, "unsupported_hint_only");
        assert_eq!(result.game_id, None);
    }

    #[test]
    fn import_preserves_manual_backup_match_name_and_adds_the_initial_path_history() {
        let custom_data = with_imported_executable(
            Some(CustomData {
                backup_match_name: None,
                backup_match_name_manual: Some(true),
                ..Default::default()
            }),
            r"C:\Games\Example\Game.exe",
            Some("Example".to_string()),
            Some("Example".to_string()),
        );

        assert_eq!(custom_data.backup_match_name, None);
        assert_eq!(custom_data.name, Some("Example".to_string()));
        assert_eq!(
            custom_data.extra_local_paths,
            Some(vec![r"C:\Games\Example\Game.exe".to_string()])
        );
    }

    #[test]
    fn moves_staging_to_a_new_target_folder_without_overwriting() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-download-move-{unique}"));
        let staging = root.join(".reina-task-1.staging");
        let games = root.join("games");
        fs::create_dir_all(staging.join("data")).unwrap();
        fs::create_dir_all(&games).unwrap();
        fs::write(staging.join("data").join("game.txt"), b"move safely").unwrap();
        let task = tasks::Model {
            id: 1,
            title: "test".to_string(),
            status: "completed".to_string(),
            task_kind: TASK_KIND_DOWNLOAD.to_string(),
            url: "https://example.com/game.7z".to_string(),
            root_path: root.to_string_lossy().to_string(),
            file_name: Some("game.7z".to_string()),
            checksum_algorithm: None,
            checksum_value: None,
            remote_etag: None,
            remote_last_modified: None,
            source_expires_at: None,
            install_stage: None,
            install_root_path: None,
            source_provider: None,
            source_resource_id: None,
            archive_format: None,
            metadata_json: None,
            install_result_json: None,
            error_code: None,
            auto_import: false,
            auto_delete: false,
            progress_current: 10,
            progress_total: 10,
            error_message: None,
            created_at: 0,
            updated_at: 0,
        };

        let result = move_staging_to_target(&task, &games, "My Game").unwrap();

        assert_eq!(result.target_folder_name, "My Game");
        assert_eq!(result.file_count, 1);
        assert!(!result.source_staging_retained);
        assert_eq!(
            fs::read(games.join("My Game").join("data").join("game.txt")).unwrap(),
            b"move safely"
        );
        assert!(!staging.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installs_single_payload_directory_without_overwriting_existing_games() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-auto-install-{unique}"));
        let staging = root.join(".reina-install-task-7.staging");
        fs::create_dir_all(staging.join("payload")).unwrap();
        fs::create_dir_all(root.join("Game Name")).unwrap();
        fs::write(staging.join("payload").join("Game.exe"), b"not executed").unwrap();
        let task = tasks::Model {
            id: 7,
            title: "Game: Name".to_string(),
            status: "running".to_string(),
            task_kind: TASK_KIND_SHIONLIB_INSTALL.to_string(),
            url: "https://example.com/game.7z".to_string(),
            root_path: root.to_string_lossy().to_string(),
            file_name: Some("game.7z".to_string()),
            checksum_algorithm: None,
            checksum_value: None,
            remote_etag: None,
            remote_last_modified: None,
            source_expires_at: None,
            install_stage: Some("organizing".to_string()),
            install_root_path: Some(root.to_string_lossy().to_string()),
            source_provider: Some("shionlib".to_string()),
            source_resource_id: Some("1".to_string()),
            archive_format: Some("7z".to_string()),
            metadata_json: None,
            install_result_json: None,
            error_code: None,
            auto_import: false,
            auto_delete: false,
            progress_current: 10,
            progress_total: 10,
            error_message: None,
            created_at: 0,
            updated_at: 0,
        };

        let result = move_install_staging_to_target(&task, &root).unwrap();

        assert_eq!(result.target_folder_name, "Game_ Name");
        assert!(root.join("Game_ Name").join("Game.exe").is_file());
        assert!(root.join("Game Name").is_dir());
        assert!(!staging.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recognizes_a_complete_shionlib_archive_even_when_old_progress_is_stale() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-complete-archive-recovery-{unique}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("game.7z"), b"complete-file").unwrap();
        let task = tasks::Model {
            id: 1,
            title: "test".to_string(),
            status: "failed".to_string(),
            task_kind: TASK_KIND_SHIONLIB_INSTALL.to_string(),
            url: "https://example.com/game.7z".to_string(),
            root_path: root.to_string_lossy().to_string(),
            file_name: Some("game.7z".to_string()),
            checksum_algorithm: None,
            checksum_value: None,
            remote_etag: None,
            remote_last_modified: None,
            source_expires_at: None,
            install_stage: Some("extracting".to_string()),
            install_root_path: Some(root.to_string_lossy().to_string()),
            source_provider: Some("shionlib".to_string()),
            source_resource_id: Some("1".to_string()),
            archive_format: Some("7z".to_string()),
            metadata_json: None,
            install_result_json: None,
            error_code: Some("archive_extract_failed".to_string()),
            auto_import: false,
            auto_delete: false,
            progress_current: 2,
            progress_total: 13,
            error_message: Some("old failure".to_string()),
            created_at: 0,
            updated_at: 0,
        };

        assert!(completed_shionlib_archive_matches_declared_size(&task));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_an_existing_move_target() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-download-move-existing-{unique}"));
        let staging = root.join(".reina-task-1.staging");
        let games = root.join("games");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(games.join("My Game")).unwrap();
        fs::write(staging.join("game.txt"), b"keep source").unwrap();
        fs::write(games.join("My Game").join("keep.txt"), b"keep target").unwrap();
        let task = tasks::Model {
            id: 1,
            title: "test".to_string(),
            status: "completed".to_string(),
            task_kind: TASK_KIND_DOWNLOAD.to_string(),
            url: "https://example.com/game.7z".to_string(),
            root_path: root.to_string_lossy().to_string(),
            file_name: Some("game.7z".to_string()),
            checksum_algorithm: None,
            checksum_value: None,
            remote_etag: None,
            remote_last_modified: None,
            source_expires_at: None,
            install_stage: None,
            install_root_path: None,
            source_provider: None,
            source_resource_id: None,
            archive_format: None,
            metadata_json: None,
            install_result_json: None,
            error_code: None,
            auto_import: false,
            auto_delete: false,
            progress_current: 10,
            progress_total: 10,
            error_message: None,
            created_at: 0,
            updated_at: 0,
        };

        assert!(move_staging_to_target(&task, &games, "My Game").is_err());
        assert_eq!(fs::read(staging.join("game.txt")).unwrap(), b"keep source");
        assert_eq!(
            fs::read(games.join("My Game").join("keep.txt")).unwrap(),
            b"keep target"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prefers_extended_content_disposition_filename() {
        assert_eq!(
            parse_content_disposition_filename(
                "attachment; filename=download.zip; filename*=UTF-8''%E4%BD%9C%E5%93%81.7z"
            ),
            Some("作品.7z".to_string())
        );
    }

    #[test]
    fn accepts_only_supported_digest_algorithms() {
        let sha256 = STANDARD.encode([7_u8; 32]);
        let checksum = parse_digest_value(&format!("sha-256=:{sha256}:")).unwrap();
        assert_eq!(checksum.algorithm, "sha256");
        assert_eq!(checksum.value, sha256);
        assert!(parse_digest_value("md5=not-supported").is_none());
    }

    #[test]
    fn recognizes_only_present_source_version_changes() {
        let task = tasks::Model {
            id: 1,
            title: "test".to_string(),
            status: "paused".to_string(),
            task_kind: TASK_KIND_DOWNLOAD.to_string(),
            url: "https://example.com/test.bin".to_string(),
            root_path: "C:\\Downloads".to_string(),
            file_name: None,
            checksum_algorithm: None,
            checksum_value: None,
            remote_etag: Some("etag-a".to_string()),
            remote_last_modified: Some("Mon, 20 Oct 2026 00:00:00 GMT".to_string()),
            source_expires_at: None,
            install_stage: None,
            install_root_path: None,
            source_provider: None,
            source_resource_id: None,
            archive_format: None,
            metadata_json: None,
            install_result_json: None,
            error_code: None,
            auto_import: false,
            auto_delete: false,
            progress_current: 5,
            progress_total: 10,
            error_message: None,
            created_at: 0,
            updated_at: 0,
        };
        let unchanged = RemoteFileInfo {
            total: 10,
            file_name: "test.bin".to_string(),
            checksum: None,
            etag: Some("etag-a".to_string()),
            last_modified: None,
        };
        assert!(!source_version_changed(&task, &unchanged));
        let changed = RemoteFileInfo {
            etag: Some("etag-b".to_string()),
            ..unchanged
        };
        assert!(source_version_changed(&task, &changed));
    }
}
