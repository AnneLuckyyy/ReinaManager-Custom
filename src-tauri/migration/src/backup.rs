use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use reina_path::get_db_path;
use sea_orm_migration::sea_orm::{
    ConnectionTrait, DatabaseConnection, DbBackend, DbErr, Statement,
};

/// 备份 SQLite 数据库文件。
///
/// 自动读取数据库中 `user.db_backup_path` 字段：
/// - 若存在且非空，则备份到该路径下
/// - 否则备份到数据库所在目录的 `backups/` 子目录
pub async fn backup_sqlite(version: &str) -> Result<PathBuf, DbErr> {
    let db_path =
        get_db_path().map_err(|e| DbErr::Custom(format!("Failed to get database path: {}", e)))?;
    let db_url = path_to_sqlite_url(&db_path)?;

    // 查询 user.db_backup_path
    let pool = sqlx::SqlitePool::connect(&db_url)
        .await
        .map_err(|e| DbErr::Custom(format!("Failed to connect: {}", e)))?;

    let custom_path: Option<String> = sqlx::query_scalar("SELECT db_backup_path FROM user LIMIT 1")
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten();

    pool.close().await;

    // 选择目标目录
    let target_dir = match custom_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => db_path.parent().unwrap().join("backups"),
    };

    fs::create_dir_all(&target_dir)
        .map_err(|e| DbErr::Custom(format!("Failed to create backup dir: {}", e)))?;

    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let backup_path = target_dir.join(format!("reina_manager_{}_{}.db", version, timestamp));

    fs::copy(&db_path, &backup_path)
        .map_err(|e| DbErr::Custom(format!("Failed to copy database: {}", e)))?;

    Ok(backup_path)
}

/// 将文件路径转换为 sqlite 连接 URL
pub fn path_to_sqlite_url(path: &Path) -> Result<String, DbErr> {
    let db_url = url::Url::from_file_path(path)
        .map_err(|_| DbErr::Custom("Invalid database path".to_string()))?;
    Ok(format!("sqlite:{}?mode=rwc", db_url.path()))
}

/// 为已存在的数据库创建经完整性检查的迁移前快照。
///
/// 此函数只接收当前已建立连接，以避免把备份错误地写到其他模式或其他数据库。
pub async fn backup_connected_database(
    connection: &DatabaseConnection,
    version: &str,
) -> Result<PathBuf, DbErr> {
    let database_path = connected_database_path(connection).await?;
    let source_url = sqlite_url(&database_path, "rw")?;
    let pool = sqlx::SqlitePool::connect(&source_url)
        .await
        .map_err(|error| DbErr::Custom(format!("无法打开待备份数据库: {error}")))?;
    let result = create_verified_snapshot(&pool, &database_path, version).await;
    pool.close().await;
    result
}

async fn connected_database_path(connection: &DatabaseConnection) -> Result<PathBuf, DbErr> {
    let databases = connection
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA database_list",
        ))
        .await?;

    for database in databases {
        if database.try_get::<String>("", "name")? == "main" {
            let file = database.try_get::<String>("", "file")?;
            if !file.is_empty() {
                return Ok(PathBuf::from(file));
            }
        }
    }

    Err(DbErr::Custom(
        "当前连接没有可备份的主数据库文件".to_string(),
    ))
}

fn sqlite_url(path: &Path, mode: &str) -> Result<String, DbErr> {
    let db_url =
        url::Url::from_file_path(path).map_err(|_| DbErr::Custom("数据库路径无效".to_string()))?;
    Ok(format!("sqlite:{}?mode={mode}", db_url.path()))
}

async fn create_verified_snapshot(
    pool: &sqlx::SqlitePool,
    database_path: &Path,
    version: &str,
) -> Result<PathBuf, DbErr> {
    verify_sqlite_integrity(pool, "原数据库").await?;

    let default_dir = database_path
        .parent()
        .ok_or_else(|| DbErr::Custom("数据库文件缺少父目录".to_string()))?
        .join("backups");
    let custom_dir = read_configured_backup_dir(pool).await?;

    if let Some(custom_dir) = custom_dir {
        match write_verified_snapshot(pool, version, &custom_dir).await {
            Ok(path) => return Ok(path),
            Err(error) => {
                log::warn!(
                    "[MIGRATION] 配置的迁移备份目录失败，将回退默认目录。custom_dir={}, error={}",
                    custom_dir.display(),
                    error
                );
            }
        }
    }

    write_verified_snapshot(pool, version, &default_dir).await
}

async fn read_configured_backup_dir(pool: &sqlx::SqlitePool) -> Result<Option<PathBuf>, DbErr> {
    let has_setting: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('user') WHERE name = 'db_backup_path')",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| DbErr::Custom(format!("检查数据库备份设置失败: {error}")))?;
    if !has_setting {
        return Ok(None);
    }

    let configured: Option<String> = sqlx::query_scalar("SELECT db_backup_path FROM user LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|error| DbErr::Custom(format!("读取数据库备份设置失败: {error}")))?
        .flatten();

    Ok(configured
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from))
}

async fn write_verified_snapshot(
    pool: &sqlx::SqlitePool,
    version: &str,
    target_dir: &Path,
) -> Result<PathBuf, DbErr> {
    std::fs::create_dir_all(target_dir).map_err(|error| {
        DbErr::Custom(format!(
            "无法创建迁移备份目录 {}: {error}",
            target_dir.display()
        ))
    })?;

    let stamp = Local::now().format("%Y%m%d_%H%M%S");
    let safe_version = version
        .trim_start_matches('v')
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '.' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let prefix = format!("reina_manager_pre_migration_v{safe_version}_{stamp}");
    let backup_path = (0..1000)
        .map(|suffix| {
            let suffix = if suffix == 0 {
                String::new()
            } else {
                format!("_{suffix:03}")
            };
            target_dir.join(format!("{prefix}{suffix}.db"))
        })
        .find(|path| !path.exists())
        .ok_or_else(|| DbErr::Custom("无法分配唯一的迁移备份文件名".to_string()))?;
    let temporary_path = backup_path.with_file_name(format!(
        ".{}.reina-creating-{}-{}",
        backup_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| DbErr::Custom("迁移备份文件名无效".to_string()))?,
        std::process::id(),
        Local::now().timestamp_nanos_opt().unwrap_or_default(),
    ));

    let result = async {
        let temporary_text = temporary_path.to_string_lossy().to_string();
        sqlx::query("VACUUM INTO ?")
            .bind(&temporary_text)
            .execute(pool)
            .await
            .map_err(|error| DbErr::Custom(format!("创建迁移前数据库快照失败: {error}")))?;

        let temporary_url = sqlite_url(&temporary_path, "ro")?;
        let backup_pool = sqlx::SqlitePool::connect(&temporary_url)
            .await
            .map_err(|error| DbErr::Custom(format!("无法打开临时迁移备份: {error}")))?;
        let integrity_result = verify_sqlite_integrity(&backup_pool, "迁移备份").await;
        backup_pool.close().await;
        integrity_result?;

        std::fs::rename(&temporary_path, &backup_path)
            .map_err(|error| DbErr::Custom(format!("提交迁移备份失败: {error}")))?;
        Ok(backup_path.clone())
    }
    .await;

    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

async fn verify_sqlite_integrity(pool: &sqlx::SqlitePool, label: &str) -> Result<(), DbErr> {
    let results: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(pool)
        .await
        .map_err(|error| DbErr::Custom(format!("检查{label}完整性失败: {error}")))?;
    if results.len() == 1 && results[0].eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(DbErr::Custom(format!(
            "{label}完整性检查失败: {}",
            results.join("; ")
        )))
    }
}
