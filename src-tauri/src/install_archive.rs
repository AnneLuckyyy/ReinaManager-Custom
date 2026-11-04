//! Shionlib 自动安装使用的受控多格式解压封装。
//!
//! 仅调用打包在应用资源目录中的 7-Zip；不读取 PATH、注册表或用户配置。
//! 调用方必须传入任务专属 staging 目录，密码只经当前子进程标准输入传递。

use sea_orm::{DatabaseConnection, EntityTrait};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    ffi::{OsStr, OsString},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
};
use tauri::{Emitter, Manager, State};
use walkdir::WalkDir;

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

use crate::entity::{games, user};

const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const SUPPORTED_ARCHIVE_FORMATS: &[&str] = &[
    "7z", "zip", "rar", "tar", "tar.gz", "tar.bz2", "tar.xz", "tar.zst",
];
const GAME_ARCHIVE_FORMATS: &[&str] = &["7z", "zip"];

#[derive(Debug, Serialize)]
pub struct GameArchiveResult {
    pub archive_path: String,
    pub source_deleted: bool,
    pub warning: Option<String>,
}

#[tauri::command]
pub async fn preflight_game_archive(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
) -> Result<(), String> {
    let game = games::Entity::find_by_id(game_id)
        .one(db.inner())
        .await
        .map_err(|error| format!("读取游戏记录失败: {error}"))?
        .ok_or_else(|| "游戏记录不存在".to_string())?;
    if game.launch_type.eq_ignore_ascii_case("steam") {
        return Err("Steam 游戏不能使用本地目录打包".to_string());
    }
    let executable_path = game
        .localpath
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "该游戏没有主路径，不能打包".to_string())?;
    let source = Path::new(executable_path.trim())
        .parent()
        .ok_or_else(|| "主路径没有可打包的游戏目录".to_string())?;
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("游戏目录不存在或无法读取: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("主路径上级不是安全的普通游戏目录".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameArchiveProgress {
    game_id: i32,
    phase: &'static str,
    message: String,
    progress: Option<u8>,
}

fn emit_archive_progress(
    app: &tauri::AppHandle,
    game_id: i32,
    phase: &'static str,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "game-archive-progress",
        GameArchiveProgress {
            game_id,
            phase,
            message: message.into(),
            progress: None,
        },
    );
}

fn emit_archive_packing_progress(app: &tauri::AppHandle, game_id: i32, progress: u8) {
    let _ = app.emit(
        "game-archive-progress",
        GameArchiveProgress {
            game_id,
            phase: "packing",
            message: format!("正在压缩游戏目录（{progress}/100）"),
            progress: Some(progress),
        },
    );
}

#[derive(Debug)]
pub(crate) enum InstallArchiveError {
    PasswordRequired,
    InvalidPassword,
    Other(String),
}

impl InstallArchiveError {
    pub(crate) fn message(self) -> String {
        match self {
            Self::PasswordRequired => {
                "压缩包需要密码，请重新发起资源请求或在任务中提供密码后重试".to_string()
            }
            Self::InvalidPassword => {
                "压缩包密码错误，请重新发起资源请求或在任务中提供正确密码后重试".to_string()
            }
            Self::Other(message) => message,
        }
    }
}

pub(crate) fn extract_install_archive(
    app: &tauri::AppHandle,
    archive_path: &Path,
    archive_format: &str,
    archive_password: Option<&str>,
    staging: &Path,
) -> Result<(), InstallArchiveError> {
    if !SUPPORTED_ARCHIVE_FORMATS.contains(&archive_format) {
        return Err(InstallArchiveError::Other("不支持的压缩格式".to_string()));
    }
    validate_password(archive_password)?;
    ensure_regular_file(archive_path, "安装包")?;
    let seven_zip = resolve_bundled_seven_zip(app)?;

    if archive_format.starts_with("tar.") {
        let wrapper = staging.with_extension("wrapper");
        create_new_task_directory(&wrapper)?;
        let result = (|| {
            preflight_archive(&seven_zip, archive_path, archive_password)?;
            run_extract(&seven_zip, archive_path, archive_password, &wrapper)?;
            audit_extracted_tree(&wrapper)?;
            let tar_file = find_single_regular_file(&wrapper)?;
            create_new_task_directory(staging)?;
            preflight_archive(&seven_zip, &tar_file, archive_password)?;
            run_extract(&seven_zip, &tar_file, archive_password, staging)?;
            audit_extracted_tree(staging)
        })();
        if result.is_err() {
            let _ = remove_owned_directory(staging);
        }
        let cleanup = remove_owned_directory(&wrapper);
        result?;
        cleanup?;
        return Ok(());
    }

    create_new_task_directory(staging)?;
    let result = (|| {
        preflight_archive(&seven_zip, archive_path, archive_password)?;
        run_extract(&seven_zip, archive_path, archive_password, staging)?;
        audit_extracted_tree(staging)
    })();
    if result.is_err() {
        let _ = remove_owned_directory(staging);
    }
    result
}

/// 将数据库中当前游戏主路径的直属目录归档到同级目录。
/// 删除原目录只能由本命令执行：目录由 `game_id` 的主路径推导，并在删除前逐项
/// 核对压缩包内的相对路径与文件大小，前端不能传入任意待删除目录。
#[tauri::command]
pub async fn archive_game_directory(
    app: tauri::AppHandle,
    db: State<'_, DatabaseConnection>,
    game_id: i32,
    format: String,
    compression_level: u8,
    password: Option<String>,
    encrypt_headers: bool,
    delete_source: bool,
    delete_behavior: String,
) -> Result<GameArchiveResult, String> {
    emit_archive_progress(&app, game_id, "preparing", "正在准备打包任务");
    if !GAME_ARCHIVE_FORMATS.contains(&format.as_str()) {
        return Err("仅支持 7z 或 zip 格式".to_string());
    }
    if compression_level > 9 {
        return Err("压缩等级必须在 0 到 9 之间".to_string());
    }
    if !matches!(delete_behavior.as_str(), "permanent" | "recycle") {
        return Err("删除方式无效".to_string());
    }
    validate_password(password.as_deref()).map_err(InstallArchiveError::message)?;

    let game = games::Entity::find_by_id(game_id)
        .one(db.inner())
        .await
        .map_err(|error| format!("读取游戏记录失败: {error}"))?
        .ok_or_else(|| "游戏记录不存在".to_string())?;
    if game.launch_type.eq_ignore_ascii_case("steam") {
        return Err("Steam 游戏不能使用本地目录打包".to_string());
    }
    let executable_path = game
        .localpath
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "该游戏没有主路径，不能打包".to_string())?;
    let source_input = Path::new(executable_path.trim())
        .parent()
        .ok_or_else(|| "主路径没有可打包的游戏目录".to_string())?
        .to_path_buf();
    let source_metadata = fs::symlink_metadata(&source_input)
        .map_err(|error| format!("读取游戏目录失败: {error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err("主路径上级不是安全的普通游戏目录".to_string());
    }
    let source = source_input
        .canonicalize()
        .map_err(|error| format!("解析游戏目录失败: {error}"))?;
    let protect_games_root_children = user::Entity::find_by_id(1)
        .one(db.inner())
        .await
        .map_err(|error| format!("读取打包保护设置失败: {error}"))?
        .map(|settings| settings.protect_games_root_children)
        .unwrap_or(true);
    let source_name = source
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "拒绝打包磁盘根目录或无名称目录".to_string())?;
    let parent = source
        .parent()
        .ok_or_else(|| "无法定位游戏目录的上级目录".to_string())?;
    audit_source_tree(&source)?;
    let expected_manifest = source_file_manifest(&source)?;

    let archive_path = parent.join(format!("{}.{}", source_name.to_string_lossy(), format));
    if archive_path.exists() {
        return Err(format!(
            "目标压缩包已存在，已停止以避免覆盖: {}",
            archive_path.display()
        ));
    }

    let seven_zip = resolve_bundled_seven_zip(&app).map_err(InstallArchiveError::message)?;
    let mut arguments = vec![
        OsString::from("a"),
        OsString::from(format!("-t{format}")),
        OsString::from(format!("-mx={compression_level}")),
        OsString::from("-y"),
        // `-bsp1` lets 7-Zip write percentage updates to stdout. When a build of
        // 7-Zip does not provide them the UI keeps the regular indeterminate state.
        OsString::from("-bsp1"),
        OsString::from("-bb0"),
        OsString::from("-sccUTF-8"),
    ];
    if password.as_deref().is_some() {
        // 密码只经标准输入交给内置 7-Zip，不存入设置、日志或命令行。
        arguments.push(OsString::from("-p"));
        if format == "7z" && encrypt_headers {
            arguments.push(OsString::from("-mhe=on"));
        }
    }
    arguments.push(archive_path.as_os_str().to_os_string());
    arguments.push(source_name.to_os_string());

    let result = (|| {
        emit_archive_progress(&app, game_id, "packing", "正在压缩游戏目录");
        let output = run_game_archive_command(
            &seven_zip,
            arguments.iter().map(OsString::as_os_str),
            password.as_deref(),
            Some(parent),
            &app,
            game_id,
        )?;
        ensure_success("创建压缩包", &output, password.is_some())?;
        emit_archive_progress(&app, game_id, "verifying", "正在校验压缩包内容");
        let test_output = run_command(
            &seven_zip,
            [
                OsStr::new("t"),
                OsStr::new("-y"),
                OsStr::new("-bd"),
                OsStr::new("-bb0"),
                archive_path.as_os_str(),
            ],
            password.as_deref(),
        )?;
        ensure_success("校验压缩包", &test_output, password.is_some())?;
        let actual_manifest =
            archive_file_manifest(&seven_zip, &archive_path, password.as_deref())?;
        if expected_manifest != actual_manifest {
            return Err(InstallArchiveError::Other(describe_manifest_difference(
                &expected_manifest,
                &actual_manifest,
            )));
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = remove_created_regular_file(&archive_path);
        let message = error.message();
        emit_archive_progress(&app, game_id, "failed", message.clone());
        return Err(message);
    }

    let mut source_deleted = false;
    let mut warning = None;
    if delete_source {
        emit_archive_progress(
            &app,
            game_id,
            "deleting",
            "压缩包已校验，正在删除原游戏目录",
        );
        match remove_verified_game_directory(
            &source,
            &expected_manifest,
            &delete_behavior,
            protect_games_root_children,
        ) {
            Ok(()) => source_deleted = true,
            Err(error) => {
                warning = Some(format!(
                    "压缩包已校验完成，但原游戏目录未完整删除；游戏仍保留为本地游戏: {error}"
                ))
            }
        }
    }
    emit_archive_progress(
        &app,
        game_id,
        "completed",
        if source_deleted {
            "打包、校验和删除已完成"
        } else {
            "打包和校验已完成"
        },
    );
    Ok(GameArchiveResult {
        archive_path: archive_path.to_string_lossy().to_string(),
        source_deleted,
        warning,
    })
}

fn describe_manifest_difference(
    expected: &BTreeMap<String, u64>,
    actual: &BTreeMap<String, u64>,
) -> String {
    let missing = expected.keys().find(|path| !actual.contains_key(*path));
    let unexpected = actual.keys().find(|path| !expected.contains_key(*path));
    let different_size = expected.iter().find_map(|(path, size)| {
        actual
            .get(path)
            .filter(|actual_size| *actual_size != size)
            .map(|_| path)
    });
    let detail = missing
        .map(|path| format!("缺少文件：{path}"))
        .or_else(|| unexpected.map(|path| format!("发现额外文件：{path}")))
        .or_else(|| different_size.map(|path| format!("文件大小不一致：{path}")))
        .unwrap_or_else(|| "文件清单无法对应".to_string());
    format!(
        "压缩包内容与原游戏目录不一致（原目录 {} 个文件，压缩包 {} 个文件；{detail}），已停止删除原文件",
        expected.len(),
        actual.len(),
    )
}

fn audit_source_tree(source: &Path) -> Result<(), String> {
    let mut count = 0_usize;
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| format!("读取游戏目录失败: {error}"))?;
        if entry.file_type().is_symlink() {
            return Err("游戏目录包含符号链接或重解析点，已拒绝打包以避免越界读取".to_string());
        }
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err("游戏目录文件数量超过安全上限，已拒绝打包".to_string());
        }
    }
    Ok(())
}

fn source_file_manifest(source: &Path) -> Result<BTreeMap<String, u64>, String> {
    let root_name = source
        .file_name()
        .ok_or_else(|| "游戏目录名称无效".to_string())?
        .to_string_lossy();
    let mut files = BTreeMap::new();
    for entry in WalkDir::new(source).min_depth(1).follow_links(false) {
        let entry = entry.map_err(|error| format!("读取游戏目录失败: {error}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| "游戏目录路径越界".to_string())?;
        let key = format!(
            "{root_name}/{}",
            relative.to_string_lossy().replace('\\', "/")
        );
        files.insert(
            key.to_lowercase(),
            entry
                .metadata()
                .map_err(|error| format!("读取游戏文件失败: {error}"))?
                .len(),
        );
    }
    Ok(files)
}

fn archive_file_manifest(
    seven_zip: &Path,
    archive_path: &Path,
    password: Option<&str>,
) -> Result<BTreeMap<String, u64>, InstallArchiveError> {
    let output = run_command(
        seven_zip,
        [
            OsStr::new("l"),
            OsStr::new("-slt"),
            OsStr::new("-sccUTF-8"),
            archive_path.as_os_str(),
        ],
        password,
    )?;
    ensure_success("读取压缩包目录", &output, password.is_some())?;
    let listing = String::from_utf8(output.stdout)
        .map_err(|_| InstallArchiveError::Other("7-Zip 未返回可读取的目录信息".to_string()))?;
    audit_archive_listing(&listing)?;
    let mut in_entries = false;
    let mut current_path: Option<String> = None;
    let mut current_size: Option<u64> = None;
    let mut current_folder = false;
    let mut files = BTreeMap::new();
    let mut finish = |path: &mut Option<String>, size: &mut Option<u64>, folder: &mut bool| {
        if let Some(path) = path.take()
            && !*folder
        {
            if let Some(size) = size.take() {
                files.insert(path.replace('\\', "/").to_lowercase(), size);
            }
        }
        *size = None;
        *folder = false;
    };
    for line in listing.lines() {
        if line.trim() == "----------" {
            in_entries = true;
            continue;
        }
        if !in_entries {
            continue;
        }
        if let Some(path) = line.strip_prefix("Path = ") {
            finish(&mut current_path, &mut current_size, &mut current_folder);
            current_path = Some(path.to_string());
        } else if let Some(size) = line.strip_prefix("Size = ") {
            current_size = size.trim().parse::<u64>().ok();
        } else if let Some(folder) = line.strip_prefix("Folder = ") {
            current_folder = folder.trim() == "+";
        } else if let Some(attributes) = line.strip_prefix("Attributes = ") {
            // 7-Zip 在不同平台/格式下可能不给 `Folder = +`，而只以
            // `Attributes = D` 标记目录。目录不应参与文件大小清单。
            let attributes = attributes.trim_start();
            current_folder |= attributes.starts_with('D');
        }
    }
    finish(&mut current_path, &mut current_size, &mut current_folder);
    Ok(files)
}

fn remove_created_regular_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("拒绝清理非普通压缩包文件".to_string())
        }
        Ok(_) => fs::remove_file(path).map_err(|error| format!("清理未完成压缩包失败: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("读取未完成压缩包失败: {error}")),
    }
}

fn remove_verified_game_directory(
    source: &Path,
    expected_manifest: &BTreeMap<String, u64>,
    delete_behavior: &str,
    protect_games_root_children: bool,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("读取待删除游戏目录失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || source.parent().is_none() {
        return Err("待删除路径不是安全的普通游戏目录".to_string());
    }
    if protect_games_root_children && is_drive_games_child(source) {
        return Err("拒绝删除盘符 Games 目录的直属子目录；该目录被视为游戏父目录".to_string());
    }
    audit_source_tree(source)?;
    if &source_file_manifest(source)? != expected_manifest {
        return Err("归档校验后游戏目录内容发生变化".to_string());
    }
    if delete_behavior == "recycle" {
        move_directory_to_recycle_bin(source)?;
    } else {
        fs::remove_dir_all(source).map_err(|error| format!("删除原游戏目录失败: {error}"))?;
    }
    if source.exists() {
        return Err("删除后原游戏目录仍存在".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn move_directory_to_recycle_bin(source: &Path) -> Result<(), String> {
    use windows::{
        Win32::UI::Shell::{
            FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, SHFILEOPSTRUCTW,
            SHFileOperationW,
        },
        core::PCWSTR,
    };

    // canonicalize 在 Windows 上可能返回 `\\?\` 扩展路径；旧 Shell 回收站 API
    // 不接受该形式，即使文件系统操作本身有效。
    let shell_path = source
        .to_string_lossy()
        .strip_prefix(r"\\?\")
        .map(str::to_owned)
        .unwrap_or_else(|| source.to_string_lossy().into_owned());
    let mut source_wide: Vec<u16> = std::ffi::OsStr::new(&shell_path).encode_wide().collect();
    // SHFileOperationW requires a double-NUL terminated file list.
    source_wide.extend([0, 0]);
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(source_wide.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0) as u16,
        ..Default::default()
    };
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 || operation.fAnyOperationsAborted.as_bool() {
        return Err(format!(
            "移入回收站失败（Shell 返回 {result}；原目录未删除）"
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn move_directory_to_recycle_bin(_source: &Path) -> Result<(), String> {
    Err("当前系统不支持将游戏目录移入回收站".to_string())
}

/// 默认保护盘符根目录下 `Games` 的直属子目录：这类目录常被用作游戏分类或集合目录，
/// 不是可删除的单个游戏目录。这个约束在后端执行，前端无法绕过。
fn is_drive_games_child(path: &Path) -> bool {
    let Some(games_root) = path.parent() else {
        return false;
    };
    if !games_root
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("games"))
    {
        return false;
    }
    games_root
        .parent()
        .is_some_and(|drive_root| drive_root.parent().is_none())
}

fn resolve_bundled_seven_zip(app: &tauri::AppHandle) -> Result<PathBuf, InstallArchiveError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| InstallArchiveError::Other(format!("无法定位应用资源目录: {error}")))?;
    let executable = resource_dir.join("tools/7zip/7z.exe");
    ensure_regular_file(&executable, "内置 7-Zip")?;
    let library = resource_dir.join("tools/7zip/7z.dll");
    ensure_regular_file(&library, "内置 7-Zip 动态库")?;
    let codec = resource_dir.join("tools/7zip/Codecs/zstd.dll");
    ensure_regular_file(&codec, "内置 7-Zip Zstd 插件")?;
    Ok(executable)
}

fn ensure_regular_file(path: &Path, label: &str) -> Result<(), InstallArchiveError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| InstallArchiveError::Other(format!("读取{label}失败: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(InstallArchiveError::Other(format!(
            "{label}不是安全的普通文件"
        )));
    }
    Ok(())
}

fn validate_password(password: Option<&str>) -> Result<(), InstallArchiveError> {
    if let Some(password) = password
        && (password.len() > 1024 || password.contains(['\0', '\n', '\r']))
    {
        return Err(InstallArchiveError::Other("压缩包密码格式无效".to_string()));
    }
    Ok(())
}

fn create_new_task_directory(path: &Path) -> Result<(), InstallArchiveError> {
    let parent = path
        .parent()
        .ok_or_else(|| InstallArchiveError::Other("无法定位任务临时目录父路径".to_string()))?;
    fs::create_dir_all(parent).map_err(|error| {
        InstallArchiveError::Other(format!("创建任务临时目录父路径失败: {error}"))
    })?;
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(
            InstallArchiveError::Other("任务临时解压目录已存在，已停止以避免覆盖文件".to_string()),
        ),
        Err(error) => Err(InstallArchiveError::Other(format!(
            "创建任务临时解压目录失败: {error}"
        ))),
    }
}

fn preflight_archive(
    seven_zip: &Path,
    archive_path: &Path,
    password: Option<&str>,
) -> Result<(), InstallArchiveError> {
    let output = run_command(
        seven_zip,
        [
            OsStr::new("l"),
            OsStr::new("-slt"),
            OsStr::new("-sccUTF-8"),
            archive_path.as_os_str(),
        ],
        password,
    )?;
    ensure_success("读取压缩包目录", &output, password.is_some())?;
    let listing = String::from_utf8(output.stdout)
        .map_err(|_| InstallArchiveError::Other("7-Zip 未返回可读取的目录信息".to_string()))?;
    audit_archive_listing(&listing)
}

fn audit_archive_listing(listing: &str) -> Result<(), InstallArchiveError> {
    let mut in_entries = false;
    let mut count = 0_usize;
    let mut paths = HashSet::new();
    for line in listing.lines() {
        if line.trim() == "----------" {
            in_entries = true;
            continue;
        }
        if !in_entries {
            continue;
        }
        if let Some(path) = line.strip_prefix("Path = ") {
            let normalized = normalize_archive_path(path)?;
            if !normalized.is_empty() && !paths.insert(normalized) {
                return Err(InstallArchiveError::Other(
                    "压缩包包含会互相覆盖的重复路径".to_string(),
                ));
            }
            count += 1;
            if count > MAX_ARCHIVE_ENTRIES {
                return Err(InstallArchiveError::Other(
                    "压缩包文件数量超过安全上限".to_string(),
                ));
            }
        }
        if let Some(target) = line.strip_prefix("Symbolic Link =")
            && !target.trim().is_empty()
        {
            return Err(InstallArchiveError::Other(
                "压缩包包含符号链接，已拒绝解压".to_string(),
            ));
        }
        if let Some(target) = line.strip_prefix("Hard Link =")
            && !target.trim().is_empty()
        {
            return Err(InstallArchiveError::Other(
                "压缩包包含硬链接，已拒绝解压".to_string(),
            ));
        }
        if let Some(attributes) = line.strip_prefix("Attributes = ") {
            let attributes = attributes.trim_start();
            if attributes.starts_with('l') || attributes.contains(" Reparse ") {
                return Err(InstallArchiveError::Other(
                    "压缩包包含链接或重解析点，已拒绝解压".to_string(),
                ));
            }
        }
    }
    if count == 0 {
        return Err(InstallArchiveError::Other(
            "压缩包为空或无法读取目录".to_string(),
        ));
    }
    Ok(())
}

fn run_extract(
    seven_zip: &Path,
    archive_path: &Path,
    password: Option<&str>,
    output_dir: &Path,
) -> Result<(), InstallArchiveError> {
    let output_arg = format!("-o{}", output_dir.display());
    let output = run_command(
        seven_zip,
        [
            OsStr::new("x"),
            OsStr::new("-y"),
            OsStr::new("-aoa"),
            OsStr::new("-bd"),
            OsStr::new("-bb0"),
            OsStr::new("-sccUTF-8"),
            OsStr::new(&output_arg),
            archive_path.as_os_str(),
        ],
        password,
    )?;
    ensure_success("解压", &output, password.is_some())
}

fn run_command<'a>(
    executable: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
    password: Option<&str>,
) -> Result<Output, InstallArchiveError> {
    run_command_in_directory(executable, args, password, None)
}

fn run_command_in_directory<'a>(
    executable: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
    password: Option<&str>,
    working_directory: Option<&Path>,
) -> Result<Output, InstallArchiveError> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(working_directory) = working_directory {
        command.current_dir(working_directory);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW.0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| InstallArchiveError::Other(format!("启动内置 7-Zip 失败: {error}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(password.unwrap_or_default().as_bytes());
        let _ = stdin.write_all(b"\n");
    }
    child
        .wait_with_output()
        .map_err(|error| InstallArchiveError::Other(format!("等待内置 7-Zip 结束失败: {error}")))
}

/// 打包时保留 7-Zip 的实时标准输出，以便在其提供百分比时展示真实进度。
/// 其它 7-Zip 调用仍使用静默的通用封装，避免改变下载/安装流程的输出语义。
fn run_game_archive_command<'a>(
    executable: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
    password: Option<&str>,
    working_directory: Option<&Path>,
    app: &tauri::AppHandle,
    game_id: i32,
) -> Result<Output, InstallArchiveError> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(working_directory) = working_directory {
        command.current_dir(working_directory);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW.0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| InstallArchiveError::Other(format!("启动内置 7-Zip 失败: {error}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(password.unwrap_or_default().as_bytes());
        let _ = stdin.write_all(b"\n");
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| InstallArchiveError::Other("无法读取内置 7-Zip 输出".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| InstallArchiveError::Other("无法读取内置 7-Zip 错误输出".to_string()))?;
    let progress_app = app.clone();
    let stdout_reader = thread::spawn(move || -> std::io::Result<Vec<u8>> {
        let mut reader = stdout;
        let mut output = Vec::new();
        let mut buffer = [0_u8; 1024];
        let mut pending = String::new();
        let mut last_progress = None;
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..read]);
            pending.push_str(&String::from_utf8_lossy(&buffer[..read]));
            while let Some(index) = pending.find(['\r', '\n']) {
                let line = pending[..index].to_string();
                pending.drain(..=index);
                if let Some(progress) = parse_seven_zip_progress(&line)
                    && last_progress != Some(progress)
                {
                    emit_archive_packing_progress(&progress_app, game_id, progress);
                    last_progress = Some(progress);
                }
            }
        }
        if let Some(progress) = parse_seven_zip_progress(&pending)
            && last_progress != Some(progress)
        {
            emit_archive_packing_progress(&progress_app, game_id, progress);
        }
        Ok(output)
    });
    let stderr_reader = thread::spawn(move || -> std::io::Result<Vec<u8>> {
        let mut reader = stderr;
        let mut output = Vec::new();
        reader.read_to_end(&mut output)?;
        Ok(output)
    });
    let status = child
        .wait()
        .map_err(|error| InstallArchiveError::Other(format!("等待内置 7-Zip 结束失败: {error}")))?;
    let stdout = stdout_reader
        .join()
        .map_err(|_| InstallArchiveError::Other("读取内置 7-Zip 输出时异常结束".to_string()))?
        .map_err(|error| InstallArchiveError::Other(format!("读取内置 7-Zip 输出失败: {error}")))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| InstallArchiveError::Other("读取内置 7-Zip 错误输出时异常结束".to_string()))?
        .map_err(|error| {
            InstallArchiveError::Other(format!("读取内置 7-Zip 错误输出失败: {error}"))
        })?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn parse_seven_zip_progress(line: &str) -> Option<u8> {
    let percent_index = line.rfind('%')?;
    let digits = line[..percent_index]
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    let progress = digits
        .chars()
        .rev()
        .collect::<String>()
        .parse::<u8>()
        .ok()?;
    (progress <= 100).then_some(progress)
}

fn ensure_success(
    action: &str,
    output: &Output,
    supplied_password: bool,
) -> Result<(), InstallArchiveError> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let combined = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    if combined.contains("wrong password") || combined.contains("password is incorrect") {
        return Err(if supplied_password {
            InstallArchiveError::InvalidPassword
        } else {
            InstallArchiveError::PasswordRequired
        });
    }
    let detail = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("未知错误");
    Err(InstallArchiveError::Other(format!(
        "7-Zip {action}失败（退出码 {}）: {detail}",
        output.status.code().unwrap_or(-1)
    )))
}

fn audit_extracted_tree(root: &Path) -> Result<(), InstallArchiveError> {
    let mut count = 0_usize;
    for entry in WalkDir::new(root).min_depth(1).follow_links(false) {
        let entry = entry
            .map_err(|error| InstallArchiveError::Other(format!("读取解压文件失败: {error}")))?;
        if entry.file_type().is_symlink() {
            return Err(InstallArchiveError::Other(
                "解压结果包含符号链接，已拒绝安装".to_string(),
            ));
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| InstallArchiveError::Other("解压结果路径越界".to_string()))?;
        normalize_archive_path(&relative.to_string_lossy())?;
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(InstallArchiveError::Other(
                "解压文件数量超过安全上限".to_string(),
            ));
        }
    }
    Ok(())
}

fn find_single_regular_file(root: &Path) -> Result<PathBuf, InstallArchiveError> {
    let files = WalkDir::new(root)
        .min_depth(1)
        .max_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    if files.len() != 1 {
        return Err(InstallArchiveError::Other(
            "TAR 压缩变体的外层必须只包含一个 TAR 文件".to_string(),
        ));
    }
    Ok(files.into_iter().next().expect("one file"))
}

fn normalize_archive_path(value: &str) -> Result<String, InstallArchiveError> {
    let path = value.trim_end_matches(['/', '\\']);
    if path.is_empty() {
        return Ok(String::new());
    }
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(InstallArchiveError::Other(
            "压缩包包含不安全路径，已拒绝解压".to_string(),
        ));
    }
    Ok(path.replace('\\', "/").to_lowercase())
}

fn remove_owned_directory(path: &Path) -> Result<(), InstallArchiveError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(InstallArchiveError::Other(
            "拒绝清理符号链接临时目录".to_string(),
        )),
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)
            .map_err(|error| InstallArchiveError::Other(format!("清理任务临时目录失败: {error}"))),
        Ok(_) => Err(InstallArchiveError::Other(
            "任务临时路径不是目录".to_string(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(InstallArchiveError::Other(format!(
            "读取任务临时目录失败: {error}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        archive_file_manifest, audit_archive_listing, ensure_success, is_drive_games_child,
        normalize_archive_path, parse_seven_zip_progress, run_command_in_directory,
        source_file_manifest,
    };
    use std::{
        ffi::OsStr,
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn rejects_unsafe_archive_paths() {
        assert!(normalize_archive_path("../game.exe").is_err());
        assert!(normalize_archive_path("C:\\game.exe").is_err());
        assert!(normalize_archive_path("/game.exe").is_err());
        assert_eq!(
            normalize_archive_path("folder\\game.exe").unwrap(),
            "folder/game.exe"
        );
    }

    #[test]
    fn audits_only_entry_section_and_rejects_duplicate_paths() {
        let valid = "Path = C:\\temp\\game.7z\n----------\nPath = Game\\Game.exe\nAttributes = A\n";
        assert!(audit_archive_listing(valid).is_ok());
        let duplicate = "----------\nPath = Game.exe\nPath = game.exe\n";
        assert!(audit_archive_listing(duplicate).is_err());
    }

    #[test]
    fn parses_7zip_percent_output_without_guessing_other_numbers() {
        assert_eq!(parse_seven_zip_progress(" 35% + game/save.dat"), Some(35));
        assert_eq!(parse_seven_zip_progress("100%"), Some(100));
        assert_eq!(parse_seven_zip_progress("Files: 35"), None);
        assert_eq!(parse_seven_zip_progress("101%"), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn protects_direct_children_of_drive_games_root() {
        assert!(is_drive_games_child(Path::new(r"F:\Games\Anime Games")));
        assert!(!is_drive_games_child(Path::new(
            r"F:\Games\Anime Games\alicenation"
        )));
        assert!(!is_drive_games_child(Path::new(r"F:\Other\Anime Games")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn moves_a_disposable_directory_to_the_recycle_bin() {
        use super::move_directory_to_recycle_bin;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let source = std::env::temp_dir().join(format!("reina-recycle-test-{nonce}"));
        fs::create_dir(&source).unwrap();
        fs::write(source.join("only-test-file.txt"), b"reina recycle test").unwrap();
        move_directory_to_recycle_bin(&source).unwrap();
        assert!(!source.exists());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn created_game_archive_has_the_same_file_manifest_as_its_source() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("reina-archive-manifest-{nonce}"));
        let source = root.join("alicenation");
        let result = (|| {
            fs::create_dir_all(source.join("save")).unwrap();
            fs::write(source.join("Game.exe"), b"launch").unwrap();
            fs::write(source.join("save/config.ini"), b"setting=true").unwrap();

            let seven_zip = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/7zip/7z.exe");
            assert!(
                seven_zip.is_file(),
                "bundled 7-Zip fixture is required for this test"
            );
            let archive = root.join("alicenation.7z");
            let output = run_command_in_directory(
                &seven_zip,
                [
                    OsStr::new("a"),
                    OsStr::new("-t7z"),
                    OsStr::new("-mx=5"),
                    OsStr::new("-y"),
                    OsStr::new("-bsp1"),
                    archive.as_os_str(),
                    OsStr::new("alicenation"),
                ],
                None,
                Some(&root),
            )
            .unwrap();
            ensure_success("创建测试压缩包", &output, false).unwrap();

            let expected = source_file_manifest(&source).unwrap();
            let actual = archive_file_manifest(&seven_zip, &archive, None).unwrap();
            assert_eq!(expected, actual);
        })();
        let _ = fs::remove_dir_all(&root);
        result
    }
}
