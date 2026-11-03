use crate::backup::savedata::fs_safety::reject_path_redirector;
use crate::database::repository::games_repository::GamesRepository;
use crate::database::repository::settings_repository::{DbSettingsExt, SettingsRepository};
use crate::entity::savedata::Model as SavedataModel;
use sea_orm::DatabaseConnection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{State, command};
use tokio::sync::{Mutex, MutexGuard};

static SAVEDATA_BACKUP_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) async fn acquire_savedata_backup_operation_lock() -> MutexGuard<'static, ()> {
    SAVEDATA_BACKUP_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await
}

pub(super) async fn resolve_savedata_backup_root(
    db: &DatabaseConnection,
) -> Result<PathBuf, String> {
    let settings = db.get_settings().await?;
    match settings.save_root_path_value() {
        Some(path) if !path.trim().is_empty() => Ok(PathBuf::from(path)),
        _ => reina_path::get_default_savedata_backup_path(),
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SavedataBackupDeleteStatus {
    Deleted,
    MissingFile,
    FileInaccessible,
}

#[derive(Debug, serde::Serialize)]
pub struct SavedataBackupDeleteResult {
    pub status: SavedataBackupDeleteStatus,
    pub message: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SavedataBackupMigrationStatus {
    Completed,
    SavedWithWarning,
}

#[derive(Debug, serde::Serialize)]
pub struct SavedataBackupRootMigrationResult {
    pub status: SavedataBackupMigrationStatus,
    pub old_path: String,
    pub new_path: String,
    pub message: String,
    pub residue_path: Option<String>,
}

#[command]
pub async fn delete_savedata_backup(
    db: State<'_, DatabaseConnection>,
    backup_id: i32,
) -> Result<SavedataBackupDeleteResult, String> {
    let _operation_guard = acquire_savedata_backup_operation_lock().await;
    let record = GamesRepository::get_savedata_record_by_id(&db, backup_id)
        .await
        .map_err(|error| format!("获取备份记录失败: {error}"))?
        .ok_or_else(|| "备份记录不存在".to_string())?;
    let path = resolve_savedata_backup_root(&db)
        .await?
        .join(format!("game_{}", record.game_id))
        .join(&record.file);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SavedataBackupDeleteResult {
                status: SavedataBackupDeleteStatus::MissingFile,
                message: Some(
                    "备份文件已经不存在；为避免误删记录，请选择“仅删除记录”后再确认".to_string(),
                ),
            });
        }
        Err(error) => {
            return Ok(SavedataBackupDeleteResult {
                status: SavedataBackupDeleteStatus::FileInaccessible,
                message: Some(format!("无法检查备份文件，记录已保留: {error}")),
            });
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(SavedataBackupDeleteResult {
            status: SavedataBackupDeleteStatus::FileInaccessible,
            message: Some("备份路径不是可安全删除的普通文件，记录已保留".to_string()),
        });
    }
    fs::remove_file(&path).map_err(|error| format!("删除备份文件失败，记录已保留: {error}"))?;
    GamesRepository::delete_savedata_record(&db, backup_id)
        .await
        .map_err(|error| format!("备份文件已删除，但删除记录失败: {error}"))?;
    Ok(SavedataBackupDeleteResult {
        status: SavedataBackupDeleteStatus::Deleted,
        message: None,
    })
}

#[command]
pub async fn delete_savedata_backup_record(
    db: State<'_, DatabaseConnection>,
    backup_id: i32,
) -> Result<(), String> {
    let _operation_guard = acquire_savedata_backup_operation_lock().await;
    GamesRepository::delete_savedata_record(&db, backup_id)
        .await
        .map_err(|error| format!("删除备份记录失败: {error}"))?;
    Ok(())
}

#[command]
pub async fn open_savedata_backup_folder(
    db: State<'_, DatabaseConnection>,
    game_id: i32,
) -> Result<(), String> {
    let folder = resolve_savedata_backup_root(&db)
        .await?
        .join(format!("game_{game_id}"));
    fs::create_dir_all(&folder).map_err(|error| format!("创建备份目录失败: {error}"))?;
    crate::utils::fs::open_directory(folder.to_string_lossy().into_owned()).await
}

/// 复制、核验、切换设置，最后才尝试清理旧根目录。
/// 任何准备或设置写入失败都会保留旧根目录和旧配置。
#[command]
pub async fn change_savedata_backup_root(
    db: State<'_, DatabaseConnection>,
    new_path: String,
) -> Result<SavedataBackupRootMigrationResult, String> {
    let _operation_guard = acquire_savedata_backup_operation_lock().await;
    let settings = db.get_settings().await?;
    let old_root = resolve_savedata_backup_root(&db).await?;
    let requested = new_path.trim();
    let new_root = if requested.is_empty() {
        reina_path::get_default_savedata_backup_path()?
    } else {
        let path = PathBuf::from(requested);
        if !path.is_absolute() {
            return Err("新的存档备份根目录必须是绝对路径，配置未修改".to_string());
        }
        path
    };
    let records = GamesRepository::get_all_savedata_records(&db)
        .await
        .map_err(|error| format!("读取存档备份记录失败: {error}"))?;
    if same_path_or_equivalent(&old_root, &new_root)? {
        if settings.save_root_path.as_deref() != (!requested.is_empty()).then_some(requested) {
            SettingsRepository::update_save_root_path(
                &db,
                (!requested.is_empty()).then_some(requested.to_string()),
            )
            .await
            .map_err(|error| format!("保存存档备份路径失败: {error}"))?;
        }
        return Ok(SavedataBackupRootMigrationResult {
            status: SavedataBackupMigrationStatus::Completed,
            old_path: old_root.to_string_lossy().into_owned(),
            new_path: new_root.to_string_lossy().into_owned(),
            message: "备份根目录未变化，配置已确认".to_string(),
            residue_path: None,
        });
    }
    if records.is_empty() {
        ensure_safe_new_root(&new_root)?;
        SettingsRepository::update_save_root_path(
            &db,
            (!requested.is_empty()).then_some(requested.to_string()),
        )
        .await
        .map_err(|error| format!("保存新的存档备份路径失败: {error}"))?;
        return Ok(SavedataBackupRootMigrationResult {
            status: SavedataBackupMigrationStatus::Completed,
            old_path: old_root.to_string_lossy().into_owned(),
            new_path: new_root.to_string_lossy().into_owned(),
            message: "没有历史存档备份，已更新备份根目录".to_string(),
            residue_path: None,
        });
    }

    ensure_safe_existing_root(&old_root)?;
    verify_savedata_records(&old_root, &records)?;
    ensure_roots_do_not_overlap(&old_root, &new_root)?;
    let prepared = prepare_copy_into_new_root(&old_root, &new_root)?;
    if let Err(error) = SettingsRepository::update_save_root_path(
        &db,
        (!requested.is_empty()).then_some(requested.to_string()),
    )
    .await
    {
        let rollback = rollback_prepared_root(&prepared);
        return Err(match rollback {
            Ok(()) => format!("保存新的存档备份路径失败，已回滚目录切换: {error}"),
            Err(rollback_error) => format!(
                "保存新的存档备份路径失败且目录回滚失败；新副本保留在 {}：{error}；回滚错误: {rollback_error}",
                prepared.new_root.display()
            ),
        });
    }
    match fs::remove_dir_all(&old_root) {
        Ok(()) => Ok(SavedataBackupRootMigrationResult {
            status: SavedataBackupMigrationStatus::Completed,
            old_path: old_root.to_string_lossy().into_owned(),
            new_path: new_root.to_string_lossy().into_owned(),
            message: "存档备份目录已完整核验并迁移，旧目录已清理".to_string(),
            residue_path: None,
        }),
        Err(error) => Ok(SavedataBackupRootMigrationResult {
            status: SavedataBackupMigrationStatus::SavedWithWarning,
            old_path: old_root.to_string_lossy().into_owned(),
            new_path: new_root.to_string_lossy().into_owned(),
            message: format!("备份目录已切换并验证，但旧目录清理失败: {error}"),
            residue_path: Some(old_root.to_string_lossy().into_owned()),
        }),
    }
}

#[derive(Debug)]
struct PreparedRootMove {
    new_root: PathBuf,
    staging_root: PathBuf,
    parked_empty_root: Option<PathBuf>,
}

fn ensure_safe_existing_root(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("旧备份根目录不可访问，配置未修改: {error}"))?;
    reject_path_redirector(&metadata, path)?;
    if !metadata.is_dir() {
        return Err("旧备份根目录不是普通目录，配置未修改".to_string());
    }
    Ok(())
}

fn ensure_safe_new_root(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("新的备份根目录没有父目录")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建新备份目录父路径失败: {error}"))?;
    ensure_safe_directory_chain(parent)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_path_redirector(&metadata, path)?;
            if !metadata.is_dir() {
                return Err("新的备份根目录已存在且不是普通目录".to_string());
            }
            if fs::read_dir(path)
                .map_err(|error| format!("读取新备份根目录失败: {error}"))?
                .next()
                .is_some()
            {
                return Err("新的备份根目录已有内容，拒绝覆盖".to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("检查新备份根目录失败: {error}")),
    }
    Ok(())
}

fn ensure_safe_directory_chain(path: &Path) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                reject_path_redirector(&metadata, candidate)?;
                if !metadata.is_dir() {
                    return Err(format!("备份路径父级不是目录: {}", candidate.display()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("检查备份路径父级失败: {error}")),
        }
        current = candidate.parent();
    }
    Ok(())
}

fn verify_savedata_records(root: &Path, records: &[SavedataModel]) -> Result<(), String> {
    for record in records {
        let path = root
            .join(format!("game_{}", record.game_id))
            .join(&record.file);
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "备份记录 {} 对应文件无法读取，配置未修改: {error}",
                record.id
            )
        })?;
        reject_path_redirector(&metadata, &path)?;
        if !metadata.is_file() {
            return Err(format!(
                "备份记录 {} 对应路径不是普通文件，配置未修改",
                record.id
            ));
        }
    }
    Ok(())
}

fn ensure_roots_do_not_overlap(old_root: &Path, new_root: &Path) -> Result<(), String> {
    let old =
        fs::canonicalize(old_root).map_err(|error| format!("解析旧备份根目录失败: {error}"))?;
    let new = normalized_path_for_missing_target(new_root)?;
    if new.starts_with(&old) || old.starts_with(&new) {
        return Err("新旧备份根目录相互包含，拒绝迁移以避免递归复制".to_string());
    }
    Ok(())
}

fn same_path_or_equivalent(first: &Path, second: &Path) -> Result<bool, String> {
    let first = normalized_path_for_missing_target(first)?;
    let second = normalized_path_for_missing_target(second)?;
    #[cfg(windows)]
    {
        Ok(first
            .to_string_lossy()
            .eq_ignore_ascii_case(&second.to_string_lossy()))
    }
    #[cfg(not(windows))]
    {
        Ok(first == second)
    }
}

fn normalized_path_for_missing_target(path: &Path) -> Result<PathBuf, String> {
    if let Ok(path) = fs::canonicalize(path) {
        return Ok(path);
    }
    let parent = path.parent().ok_or("路径没有父目录")?;
    let parent =
        fs::canonicalize(parent).map_err(|error| format!("解析路径父目录失败: {error}"))?;
    Ok(parent.join(path.file_name().ok_or("路径没有目录名")?))
}

fn prepare_copy_into_new_root(
    old_root: &Path,
    new_root: &Path,
) -> Result<PreparedRootMove, String> {
    ensure_safe_new_root(new_root)?;
    let parent = new_root.parent().ok_or("新的备份根目录没有父目录")?;
    let name = new_root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("新的备份根目录名称无效")?;
    let stamp = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let staging_root = parent.join(format!(".{name}.reina-copy-{stamp}"));
    fs::create_dir(&staging_root).map_err(|error| format!("创建备份迁移暂存目录失败: {error}"))?;
    if let Err(error) =
        copy_tree(old_root, &staging_root).and_then(|_| verify_tree(old_root, &staging_root))
    {
        let _ = fs::remove_dir_all(&staging_root);
        return Err(format!("复制并核验旧备份目录失败，配置未修改: {error}"));
    }
    let parked_empty_root = match fs::symlink_metadata(new_root) {
        Ok(_) => {
            let parked = parent.join(format!(".{name}.reina-empty-{stamp}"));
            fs::rename(new_root, &parked)
                .map_err(|error| format!("暂存空的新备份目录失败: {error}"))?;
            Some(parked)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_root);
            return Err(format!("检查新备份根目录失败: {error}"));
        }
    };
    if let Err(error) = fs::rename(&staging_root, new_root) {
        if let Some(parked) = &parked_empty_root {
            let _ = fs::rename(parked, new_root);
        }
        let _ = fs::remove_dir_all(&staging_root);
        return Err(format!("提交新的备份目录失败，配置未修改: {error}"));
    }
    Ok(PreparedRootMove {
        new_root: new_root.to_path_buf(),
        staging_root,
        parked_empty_root,
    })
}

fn rollback_prepared_root(prepared: &PreparedRootMove) -> Result<(), String> {
    fs::rename(&prepared.new_root, &prepared.staging_root)
        .map_err(|error| format!("移除新备份目录副本失败: {error}"))?;
    if let Some(parked) = &prepared.parked_empty_root {
        fs::rename(parked, &prepared.new_root)
            .map_err(|error| format!("恢复原空目录失败: {error}"))?;
    }
    fs::remove_dir_all(&prepared.staging_root)
        .map_err(|error| format!("清理新备份目录副本失败: {error}"))?;
    Ok(())
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|error| format!("读取备份目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取备份目录项失败: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("读取备份条目失败: {error}"))?;
        reject_path_redirector(&metadata, &source_path)?;
        if metadata.is_dir() {
            fs::create_dir(&target_path)
                .map_err(|error| format!("创建备份副本目录失败: {error}"))?;
            copy_tree(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("复制备份文件失败: {error}"))?;
        } else {
            return Err(format!("备份目录包含特殊对象: {}", source_path.display()));
        }
    }
    Ok(())
}

fn verify_tree(source: &Path, target: &Path) -> Result<(), String> {
    let source_metadata =
        fs::symlink_metadata(source).map_err(|error| format!("读取源副本失败: {error}"))?;
    let target_metadata =
        fs::symlink_metadata(target).map_err(|error| format!("读取目标副本失败: {error}"))?;
    reject_path_redirector(&source_metadata, source)?;
    reject_path_redirector(&target_metadata, target)?;
    if source_metadata.is_file() {
        if !target_metadata.is_file() || source_metadata.len() != target_metadata.len() {
            return Err(format!("备份文件副本校验失败: {}", source.display()));
        }
        return Ok(());
    }
    if !source_metadata.is_dir() || !target_metadata.is_dir() {
        return Err(format!("备份目录副本类型不一致: {}", source.display()));
    }
    let mut source_entries = fs::read_dir(source)
        .map_err(|error| format!("读取源目录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取源目录项失败: {error}"))?;
    let mut target_entries = fs::read_dir(target)
        .map_err(|error| format!("读取目标目录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取目标目录项失败: {error}"))?;
    source_entries.sort_by_key(|entry| entry.file_name());
    target_entries.sort_by_key(|entry| entry.file_name());
    if source_entries.len() != target_entries.len() {
        return Err("备份目录副本条目数量不一致".to_string());
    }
    for (source_entry, target_entry) in source_entries.into_iter().zip(target_entries) {
        if source_entry.file_name() != target_entry.file_name() {
            return Err("备份目录副本条目名称不一致".to_string());
        }
        verify_tree(&source_entry.path(), &target_entry.path())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "reina_savedata_root_{name}_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ))
    }

    #[test]
    fn copies_and_verifies_nested_backup_tree_before_any_switch() {
        let root = root("copy");
        let source = root.join("old_backups");
        let target = root.join("staging");
        fs::create_dir_all(source.join("game_1")).unwrap();
        fs::write(source.join("game_1/slot.7z"), b"archive").unwrap();
        fs::create_dir_all(&target).unwrap();

        copy_tree(&source, &target).unwrap();
        verify_tree(&source, &target).unwrap();
        assert_eq!(fs::read(target.join("game_1/slot.7z")).unwrap(), b"archive");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_overlapping_backup_roots() {
        let root = root("overlap");
        let old = root.join("old_backups");
        fs::create_dir_all(&old).unwrap();
        assert!(ensure_roots_do_not_overlap(&old, &old.join("nested")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_nonempty_target_root() {
        let root = root("target");
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep"), b"keep").unwrap();
        assert!(ensure_safe_new_root(&target).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

pub(super) async fn cleanup_old_backups(
    db: &DatabaseConnection,
    backup_dir: &Path,
    game_id: i32,
    protected_backup_id: i32,
) -> Result<(), String> {
    let game = GamesRepository::find_by_id(db, game_id)
        .await
        .map_err(|error| format!("获取游戏信息失败: {error}"))?
        .ok_or_else(|| "游戏不存在，无法清理旧备份".to_string())?;
    let max_backups = game.maxbackups.unwrap_or(20).max(1) as usize;
    let mut records = GamesRepository::get_savedata_records(db, game_id)
        .await
        .map_err(|error| format!("获取备份记录失败: {error}"))?;
    records.sort_by_key(|record| record.backup_time);
    while records.len() > max_backups {
        let Some(index) = records
            .iter()
            .position(|record| record.id != protected_backup_id)
        else {
            break;
        };
        let record = records.remove(index);
        let file = backup_dir.join(&record.file);
        let metadata = fs::symlink_metadata(&file)
            .map_err(|error| format!("检查旧备份失败 {}: {error}", file.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "旧备份不是普通文件，已停止清理: {}",
                file.display()
            ));
        }
        fs::remove_file(&file)
            .map_err(|error| format!("删除旧备份失败 {}: {error}", file.display()))?;
        GamesRepository::delete_savedata_record(db, record.id)
            .await
            .map_err(|error| format!("旧备份文件已删除，但删除记录失败: {error}"))?;
    }
    Ok(())
}
