#[cfg(target_os = "windows")]
use crate::utils::command_ext::CommandGuiExt;

use crate::backup::archive::{create_7z_archive, verify_7z_archive};
use crate::database::db::{
    BackupResult, acquire_database_operation_lock, ensure_database_backup_available,
    resolve_backup_dir,
};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use sevenz_rust2::{ArchiveReader, Password};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{State, command};

#[derive(Debug, Serialize, Deserialize)]
pub struct PortableModeResult {
    pub is_portable: bool,
}

#[derive(Debug, Serialize)]
pub struct CustomCoverRestoreResult {
    pub success: bool,
    pub message: String,
    pub backup_path: Option<String>,
    pub restored_count: usize,
}

// ==================== 文件操作相关 ====================

/// 打开目录
///
/// # Arguments
///
/// * `dir_path` - 要打开的目录路径
///
/// # Returns
///
/// 操作结果
#[command]
pub async fn open_directory(dir_path: String) -> Result<(), String> {
    // 首先检查路径是否存在
    if !Path::new(&dir_path).exists() {
        return Err(format!("路径不存在且无法创建: {}", dir_path));
    }

    #[cfg(target_os = "windows")]
    {
        // Windows Explorer 在某些情况下对反斜杠的处理更稳定
        // 虽然 Windows 系统本身支持正斜杠，但 Explorer 更喜欢原生的反斜杠格式
        let normalized_path = dir_path.replace('/', "\\");

        let result = Command::new("explorer")
            .arg(&normalized_path)
            .gui_safe()
            .spawn();

        match result {
            Ok(_) => Ok(()),
            Err(e) => {
                // 如果 explorer 失败，尝试使用 cmd /c start
                let fallback_result = Command::new("cmd")
                    .args(["/c", "start", "", &normalized_path])
                    .gui_safe()
                    .spawn();

                match fallback_result {
                    Ok(_) => Ok(()),
                    Err(e2) => Err(format!(
                        "无法打开目录 '{}': explorer 失败 ({}), cmd 备用方案也失败 ({})",
                        normalized_path, e, e2
                    )),
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let result = Command::new("xdg-open").arg(&dir_path).spawn();

        match result {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("无法打开目录 '{}': {}", dir_path, e)),
        }
    }
}

/// 判断当前是否为便携模式
#[command]
pub fn is_portable_mode() -> PortableModeResult {
    PortableModeResult {
        is_portable: reina_path::is_portable_mode(),
    }
}

// ==================== 数据迁移相关文件操作 ====================

/// 移动单个文件（剪切操作）
///
/// 优先使用 fs::rename，失败则使用 copy + remove
/// 如果目标文件已存在，会先尝试删除后重试
///
/// **跨盘策略**：对于跨盘符场景，先完整复制文件，成功后再删除源文件
pub fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    // 确保目标目录存在
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    // 尝试使用 rename（性能最好，适用于同盘符）
    match fs::rename(from, to) {
        Ok(_) => {
            log::debug!("已移动文件(rename): {} -> {}", from.display(), to.display());
            Ok(())
        }
        Err(_) => {
            // rename 失败（可能跨盘符或目标文件已存在）
            // 策略：先复制，成功后再删除源文件

            // 如果目标文件已存在，先尝试删除
            if to.exists() {
                log::warn!("目标文件已存在，尝试删除: {}", to.display());
                fs::remove_file(to)
                    .map_err(|e| format!("无法删除已存在的目标文件 {}: {}", to.display(), e))?;
            }

            // 复制文件
            fs::copy(from, to).map_err(|e| format!("复制文件失败: {}", e))?;

            // 复制成功，删除源文件
            fs::remove_file(from).map_err(|e| format!("删除源文件失败: {}", e))?;

            log::debug!(
                "已移动文件(copy+remove): {} -> {}",
                from.display(),
                to.display()
            );
            Ok(())
        }
    }
}

/// 递归移动目录（剪切操作）
///
/// 优先使用 fs::rename (性能最好)，失败则使用 copy + remove
///
/// **跨盘策略**：
/// 1. 先尝试 rename（同盘符时最快）
/// 2. rename 失败则使用分步骤策略：
///    - 第一阶段：复制所有文件到目标位置（记录错误但继续尝试）
///    - 第二阶段：如果复制全部成功，才删除源目录
///    - 如果有任何错误，保留源文件，返回错误信息
///    - **不会清理目标目录**，避免删除已成功复制的文件
///
/// # Arguments
/// * `from` - 源目录
/// * `to` - 目标目录
///
/// # Returns
/// * `Result<usize, String>` - 成功移动的文件数量或错误消息
#[allow(dead_code)]
pub fn move_dir_recursive(from: &Path, to: &Path) -> Result<usize, String> {
    // 尝试使用 rename（同盘符时性能最好）
    match fs::rename(from, to) {
        Ok(_) => {
            // rename 成功，统计文件数量
            let count = count_files_in_dir(to).unwrap_or(0);
            log::info!(
                "已移动目录(rename): {} -> {} ({} 个文件)",
                from.display(),
                to.display(),
                count
            );
            Ok(count)
        }
        Err(_) => {
            // rename 失败，可能是跨盘符
            log::info!(
                "rename 失败，使用分步骤复制策略: {} -> {}",
                from.display(),
                to.display()
            );

            // 第一阶段：复制所有文件到目标位置（收集错误但继续）
            let mut copy_errors = Vec::new();
            let copied_count = match copy_dir_with_error_collection(from, to, &mut copy_errors) {
                Ok(count) => count,
                Err(e) => {
                    // 复制过程中出现致命错误
                    return Err(format!(
                        "目录复制失败: {}\n注意: 源目录保持不变，目标目录可能包含部分文件",
                        e
                    ));
                }
            };

            // 检查是否有错误
            if !copy_errors.is_empty() {
                // 有文件复制失败，不删除源目录，也不清理目标目录
                let error_summary = copy_errors.join("\n");
                return Err(format!(
                    "目录复制部分失败（已复制 {} 个文件）：\n{}\n\n注意: 源目录保持不变，目标目录包含部分文件，请解决问题后重试",
                    copied_count, error_summary
                ));
            }

            // 第二阶段：所有文件复制成功，删除源目录
            fs::remove_dir_all(from).map_err(|e| {
                format!(
                    "所有文件已复制到目标位置，但删除源目录失败: {}\n源目录: {}\n目标目录: {}\n请手动删除源目录",
                    e,
                    from.display(),
                    to.display()
                )
            })?;

            log::info!(
                "已移动目录(copy+remove): {} -> {} ({} 个文件)",
                from.display(),
                to.display(),
                copied_count
            );

            Ok(copied_count)
        }
    }
}

/// 递归复制目录（带错误收集）
///
/// 此函数会尝试复制所有文件，遇到错误时不会立即停止，
/// 而是记录错误并继续处理其他文件。
///
/// # Returns
/// * `Result<usize, String>` - 成功复制的文件数量或致命错误
#[allow(dead_code)]
fn copy_dir_with_error_collection(
    from: &Path,
    to: &Path,
    errors: &mut Vec<String>,
) -> Result<usize, String> {
    let mut copied_count = 0;

    // 确保目标目录存在
    if let Err(e) = fs::create_dir_all(to) {
        return Err(format!("创建目标目录失败: {}", e));
    }

    // 遍历源目录
    let entries = fs::read_dir(from).map_err(|e| format!("读取源目录失败: {}", e))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                errors.push(format!("读取目录项失败: {}", e));
                continue;
            }
        };

        let entry_path = entry.path();
        let file_name = entry.file_name();
        let target_path = to.join(&file_name);

        if entry_path.is_dir() {
            // 递归复制子目录
            match copy_dir_with_error_collection(&entry_path, &target_path, errors) {
                Ok(count) => copied_count += count,
                Err(e) => {
                    errors.push(format!(
                        "复制子目录 {} 失败: {}",
                        file_name.to_string_lossy(),
                        e
                    ));
                }
            }
        } else {
            // 复制文件
            match fs::copy(&entry_path, &target_path) {
                Ok(_) => {
                    copied_count += 1;
                    log::debug!(
                        "已复制文件: {} -> {}",
                        entry_path.display(),
                        target_path.display()
                    );
                }
                Err(e) => {
                    errors.push(format!(
                        "复制文件 {} 失败: {}",
                        file_name.to_string_lossy(),
                        e
                    ));
                }
            }
        }
    }

    Ok(copied_count)
}

/// 统计目录中的文件数量（递归）
#[allow(dead_code)]
fn count_files_in_dir(dir: &Path) -> Result<usize, String> {
    let mut count = 0;

    if !dir.exists() {
        return Ok(0);
    }

    for entry in fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let entry_path = entry.path();

        if entry_path.is_dir() {
            count += count_files_in_dir(&entry_path)?;
        } else {
            count += 1;
        }
    }

    Ok(count)
}

#[command]
pub async fn copy_file(src: String, dst: String) -> Result<(), String> {
    let src_path = Path::new(&src);
    let dst_path = Path::new(&dst);

    if !src_path.exists() {
        return Err(format!("源文件不存在: {}", src));
    }

    if let Some(parent) = dst_path.parent()
        && !parent.exists()
    {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建目标目录的父目录: {}", e))?;
    }
    fs::copy(src_path, dst_path).map_err(|e| format!("无法复制文件: {}", e))?;
    Ok(())
}

/// 删除文件
#[command]
pub async fn delete_file(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Ok(()); // 文件不存在，视为成功
    }

    fs::remove_file(path).map_err(|e| format!("无法删除文件: {}", e))?;
    Ok(())
}

/// 删除指定游戏的所有自定义封面文件，但保留封面目录
#[command]
pub async fn delete_game_covers(game_id: u32, covers_dir: String) -> Result<(), String> {
    let dir_path = Path::new(&covers_dir);

    if !dir_path.exists() {
        return Ok(()); // 目录不存在，视为成功
    }

    let expected_folder_name = format!("game_{}", game_id);
    let dir_name = dir_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    if dir_name != expected_folder_name {
        return Err(format!(
            "封面目录与游戏ID不匹配: game_id={}, covers_dir={}",
            game_id, covers_dir
        ));
    }

    let expected_file_prefix = format!("cover_{}_", game_id);
    let entries = fs::read_dir(dir_path).map_err(|e| format!("无法读取封面目录: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();
        if !file_name_str.starts_with(&expected_file_prefix) {
            continue;
        }

        fs::remove_file(&path).map_err(|e| format!("无法删除自定义封面文件: {}", e))?;
    }

    Ok(())
}

/// 删除指定游戏的封面目录（包含云端缓存和自定义封面）
pub async fn delete_game_cover_dir(game_id: i32) -> Result<(), String> {
    let game_cover_dir = reina_path::get_base_data_dir()?
        .join("covers")
        .join(format!("game_{}", game_id));

    if !game_cover_dir.exists() {
        return Ok(());
    }

    fs::remove_dir_all(&game_cover_dir)
        .map_err(|e| format!("无法删除游戏封面目录 {}: {}", game_cover_dir.display(), e))?;

    Ok(())
}

// ==================== 自定义封面备份 ====================

/// 备份所有自定义封面（仅自定义封面，不含云端缓存）
///
/// 将自定义封面文件复制到临时目录后压缩为 7z 文件，
/// 备份路径跟随数据库备份路径逻辑。
///
/// 压缩包内结构（解压后直接覆盖到数据目录即可）：
/// ```text
/// covers/
///   game_123/
///     cover_123_jpg_1703123456789.jpg
///   game_456/
///     cover_456_png_1703123456789.png
/// ```
#[command]
pub async fn backup_custom_covers(
    db: State<'_, DatabaseConnection>,
) -> Result<BackupResult, String> {
    let _operation_guard = acquire_database_operation_lock().await;
    ensure_database_backup_available()?;
    let backup_dir = resolve_backup_dir(&db).await?;
    let archive_name = next_cover_backup_filename(&backup_dir)?;
    backup_custom_covers_archive_to(&backup_dir, &archive_name)
}

/// 将自定义封面写入指定的备份文件。调用方必须已持有数据库操作锁。
pub(crate) fn backup_custom_covers_archive_to(
    backup_dir: &Path,
    archive_name: &str,
) -> Result<BackupResult, String> {
    // 1. 获取封面根目录
    let covers_dir = reina_path::get_base_data_dir()?.join("covers");
    if !covers_dir.exists() {
        return Ok(BackupResult {
            success: true,
            path: None,
            message: "没有自定义封面需要备份".to_string(),
        });
    }

    // 2. 创建临时目录，内层套 covers 文件夹方便用户直接覆盖
    let timestamp = chrono::Local::now().timestamp_millis();
    let temp_dir = std::env::temp_dir().join(format!("reina_covers_{}", timestamp));
    let covers_temp_dir = temp_dir.join("covers");

    // 3. 遍历 covers 目录，仅复制自定义封面文件
    let mut has_covers = false;
    let scan_result = scan_and_copy_custom_covers(&covers_dir, &covers_temp_dir, &mut has_covers);

    // 扫描失败时清理临时目录
    if let Err(e) = scan_result {
        fs::remove_dir_all(&temp_dir).ok();
        return Err(e);
    }

    if !has_covers {
        fs::remove_dir_all(&temp_dir).ok();
        return Ok(BackupResult {
            success: true,
            path: None,
            message: "没有自定义封面需要备份".to_string(),
        });
    }

    // 4. 压缩为 7z 文件
    let archive_path = backup_dir.join(archive_name);
    if archive_path.exists() {
        fs::remove_dir_all(&temp_dir).ok();
        return Err(format!(
            "封面备份文件已存在，拒绝覆盖: {}",
            archive_path.display()
        ));
    }

    let temporary_archive = temporary_cover_backup_path(&archive_path)?;
    let size = match create_7z_archive(&temp_dir, &temporary_archive).and_then(|size| {
        verify_7z_archive(&temporary_archive)?;
        Ok(size)
    }) {
        Ok(size) => size,
        Err(e) => {
            fs::remove_dir_all(&temp_dir).ok();
            fs::remove_file(&temporary_archive).ok();
            return Err(format!("压缩自定义封面失败: {}", e));
        }
    };

    if archive_path.exists() {
        fs::remove_dir_all(&temp_dir).ok();
        fs::remove_file(&temporary_archive).ok();
        return Err(format!(
            "封面备份文件已存在，拒绝覆盖: {}",
            archive_path.display()
        ));
    }
    if let Err(error) = fs::rename(&temporary_archive, &archive_path) {
        fs::remove_dir_all(&temp_dir).ok();
        fs::remove_file(&temporary_archive).ok();
        return Err(format!("提交自定义封面备份失败: {error}"));
    }

    // 5. 清理临时目录
    fs::remove_dir_all(&temp_dir).ok();

    log::info!(
        "自定义封面备份成功: {} ({} bytes)",
        archive_path.display(),
        size
    );

    Ok(BackupResult {
        success: true,
        path: Some(archive_path.to_string_lossy().to_string()),
        message: "自定义封面备份成功".to_string(),
    })
}

const MAX_CUSTOM_COVER_RESTORE_ENTRIES: usize = 100_000;
const MAX_CUSTOM_COVER_RESTORE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
struct CustomCoverArchiveFile {
    relative_path: PathBuf,
    size: u64,
}

#[derive(Debug, Clone)]
struct StagedCustomCover {
    active_path: PathBuf,
    staged_path: PathBuf,
}

/// 恢复 ReinaManager 自己生成的自定义封面归档。
/// 只替换 cover_{id}_* 文件；同目录的网络缓存始终保留。
#[command]
pub async fn restore_custom_covers(
    archive_path: String,
    db: State<'_, DatabaseConnection>,
) -> Result<CustomCoverRestoreResult, String> {
    let archive_path = PathBuf::from(archive_path);
    let archived_files = inspect_custom_cover_archive(&archive_path)?;

    let _operation_guard = acquire_database_operation_lock().await;
    ensure_database_backup_available()?;

    // 写入前先归档当前自定义封面；网络缓存不属于该归档，也不会被后续步骤操作。
    let backup_dir = resolve_backup_dir(&db).await?;
    let backup_name = next_cover_backup_filename(&backup_dir)?;
    let current_backup = backup_custom_covers_archive_to(&backup_dir, &backup_name)?;

    let data_dir = reina_path::get_base_data_dir()?;
    ensure_plain_directory(&data_dir, "数据目录")?;
    let workspace = create_custom_cover_restore_workspace(&data_dir)?;
    let extracted_root = workspace.join("extracted");
    let restore_result = (|| -> Result<usize, String> {
        fs::create_dir(&extracted_root)
            .map_err(|error| format!("创建封面恢复临时目录失败: {error}"))?;
        extract_custom_cover_archive(&archive_path, &extracted_root, &archived_files)?;

        let active_covers_dir = data_dir.join("covers");
        let staged_current = stage_current_custom_covers(&active_covers_dir, &workspace)?;
        let mut installed_paths = Vec::new();
        match install_restored_custom_covers(
            &data_dir,
            &extracted_root,
            &archived_files,
            &mut installed_paths,
        ) {
            Ok(()) => Ok(archived_files.len()),
            Err(error) => {
                let rollback_error =
                    rollback_custom_cover_restore(&staged_current, &installed_paths).err();
                match rollback_error {
                    Some(rollback_error) => Err(format!(
                        "恢复自定义封面失败: {error}；同时回滚当前封面失败，原文件仍暂存在 {}: {rollback_error}",
                        workspace.display()
                    )),
                    None => Err(format!("恢复自定义封面失败，已回滚当前封面: {error}")),
                }
            }
        }
    })();

    match restore_result {
        Ok(restored_count) => {
            let cleanup_warning = fs::remove_dir_all(&workspace)
                .err()
                .map(|error| format!("；旧自定义封面暂存保留在 {}: {error}", workspace.display()))
                .unwrap_or_default();
            Ok(CustomCoverRestoreResult {
                success: true,
                message: format!(
                    "已恢复 {restored_count} 个自定义封面；网络封面缓存未改动{cleanup_warning}"
                ),
                backup_path: current_backup.path,
                restored_count,
            })
        }
        Err(error) => Err(format!(
            "{error}；本次恢复临时目录保留在 {}，不会删除任何可能仍需找回的原封面",
            workspace.display()
        )),
    }
}

fn inspect_custom_cover_archive(
    archive_path: &Path,
) -> Result<Vec<CustomCoverArchiveFile>, String> {
    let metadata = fs::symlink_metadata(archive_path)
        .map_err(|error| format!("检查封面归档失败 {}: {error}", archive_path.display()))?;
    if !archive_path.is_absolute()
        || metadata.file_type().is_symlink()
        || !metadata.is_file()
        || !archive_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("7z"))
    {
        return Err("请选择普通的 .7z 自定义封面备份文件".to_string());
    }

    let reader = ArchiveReader::open(archive_path, Password::empty())
        .map_err(|error| format!("无法读取自定义封面备份: {error}"))?;
    let entries = &reader.archive().files;
    if entries.is_empty() {
        return Err("自定义封面备份为空".to_string());
    }
    if entries.len() > MAX_CUSTOM_COVER_RESTORE_ENTRIES {
        return Err("自定义封面备份条目过多，拒绝恢复".to_string());
    }

    let mut aliases = HashSet::new();
    let mut total_size = 0u64;
    let mut files = Vec::new();
    for entry in entries {
        if entry.is_anti_item
            || (entry.has_windows_attributes && entry.windows_attributes & 0x400 != 0)
        {
            return Err("自定义封面备份包含链接或删除条目，拒绝恢复".to_string());
        }
        let parsed = parse_custom_cover_archive_entry(&entry.name, entry.is_directory)?;
        let alias = entry.name.replace('\\', "/").to_ascii_lowercase();
        if !aliases.insert(alias) {
            return Err("自定义封面备份包含重复路径，拒绝恢复".to_string());
        }
        if let Some(relative_path) = parsed {
            total_size = total_size
                .checked_add(entry.size)
                .ok_or("自定义封面备份解压大小溢出")?;
            if total_size > MAX_CUSTOM_COVER_RESTORE_BYTES {
                return Err("自定义封面备份解压大小超出限制，拒绝恢复".to_string());
            }
            files.push(CustomCoverArchiveFile {
                relative_path,
                size: entry.size,
            });
        }
    }
    if files.is_empty() {
        return Err("归档中没有可恢复的自定义封面".to_string());
    }
    Ok(files)
}

fn parse_custom_cover_archive_entry(
    entry_name: &str,
    is_directory: bool,
) -> Result<Option<PathBuf>, String> {
    let normalized = entry_name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains('\0') {
        return Err("自定义封面备份包含不安全路径".to_string());
    }
    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
        || parts.first() != Some(&"covers")
    {
        return Err("自定义封面备份必须只包含 covers 目录".to_string());
    }
    if parts.len() == 1 && is_directory {
        return Ok(None);
    }
    let Some(game_id) = parts
        .get(1)
        .and_then(|part| part.strip_prefix("game_"))
        .and_then(|id| id.parse::<u32>().ok())
        .filter(|id| *id > 0)
    else {
        return Err("自定义封面备份包含无效游戏目录".to_string());
    };
    if parts.len() == 2 && is_directory {
        return Ok(None);
    }
    if parts.len() != 3 || is_directory {
        return Err("自定义封面备份包含不支持的目录结构".to_string());
    }
    let expected_prefix = format!("cover_{game_id}_");
    if !parts[2].starts_with(&expected_prefix) || parts[2].len() == expected_prefix.len() {
        return Err("自定义封面备份包含无效封面文件名".to_string());
    }
    Ok(Some(PathBuf::from("covers").join(parts[1]).join(parts[2])))
}

fn create_custom_cover_restore_workspace(data_dir: &Path) -> Result<PathBuf, String> {
    let nonce = chrono::Local::now()
        .timestamp_nanos_opt()
        .unwrap_or_default();
    for suffix in 0..100u32 {
        let workspace = data_dir.join(format!(
            ".covers.reina-restore-{}-{nonce}-{suffix}",
            std::process::id()
        ));
        match fs::create_dir(&workspace) {
            Ok(()) => return Ok(workspace),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建封面恢复临时目录失败: {error}")),
        }
    }
    Err("无法创建唯一封面恢复临时目录".to_string())
}

fn extract_custom_cover_archive(
    archive_path: &Path,
    extracted_root: &Path,
    files: &[CustomCoverArchiveFile],
) -> Result<(), String> {
    let expected = files
        .iter()
        .map(|file| (file.relative_path.clone(), file.size))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut reader = ArchiveReader::open(archive_path, Password::empty())
        .map_err(|error| format!("无法读取自定义封面备份: {error}"))?;
    reader
        .for_each_entries(|entry, input| {
            if entry.is_anti_item
                || (entry.has_windows_attributes && entry.windows_attributes & 0x400 != 0)
            {
                return Err(std::io::Error::other("归档内容在校验后包含不安全条目").into());
            }
            let Some(relative_path) =
                parse_custom_cover_archive_entry(&entry.name, entry.is_directory)
                    .map_err(std::io::Error::other)?
            else {
                return Ok(true);
            };
            let expected_size = expected
                .get(&relative_path)
                .ok_or_else(|| std::io::Error::other("归档内容在校验后发生变化"))?;
            let output = extracted_root.join(&relative_path);
            let parent = output
                .parent()
                .ok_or_else(|| std::io::Error::other("封面文件没有安全父目录"))?;
            fs::create_dir_all(parent)?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)?;
            let copied = std::io::copy(input, &mut file)?;
            if copied != *expected_size {
                return Err(std::io::Error::other("封面文件大小与归档声明不符").into());
            }
            file.flush()?;
            file.sync_all()?;
            Ok(true)
        })
        .map_err(|error| format!("解压自定义封面失败: {error}"))
}

fn stage_current_custom_covers(
    covers_dir: &Path,
    workspace: &Path,
) -> Result<Vec<StagedCustomCover>, String> {
    let metadata = match fs::symlink_metadata(covers_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(metadata) => metadata,
        Err(error) => return Err(format!("检查当前封面目录失败: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("当前封面目录不是可安全操作的普通目录".to_string());
    }

    let staged_root = workspace.join("previous").join("covers");
    let mut moved = Vec::new();
    for game_entry in
        fs::read_dir(covers_dir).map_err(|error| format!("读取当前封面目录失败: {error}"))?
    {
        let game_entry = game_entry.map_err(|error| format!("读取当前封面目录项失败: {error}"))?;
        let game_name = game_entry.file_name().to_string_lossy().to_string();
        let Some(game_id) = game_name
            .strip_prefix("game_")
            .and_then(|id| id.parse::<u32>().ok())
            .filter(|id| *id > 0)
        else {
            continue;
        };
        let game_path = game_entry.path();
        let game_metadata = fs::symlink_metadata(&game_path)
            .map_err(|error| format!("检查当前游戏封面目录失败: {error}"))?;
        if game_metadata.file_type().is_symlink() || !game_metadata.is_dir() {
            return Err(format!("当前游戏封面目录不安全: {}", game_path.display()));
        }
        let expected_prefix = format!("cover_{game_id}_");
        for file_entry in fs::read_dir(&game_path)
            .map_err(|error| format!("读取当前游戏封面目录失败: {error}"))?
        {
            let file_entry =
                file_entry.map_err(|error| format!("读取当前封面文件失败: {error}"))?;
            let file_name = file_entry.file_name().to_string_lossy().to_string();
            if !file_name.starts_with(&expected_prefix) || file_name.len() == expected_prefix.len()
            {
                continue;
            }
            let active_path = file_entry.path();
            let file_metadata = fs::symlink_metadata(&active_path)
                .map_err(|error| format!("检查当前自定义封面失败: {error}"))?;
            if file_metadata.file_type().is_symlink() || !file_metadata.is_file() {
                return Err(format!(
                    "当前自定义封面不是普通文件: {}",
                    active_path.display()
                ));
            }
            let staged_path = staged_root.join(&game_name).join(&file_name);
            if let Some(parent) = staged_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("创建当前封面暂存目录失败: {error}"))?;
            }
            if let Err(error) = fs::rename(&active_path, &staged_path) {
                let rollback_error = rollback_custom_cover_restore(&moved, &[]).err();
                return match rollback_error {
                    Some(rollback_error) => Err(format!(
                        "暂存当前自定义封面失败: {error}；已暂存的封面回滚失败: {rollback_error}"
                    )),
                    None => Err(format!("暂存当前自定义封面失败，已回滚: {error}")),
                };
            }
            moved.push(StagedCustomCover {
                active_path,
                staged_path,
            });
        }
    }
    Ok(moved)
}

fn install_restored_custom_covers(
    data_dir: &Path,
    extracted_root: &Path,
    files: &[CustomCoverArchiveFile],
    installed_paths: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let covers_dir = data_dir.join("covers");
    ensure_plain_directory(&covers_dir, "封面目录")?;
    for file in files {
        let source = extracted_root.join(&file.relative_path);
        let target = data_dir.join(&file.relative_path);
        let parent = target.parent().ok_or("封面恢复目标没有父目录")?;
        ensure_plain_directory(parent, "游戏封面目录")?;
        if fs::symlink_metadata(&target).is_ok() {
            return Err(format!("恢复目标已存在，拒绝覆盖: {}", target.display()));
        }
        fs::rename(&source, &target)
            .map_err(|error| format!("写入恢复的自定义封面失败: {error}"))?;
        installed_paths.push(target);
    }
    Ok(())
}

fn rollback_custom_cover_restore(
    staged_current: &[StagedCustomCover],
    installed_paths: &[PathBuf],
) -> Result<(), String> {
    for path in installed_paths.iter().rev() {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(format!("恢复的新封面不是普通文件: {}", path.display()));
            }
            Ok(_) => fs::remove_file(path)
                .map_err(|error| format!("移除未完成的新封面失败 {}: {error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "检查未完成的新封面失败 {}: {error}",
                    path.display()
                ));
            }
        }
    }
    for staged in staged_current.iter().rev() {
        if fs::symlink_metadata(&staged.active_path).is_ok() {
            return Err(format!("回滚目标已存在: {}", staged.active_path.display()));
        }
        fs::rename(&staged.staged_path, &staged.active_path).map_err(|error| {
            format!(
                "恢复原自定义封面失败 {} -> {}: {error}",
                staged.staged_path.display(),
                staged.active_path.display()
            )
        })?;
    }
    Ok(())
}

fn ensure_plain_directory(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Err(format!(
            "{label}不是可安全操作的普通目录: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| format!("创建{label}失败: {error}"))?;
            let metadata = fs::symlink_metadata(path)
                .map_err(|error| format!("检查新建{label}失败: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "{label}不是可安全操作的普通目录: {}",
                    path.display()
                ));
            }
            Ok(())
        }
        Err(error) => Err(format!("检查{label}失败: {error}")),
    }
}

pub(crate) fn next_cover_backup_filename(backup_dir: &Path) -> Result<String, String> {
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    for suffix in 0..1000 {
        let file_name = if suffix == 0 {
            format!("custom_covers_{timestamp}.7z")
        } else {
            format!("custom_covers_{timestamp}_{suffix:03}.7z")
        };
        if !backup_dir.join(&file_name).exists() {
            return Ok(file_name);
        }
    }
    Err("无法分配不重复的封面备份文件名".to_string())
}

/// 将当前封面目录从活动位置暂存到同级隐藏目录。
///
/// 数据库导入成功前不删除暂存目录；这样导入提交失败时可以将原封面原样放回。
/// 封面目录只作为新旧数据库之间的缓存隔离，真正的自定义封面已在导入前归档。
pub(crate) fn stage_covers_for_database_import() -> Result<Option<std::path::PathBuf>, String> {
    let data_dir = reina_path::get_base_data_dir()?;
    let covers_dir = data_dir.join("covers");
    let metadata = match fs::symlink_metadata(&covers_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "检查封面目录失败 {}: {error}",
                covers_dir.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "封面目录不是可安全暂存的普通目录: {}",
            covers_dir.display()
        ));
    }

    let nonce = chrono::Local::now()
        .timestamp_nanos_opt()
        .unwrap_or_default();
    for suffix in 0..100u32 {
        let staged_dir = data_dir.join(format!(
            ".covers.reina-before-import-{}-{nonce}-{suffix}",
            std::process::id()
        ));
        match fs::symlink_metadata(&staged_dir) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::rename(&covers_dir, &staged_dir).map_err(|error| {
                    format!(
                        "暂存导入前封面目录失败 {} -> {}: {error}",
                        covers_dir.display(),
                        staged_dir.display()
                    )
                })?;
                return Ok(Some(staged_dir));
            }
            Ok(_) => continue,
            Err(error) => {
                return Err(format!(
                    "检查封面暂存目录失败 {}: {error}",
                    staged_dir.display()
                ));
            }
        }
    }

    Err("无法分配封面暂存目录".to_string())
}

/// 导入失败时将封面目录恢复到原活动位置。
pub(crate) fn restore_staged_covers_after_database_import(staged_dir: &Path) -> Result<(), String> {
    let covers_dir = reina_path::get_base_data_dir()?.join("covers");
    if fs::symlink_metadata(&covers_dir).is_ok() {
        return Err(format!(
            "无法恢复暂存封面，活动封面目录已存在: {}",
            covers_dir.display()
        ));
    }
    fs::rename(staged_dir, &covers_dir).map_err(|error| {
        format!(
            "恢复导入前封面目录失败 {} -> {}: {error}",
            staged_dir.display(),
            covers_dir.display()
        )
    })
}

/// 新数据库已经提交后清理旧封面缓存；失败时保留暂存目录以便用户找回。
pub(crate) fn discard_staged_covers_after_database_import(staged_dir: &Path) -> Result<(), String> {
    fs::remove_dir_all(staged_dir).map_err(|error| {
        format!(
            "新数据库已导入，但清理旧封面缓存失败（已保留在 {}）: {error}",
            staged_dir.display()
        )
    })
}

fn temporary_cover_backup_path(archive_path: &Path) -> Result<std::path::PathBuf, String> {
    let file_name = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("封面备份路径包含无效文件名")?;
    let nonce = chrono::Local::now()
        .timestamp_nanos_opt()
        .unwrap_or_default();
    Ok(archive_path.with_file_name(format!(
        ".{file_name}.reina-creating-{}-{nonce}",
        std::process::id(),
    )))
}

/// 扫描 covers 目录并将自定义封面文件复制到临时目录
///
/// 只复制匹配 `cover_{game_id}_*` 模式的文件，跳过云端缓存（`cloud_*`）。
/// 无自定义封面的 game 目录不会被创建。
fn scan_and_copy_custom_covers(
    covers_dir: &Path,
    temp_dir: &Path,
    has_covers: &mut bool,
) -> Result<(), String> {
    let entries = fs::read_dir(covers_dir).map_err(|e| format!("无法读取封面目录: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let entry_path = entry.path();

        if !entry_path.is_dir() {
            continue;
        }

        let dir_name = entry.file_name().to_string_lossy().to_string();

        // 只处理 game_{id} 格式的目录
        let game_id_str = match dir_name.strip_prefix("game_") {
            Some(id) => id,
            None => continue,
        };

        // 自定义封面文件名格式：cover_{game_id}_{ext}_{timestamp}.{ext}
        let expected_prefix = format!("cover_{}", game_id_str);
        let mut game_has_covers = false;

        let file_entries = fs::read_dir(&entry_path)
            .map_err(|e| format!("无法读取游戏封面目录 {}: {}", dir_name, e))?;

        for file_entry in file_entries {
            let file_entry = file_entry.map_err(|e| format!("读取游戏封面目录项失败: {}", e))?;

            if !file_entry.path().is_file() {
                continue;
            }

            let file_name = file_entry.file_name().to_string_lossy().to_string();

            // 匹配 cover_{id}_ 前缀（自定义封面），精确匹配游戏ID避免 cover_1 匹配到 cover_10
            if !file_name.starts_with(&expected_prefix) {
                continue;
            }
            // 确保是 cover_{id}_ 格式（前缀后面紧跟下划线），而不是 cover_{id}10 等
            let rest = &file_name[expected_prefix.len()..];
            if !rest.starts_with('_') {
                continue;
            }

            // 首次为该游戏创建目录
            if !game_has_covers {
                let game_temp_dir = temp_dir.join(&dir_name);
                fs::create_dir_all(&game_temp_dir)
                    .map_err(|e| format!("创建临时目录失败: {}", e))?;
                game_has_covers = true;
            }

            let target_path = temp_dir.join(&dir_name).join(&file_name);
            fs::copy(file_entry.path(), &target_path)
                .map_err(|e| format!("复制自定义封面文件失败 {}: {}", file_name, e))?;
        }

        if game_has_covers {
            *has_covers = true;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        CustomCoverArchiveFile, inspect_custom_cover_archive, install_restored_custom_covers,
        parse_custom_cover_archive_entry, stage_current_custom_covers,
    };
    use crate::backup::archive::create_7z_archive;
    use std::fs;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "reina_custom_cover_restore_{label}_{}_{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ))
    }

    #[test]
    fn custom_cover_archive_paths_require_the_expected_layout() {
        assert!(parse_custom_cover_archive_entry("covers", true).is_ok());
        assert!(parse_custom_cover_archive_entry("covers/game_7", true).is_ok());
        assert!(parse_custom_cover_archive_entry("covers/game_7/cover_7_png_1.png", false).is_ok());
        assert!(parse_custom_cover_archive_entry("covers/game_7/cloud_7.png", false).is_err());
        assert!(
            parse_custom_cover_archive_entry("covers/game_7/cover_8_png_1.png", false).is_err()
        );
        assert!(
            parse_custom_cover_archive_entry("../covers/game_7/cover_7_png_1.png", false).is_err()
        );
        assert!(
            parse_custom_cover_archive_entry("covers/game_7/extra/cover_7_png_1.png", false)
                .is_err()
        );
    }

    #[test]
    fn generated_custom_cover_archive_uses_the_restore_layout() {
        let root = temp_root("archive_layout");
        let source = root.join("source");
        let archive = root.join("custom_covers_test.7z");
        fs::create_dir_all(source.join("covers/game_7")).unwrap();
        fs::write(source.join("covers/game_7/cover_7_png_1.png"), b"cover").unwrap();
        create_7z_archive(&source, &archive).unwrap();

        let files = inspect_custom_cover_archive(&archive).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].relative_path,
            PathBuf::from("covers/game_7/cover_7_png_1.png")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restoring_custom_covers_keeps_cloud_cache_files() {
        let root = temp_root("network_cache");
        let data_dir = root.join("data");
        let active_dir = data_dir.join("covers").join("game_7");
        let workspace = root.join("workspace");
        let extracted = workspace.join("extracted").join("covers").join("game_7");
        fs::create_dir_all(&active_dir).unwrap();
        fs::create_dir_all(&extracted).unwrap();
        fs::write(active_dir.join("cover_7_png_old.png"), b"old custom").unwrap();
        fs::write(active_dir.join("cloud_7.jpg"), b"network cache").unwrap();
        fs::write(extracted.join("cover_7_png_new.png"), b"new custom").unwrap();

        let staged = stage_current_custom_covers(&data_dir.join("covers"), &workspace).unwrap();
        assert_eq!(staged.len(), 1);
        let files = vec![CustomCoverArchiveFile {
            relative_path: PathBuf::from("covers/game_7/cover_7_png_new.png"),
            size: 10,
        }];
        let mut installed = Vec::new();
        install_restored_custom_covers(
            &data_dir,
            &workspace.join("extracted"),
            &files,
            &mut installed,
        )
        .unwrap();

        assert_eq!(
            fs::read(active_dir.join("cloud_7.jpg")).unwrap(),
            b"network cache"
        );
        assert_eq!(
            fs::read(active_dir.join("cover_7_png_new.png")).unwrap(),
            b"new custom"
        );
        assert_eq!(
            fs::read(workspace.join("previous/covers/game_7/cover_7_png_old.png")).unwrap(),
            b"old custom"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
