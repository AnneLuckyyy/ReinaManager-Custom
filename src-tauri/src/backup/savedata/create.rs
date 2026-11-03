use super::archive::create_savedata_archive;
use super::maintenance::{
    acquire_savedata_backup_operation_lock, cleanup_old_backups, resolve_savedata_backup_root,
};
use crate::database::repository::games_repository::GamesRepository;
use chrono::Utc;
use sea_orm::DatabaseConnection;
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::{State, command};

#[derive(Debug, Serialize)]
pub struct BackupInfo {
    pub folder_name: String,
    pub backup_time: i64,
    pub file_size: u64,
    pub backup_path: String,
}

#[command]
pub async fn create_savedata_backup(
    db: State<'_, DatabaseConnection>,
    game_id: i64,
    source_path: String,
) -> Result<BackupInfo, String> {
    let _operation_guard = acquire_savedata_backup_operation_lock().await;
    let source_path = Path::new(&source_path).to_path_buf();
    let source_metadata = fs::symlink_metadata(&source_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "源存档文件或文件夹不存在".to_string()
        } else {
            format!("检查源存档失败: {error}")
        }
    })?;
    super::fs_safety::reject_path_redirector(&source_metadata, &source_path)?;
    if !source_metadata.is_file() && !source_metadata.is_dir() {
        return Err("源存档必须是普通文件或文件夹".to_string());
    }
    let game_id = i32::try_from(game_id).map_err(|_| "游戏 ID 超出数据库范围".to_string())?;
    let backup_root = resolve_savedata_backup_root(&db).await?;
    let game_backup_dir = backup_root.join(format!("game_{game_id}"));
    fs::create_dir_all(&game_backup_dir).map_err(|error| format!("创建备份目录失败: {error}"))?;
    let now = Utc::now();
    let backup_filename = next_backup_filename(&game_backup_dir, game_id, now)?;
    let backup_file_path = game_backup_dir.join(&backup_filename);
    let backup_size = match create_savedata_archive(&source_path, &backup_file_path) {
        Ok(size) => size,
        Err(error) => {
            return Err(remove_failed_archive(
                &backup_file_path,
                format!("创建压缩包失败: {error}"),
            ));
        }
    };
    let database_size = match i64::try_from(backup_size) {
        Ok(size) => size,
        Err(_) => {
            return Err(remove_failed_archive(
                &backup_file_path,
                "备份文件大小超出数据库范围".to_string(),
            ));
        }
    };
    let backup_id = match GamesRepository::save_savedata_record(
        &db,
        game_id,
        &backup_filename,
        now.timestamp(),
        database_size,
    )
    .await
    {
        Ok(id) => id,
        Err(error) => {
            return Err(remove_failed_archive(
                &backup_file_path,
                format!("保存存档备份记录失败: {error}"),
            ));
        }
    };
    if let Err(error) = cleanup_old_backups(&db, &game_backup_dir, game_id, backup_id).await {
        log::warn!("新备份已创建，但清理旧备份失败 game_id={game_id}: {error}");
    }
    Ok(BackupInfo {
        folder_name: backup_filename,
        backup_time: now.timestamp(),
        file_size: backup_size,
        backup_path: backup_file_path.to_string_lossy().into_owned(),
    })
}

fn next_backup_filename(
    backup_dir: &Path,
    game_id: i32,
    now: chrono::DateTime<Utc>,
) -> Result<String, String> {
    let prefix = format!("savedata_v2_{game_id}_");
    let timestamp = now.format("%Y%m%d_%H%M%S").to_string();
    for suffix in 0..1000 {
        let name = if suffix == 0 {
            format!("{prefix}{timestamp}.7z")
        } else {
            format!("{prefix}{timestamp}_{suffix:03}.7z")
        };
        if matches!(fs::symlink_metadata(backup_dir.join(&name)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(name);
        }
    }
    Err("无法分配不重复的存档备份文件名".to_string())
}

fn remove_failed_archive(path: &Path, error: String) -> String {
    match fs::remove_file(path) {
        Ok(()) => error,
        Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => error,
        Err(cleanup_error) => format!("{error}；同时清理未登记归档失败: {cleanup_error}"),
    }
}
