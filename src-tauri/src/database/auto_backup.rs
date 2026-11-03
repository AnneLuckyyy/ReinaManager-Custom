use super::db::{
    BackupResult, acquire_database_operation_lock, backup_database_to, close_connection,
    copy_database_with_settings_atomically, ensure_database_backup_available,
    mark_database_backup_unavailable, resolve_backup_dir,
};
use crate::utils::fs::backup_custom_covers_archive_to;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{State, command};

const DATABASE_AUTO_PREFIX: &str = "reina_manager_auto_";
const DATABASE_AUTO_EXTENSION: &str = ".db";
const DATABASE_AUTO_SETTINGS_SUFFIX: &str = ".db.reina-settings.json";
const COVERS_AUTO_PREFIX: &str = "custom_covers_auto_";
const COVERS_AUTO_EXTENSION: &str = ".7z";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoBackupTrigger {
    Scheduled,
    Exit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupRequest {
    pub trigger: AutoBackupTrigger,
    pub include_covers: bool,
    pub max_auto_backups: usize,
    pub settings_snapshot: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupResult {
    pub batch_id: String,
    pub database: BackupResult,
    pub covers: Option<BackupResult>,
    pub warnings: Vec<String>,
}

/// 创建自动数据库备份批次。只有带自动前缀的同批文件会参与清理。
#[command]
pub async fn create_auto_backup(
    request: AutoBackupRequest,
    db: State<'_, DatabaseConnection>,
) -> Result<AutoBackupResult, String> {
    let _operation_guard = acquire_database_operation_lock().await;
    ensure_database_backup_available()?;

    let backup_dir = resolve_backup_dir(&db).await?;
    let batch_id = next_auto_backup_batch_id(&backup_dir)?;
    let mut warnings = Vec::new();

    let covers = if request.include_covers {
        let archive_name = format!("{COVERS_AUTO_PREFIX}{batch_id}{COVERS_AUTO_EXTENSION}");
        match backup_custom_covers_archive_to(&backup_dir, &archive_name) {
            Ok(result) => Some(result),
            Err(error) => {
                log::warn!("自动备份批次 {batch_id} 的自定义封面备份失败: {error}");
                warnings.push(format!("自定义封面备份失败: {error}"));
                None
            }
        }
    } else {
        None
    };

    let database_name = format!("{DATABASE_AUTO_PREFIX}{batch_id}{DATABASE_AUTO_EXTENSION}");
    let database = match request.trigger {
        AutoBackupTrigger::Scheduled => {
            backup_database_to(&db, &backup_dir, &database_name, &request.settings_snapshot).await
        }
        AutoBackupTrigger::Exit => {
            let database_path = reina_path::get_db_path()?;
            close_connection(db.inner().clone())
                .await
                .map_err(|error| format!("关闭数据库连接失败: {error}"))?;
            mark_database_backup_unavailable();
            copy_database_file_cold_to(
                &database_path,
                &backup_dir,
                &database_name,
                &request.settings_snapshot,
            )
        }
    };

    let database = match database {
        Ok(result) => result,
        Err(error) => {
            if let Some(path) = covers.as_ref().and_then(|result| result.path.as_deref()) {
                if let Err(cleanup_error) = fs::remove_file(path) {
                    log::warn!(
                        "自动数据库备份失败后无法清理同批封面备份 batch_id={batch_id}: {cleanup_error}"
                    );
                }
            }
            return Err(error);
        }
    };

    if let Err(error) = cleanup_auto_backup_batches(&backup_dir, request.max_auto_backups) {
        log::warn!("自动备份批次 {batch_id} 已创建，但清理旧批次失败: {error}");
        warnings.push(format!("清理旧自动备份失败: {error}"));
    }

    Ok(AutoBackupResult {
        batch_id,
        database,
        covers,
        warnings,
    })
}

fn copy_database_file_cold_to(
    database_path: &Path,
    backup_dir: &Path,
    backup_name: &str,
    settings_snapshot: &str,
) -> Result<BackupResult, String> {
    let target_path = backup_dir.join(backup_name);
    if target_path.exists() {
        return Err(format!(
            "数据库备份文件已存在，拒绝覆盖: {}",
            target_path.display()
        ));
    }
    copy_database_with_settings_atomically(database_path, &target_path, settings_snapshot)?;
    Ok(BackupResult {
        success: true,
        path: Some(target_path.to_string_lossy().to_string()),
        message: "数据备份成功（含设置快照）".to_string(),
    })
}

fn next_auto_backup_batch_id(backup_dir: &Path) -> Result<String, String> {
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    for suffix in 0..1000 {
        let batch_id = format!("{timestamp}_{suffix:03}");
        let database_path = backup_dir.join(format!(
            "{DATABASE_AUTO_PREFIX}{batch_id}{DATABASE_AUTO_EXTENSION}"
        ));
        let covers_path = backup_dir.join(format!(
            "{COVERS_AUTO_PREFIX}{batch_id}{COVERS_AUTO_EXTENSION}"
        ));
        let settings_path = backup_dir.join(format!(
            "{DATABASE_AUTO_PREFIX}{batch_id}{DATABASE_AUTO_SETTINGS_SUFFIX}"
        ));
        if !database_path.exists() && !covers_path.exists() && !settings_path.exists() {
            return Ok(batch_id);
        }
    }
    Err("无法分配不重复的自动备份批次编号".to_string())
}

fn cleanup_auto_backup_batches(backup_dir: &Path, max_count: usize) -> Result<(), String> {
    let mut batches: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for entry in fs::read_dir(backup_dir).map_err(|error| format!("读取备份目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取备份文件失败: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取备份文件属性失败 {}: {error}", path.display()))?;
        if !metadata.file_type().is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if let Some(batch_id) = extract_auto_backup_batch_id(file_name) {
            batches.entry(batch_id.to_string()).or_default().push(path);
        }
    }

    let max_count = max_count.clamp(1, 30);
    let remove_count = batches.len().saturating_sub(max_count);
    for (_, paths) in batches.into_iter().take(remove_count) {
        for path in paths {
            fs::remove_file(&path)
                .map_err(|error| format!("删除旧自动备份失败 {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

fn extract_auto_backup_batch_id(file_name: &str) -> Option<&str> {
    file_name
        .strip_prefix(DATABASE_AUTO_PREFIX)
        .and_then(|name| name.strip_suffix(DATABASE_AUTO_EXTENSION))
        .or_else(|| {
            file_name
                .strip_prefix(DATABASE_AUTO_PREFIX)
                .and_then(|name| name.strip_suffix(DATABASE_AUTO_SETTINGS_SUFFIX))
        })
        .or_else(|| {
            file_name
                .strip_prefix(COVERS_AUTO_PREFIX)
                .and_then(|name| name.strip_suffix(COVERS_AUTO_EXTENSION))
        })
        .filter(|batch_id| !batch_id.is_empty())
}

#[cfg(test)]
mod tests {
    use super::cleanup_auto_backup_batches;
    use std::fs;

    #[test]
    fn cleanup_keeps_manual_and_latest_auto_batches() {
        let root = std::env::temp_dir().join(format!(
            "reina_auto_backup_cleanup_{}_{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        for batch in ["20260101_000000_000", "20260102_000000_000"] {
            fs::write(root.join(format!("reina_manager_auto_{batch}.db")), b"db").unwrap();
            fs::write(
                root.join(format!("reina_manager_auto_{batch}.db.reina-settings.json")),
                b"settings",
            )
            .unwrap();
            fs::write(
                root.join(format!("custom_covers_auto_{batch}.7z")),
                b"covers",
            )
            .unwrap();
        }
        fs::write(root.join("reina_manager_20260101_000000.db"), b"manual").unwrap();

        cleanup_auto_backup_batches(&root, 1).unwrap();

        assert!(
            !root
                .join("reina_manager_auto_20260101_000000_000.db")
                .exists()
        );
        assert!(
            !root
                .join("custom_covers_auto_20260101_000000_000.7z")
                .exists()
        );
        assert!(
            !root
                .join("reina_manager_auto_20260101_000000_000.db.reina-settings.json")
                .exists()
        );
        assert!(
            root.join("reina_manager_auto_20260102_000000_000.db")
                .exists()
        );
        assert!(
            root.join("custom_covers_auto_20260102_000000_000.7z")
                .exists()
        );
        assert!(
            root.join("reina_manager_auto_20260102_000000_000.db.reina-settings.json")
                .exists()
        );
        assert!(root.join("reina_manager_20260101_000000.db").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
