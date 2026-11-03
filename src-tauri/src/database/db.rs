use sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbErr, RuntimeErr};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{State, command};
use tokio::sync::{Mutex, MutexGuard};
use url::Url;

use crate::utils::fs::{
    backup_custom_covers_archive_to, discard_staged_covers_after_database_import,
    next_cover_backup_filename, restore_staged_covers_after_database_import,
    stage_covers_for_database_import,
};
use reina_path::{get_db_path, get_default_db_backup_path, is_portable_mode};

/// 数据库备份结果
#[derive(Debug, Serialize, Deserialize)]
pub struct BackupResult {
    pub success: bool,
    pub path: Option<String>,
    pub message: String,
}

/// 数据库导入结果
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    pub success: bool,
    pub message: String,
    pub backup_path: Option<String>,
    pub settings_snapshot: Option<String>,
}

const SETTINGS_SNAPSHOT_SUFFIX: &str = ".reina-settings.json";
const SETTINGS_SNAPSHOT_VERSION: u8 = 1;
const SETTINGS_SNAPSHOT_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PERSISTED_SETTINGS_KEYS: [&str; 4] = [
    "reina-manager-store",
    "reina-manager-mod-store",
    "reina-app-launcher",
    "i18nextLng",
];

#[derive(Debug, Deserialize)]
struct PersistentSettingsSnapshot {
    version: u8,
    stores: std::collections::BTreeMap<String, serde_json::Value>,
}

static DATABASE_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static DATABASE_BACKUP_AVAILABLE: AtomicBool = AtomicBool::new(true);

pub(crate) async fn acquire_database_operation_lock() -> MutexGuard<'static, ()> {
    DATABASE_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await
}

pub(crate) fn ensure_database_backup_available() -> Result<(), String> {
    if DATABASE_BACKUP_AVAILABLE.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err("数据库正在关闭或等待应用重启，无法继续备份".to_string())
    }
}

pub(crate) fn mark_database_backup_unavailable() {
    DATABASE_BACKUP_AVAILABLE.store(false, Ordering::Release);
}

// ==================== 数据库连接管理 ====================

/// Establish a SeaORM database connection.
pub async fn establish_connection() -> Result<DatabaseConnection, DbErr> {
    // 1. 获取数据库路径（自动判断便携模式）
    let db_path = get_db_path().map_err(|e| DbErr::Conn(RuntimeErr::Internal(e)))?;

    fn mode() -> &'static str {
        if is_portable_mode() {
            "便携"
        } else {
            "标准"
        }
    }

    // 2. 如果数据库不存在，创建目录
    if !db_path.exists() {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                DbErr::Conn(RuntimeErr::Internal(format!("无法创建数据库目录: {}", e)))
            })?;
        }
        log::info!("首次启动，创建{}模式数据库: {}", mode(), db_path.display());
    } else {
        log::info!("使用{}模式数据库: {}", mode(), db_path.display());
    }

    // 3. 使用 `url` crate 安全地构建连接字符串
    let db_url = Url::from_file_path(&db_path).map_err(|_| {
        DbErr::Conn(RuntimeErr::Internal(format!(
            "Invalid database path: {}",
            db_path.display()
        )))
    })?;

    let connection_string = format!("sqlite:{}?mode=rwc", db_url.path());

    // 4. 设置连接选项
    let mut options = ConnectOptions::new(connection_string);
    options
        .max_connections(1)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(8));

    // 5. 在开发模式下启用日志
    #[cfg(debug_assertions)]
    {
        options.sqlx_logging(false);
        println!("Database connection string: {}", options.get_url());
    }
    #[cfg(not(debug_assertions))]
    {
        options.sqlx_logging(false);
    }

    // 6. 连接数据库
    Database::connect(options).await
}

/// 关闭数据库连接
pub async fn close_connection(conn: DatabaseConnection) -> Result<(), DbErr> {
    conn.close().await?;
    Ok(())
}

// ==================== 数据库备份和导入 ====================

/// 生成带时间戳且不覆盖同秒现有备份的文件名。
fn generate_backup_filename(backup_dir: &Path) -> Result<String, String> {
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    for suffix in 0..1000 {
        let file_name = if suffix == 0 {
            format!("reina_manager_{}.db", timestamp)
        } else {
            format!("reina_manager_{}_{:03}.db", timestamp, suffix)
        };
        if !backup_dir.join(&file_name).exists() {
            return Ok(file_name);
        }
    }
    Err("无法分配不重复的数据库备份文件名".to_string())
}

fn temporary_backup_path(target_path: &Path) -> Result<PathBuf, String> {
    let file_name = target_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("备份路径包含无效文件名")?;
    let nonce = chrono::Local::now()
        .timestamp_nanos_opt()
        .unwrap_or_default();
    Ok(target_path.with_file_name(format!(
        ".{}.reina-creating-{}-{}",
        file_name,
        std::process::id(),
        nonce
    )))
}

fn settings_snapshot_path(database_path: &Path) -> Result<PathBuf, String> {
    let file_name = database_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("数据库备份路径包含无效文件名")?;
    Ok(database_path.with_file_name(format!("{file_name}{SETTINGS_SNAPSHOT_SUFFIX}")))
}

fn ensure_path_absent(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(format!("{label}已存在，拒绝覆盖: {}", path.display())),
        Err(error) => Err(format!("检查{label}失败 {}: {error}", path.display())),
    }
}

fn validate_settings_snapshot(snapshot: &str) -> Result<(), String> {
    if snapshot.len() as u64 > SETTINGS_SNAPSHOT_MAX_BYTES {
        return Err("设置快照超过允许大小".to_string());
    }
    let parsed: PersistentSettingsSnapshot = serde_json::from_str(snapshot)
        .map_err(|error| format!("设置快照不是有效 JSON: {error}"))?;
    if parsed.version != SETTINGS_SNAPSHOT_VERSION {
        return Err("设置快照版本不受支持".to_string());
    }
    if parsed.stores.len() != PERSISTED_SETTINGS_KEYS.len()
        || parsed
            .stores
            .keys()
            .any(|key| !PERSISTED_SETTINGS_KEYS.contains(&key.as_str()))
    {
        return Err("设置快照包含未知或缺失的持久化设置区".to_string());
    }
    for key in PERSISTED_SETTINGS_KEYS {
        match parsed.stores.get(key) {
            Some(serde_json::Value::String(_)) if key == "i18nextLng" => {}
            Some(serde_json::Value::Object(_)) | Some(serde_json::Value::Null) => {}
            _ => return Err(format!("设置快照中的 {key} 无效")),
        }
    }
    Ok(())
}

fn write_settings_snapshot_atomically(
    database_backup_path: &Path,
    snapshot: &str,
) -> Result<(), String> {
    use std::io::Write;

    validate_settings_snapshot(snapshot)?;
    let target_path = settings_snapshot_path(database_backup_path)?;
    ensure_path_absent(&target_path, "设置快照")?;
    let temporary_path = temporary_backup_path(&target_path)?;
    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| format!("创建临时设置快照失败: {error}"))?;
        file.write_all(snapshot.as_bytes())
            .map_err(|error| format!("写入临时设置快照失败: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步临时设置快照失败: {error}"))?;
        ensure_path_absent(&target_path, "设置快照")?;
        fs::rename(&temporary_path, &target_path)
            .map_err(|error| format!("提交设置快照失败: {error}"))
    })();
    if write_result.is_err() {
        fs::remove_file(&temporary_path).ok();
    }
    write_result
}

fn read_settings_snapshot_if_present(
    database_backup_path: &Path,
) -> Result<Option<String>, String> {
    let path = settings_snapshot_path(database_backup_path)?;
    let metadata = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(metadata) => metadata,
        Err(error) => return Err(format!("检查设置快照失败 {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("设置快照必须是普通文件: {}", path.display()));
    }
    if metadata.len() > SETTINGS_SNAPSHOT_MAX_BYTES {
        return Err(format!("设置快照超过允许大小: {}", path.display()));
    }
    let snapshot = fs::read_to_string(&path)
        .map_err(|error| format!("读取设置快照失败 {}: {error}", path.display()))?;
    validate_settings_snapshot(&snapshot)?;
    Ok(Some(snapshot))
}

fn remove_incomplete_database_backup(database_backup_path: &Path, reason: String) -> String {
    match fs::remove_file(database_backup_path) {
        Ok(()) => format!("{reason}；已撤销不完整的数据库备份"),
        Err(error) => format!(
            "{reason}；不完整的数据库备份保留在 {}: {error}",
            database_backup_path.display()
        ),
    }
}

pub(crate) fn copy_database_with_settings_atomically(
    source_path: &Path,
    target_path: &Path,
    settings_snapshot: &str,
) -> Result<(), String> {
    validate_settings_snapshot(settings_snapshot)?;
    ensure_path_absent(&settings_snapshot_path(target_path)?, "设置快照")?;
    copy_database_file_atomically(source_path, target_path)?;
    if let Err(error) = write_settings_snapshot_atomically(target_path, settings_snapshot) {
        return Err(remove_incomplete_database_backup(target_path, error));
    }
    Ok(())
}

pub(crate) fn copy_database_file_atomically(
    source_path: &Path,
    target_path: &Path,
) -> Result<(), String> {
    let expected_size = fs::metadata(source_path)
        .map_err(|error| format!("读取源数据库失败: {error}"))?
        .len();
    let temporary_path = temporary_backup_path(target_path)?;
    let copy_result = (|| {
        let copied_size = fs::copy(source_path, &temporary_path)
            .map_err(|error| format!("写入临时数据库备份失败: {error}"))?;
        if copied_size != expected_size {
            return Err(format!(
                "临时数据库备份大小不一致，期望 {expected_size} 字节，实际 {copied_size} 字节"
            ));
        }
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temporary_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("同步临时数据库备份失败: {error}"))?;
        fs::rename(&temporary_path, target_path)
            .map_err(|error| format!("提交数据库备份失败: {error}"))
    })();

    if copy_result.is_err() {
        fs::remove_file(&temporary_path).ok();
    }
    copy_result
}

fn validate_import_database_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("检查源数据库文件失败 {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("源数据库必须是普通文件: {}", path.display()));
    }
    let mut header = [0u8; 16];
    use std::io::Read;
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| format!("读取源数据库文件头失败 {}: {error}", path.display()))?;
    if &header != b"SQLite format 3\0" {
        return Err("所选文件不是有效的 SQLite 数据库".to_string());
    }
    Ok(())
}

fn validate_current_database_target(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(format!(
            "当前数据库不是可安全替换的普通文件: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "检查当前数据库替换目标失败 {}: {error}",
            path.display()
        )),
    }
}

fn import_staging_path(target_path: &Path, label: &str) -> Result<PathBuf, String> {
    let file_name = target_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("数据库路径包含无效文件名")?;
    let nonce = chrono::Local::now()
        .timestamp_nanos_opt()
        .unwrap_or_default();
    for suffix in 0..100u32 {
        let candidate = target_path.with_file_name(format!(
            ".{file_name}.reina-{label}-{}-{nonce}-{suffix}",
            std::process::id()
        ));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => return Err(format!("检查数据库暂存路径失败: {error}")),
        }
    }
    Err("无法分配数据库暂存路径".to_string())
}

/// 将已验证的导入副本以可回滚方式替换当前数据库。
fn commit_imported_database(
    prepared_path: &Path,
    target_path: &Path,
) -> Result<Option<String>, String> {
    let previous_path = if fs::symlink_metadata(target_path).is_ok() {
        Some(import_staging_path(target_path, "before-import")?)
    } else {
        None
    };
    if let Some(previous_path) = &previous_path {
        fs::rename(target_path, previous_path)
            .map_err(|error| format!("暂存导入前数据库失败 {}: {error}", target_path.display()))?;
    }
    if let Err(error) = fs::rename(prepared_path, target_path) {
        let rollback = previous_path
            .as_ref()
            .map(|previous_path| fs::rename(previous_path, target_path));
        return match rollback {
            Some(Ok(())) => Err(format!("提交导入数据库失败，已恢复原数据库: {error}")),
            Some(Err(rollback_error)) => Err(format!(
                "提交导入数据库失败且恢复原数据库失败；原数据库保留在 {}: {error}; {rollback_error}",
                previous_path.as_ref().unwrap().display()
            )),
            None => Err(format!("提交导入数据库失败: {error}")),
        };
    }
    if let Some(previous_path) = previous_path {
        if let Err(error) = fs::remove_file(&previous_path) {
            return Ok(Some(format!(
                "新数据库已导入，但旧数据库暂存未清理，保留在 {}: {error}",
                previous_path.display()
            )));
        }
    }
    Ok(None)
}

/// 解析备份目标目录（按需读取 user.db_backup_path）
pub async fn resolve_backup_dir(db: &DatabaseConnection) -> Result<PathBuf, String> {
    use crate::database::repository::settings_repository::DbSettingsExt;

    let settings = db.get_settings().await?;

    let backup_dir = if let Some(custom) = settings.db_backup_path_value() {
        PathBuf::from(custom)
    } else {
        get_default_db_backup_path()?
    };

    // 确保目录存在
    if !backup_dir.exists() {
        fs::create_dir_all(&backup_dir).map_err(|e| format!("无法创建备份目录: {}", e))?;
    }

    Ok(backup_dir)
}

/// 使用 VACUUM INTO 进行数据库热备份
///
/// 此方法使用 SQLite 的 VACUUM INTO 语句，可以在数据库正在使用时安全地创建备份。
/// VACUUM INTO 会创建一个优化后的数据库副本，同时保持原数据库的完整性。
///
/// 备份路径从数据库的 user 表中读取配置：
/// - 优先使用 user.db_backup_path（如果设置且非空）
/// - 否则使用默认路径
///
/// # Returns
///
/// 备份结果，包含备份文件的路径
#[command]
pub async fn backup_database(
    settings_snapshot: String,
    db: State<'_, DatabaseConnection>,
) -> Result<BackupResult, String> {
    let _operation_guard = acquire_database_operation_lock().await;
    ensure_database_backup_available()?;

    let backup_dir = resolve_backup_dir(&db).await?;
    let backup_name = generate_backup_filename(&backup_dir)?;
    backup_database_to(&db, &backup_dir, &backup_name, &settings_snapshot).await
}

/// 创建指定文件名的热备份。调用方必须已持有数据库操作锁。
pub(crate) async fn backup_database_to(
    db: &DatabaseConnection,
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
    validate_settings_snapshot(settings_snapshot)?;
    ensure_path_absent(&settings_snapshot_path(&target_path)?, "设置快照")?;
    let temporary_path = temporary_backup_path(&target_path)?;

    // 将路径转换为字符串
    // SQLite 在 Windows 上也支持正斜杠，使用正斜杠可以避免转义问题
    let temporary_path_str = temporary_path
        .to_str()
        .ok_or("备份路径包含无效字符")?
        .replace('\\', "/"); // 将所有反斜杠转换为正斜杠

    // 使用 VACUUM INTO 进行热备份
    // 只需要转义单引号，路径分隔符使用正斜杠不需要转义
    let escaped_path = temporary_path_str.replace('\'', "''");
    let vacuum_sql = format!("VACUUM INTO '{}'", escaped_path);

    // 执行 VACUUM INTO
    if let Err(error) = db.execute_unprepared(&vacuum_sql).await {
        fs::remove_file(&temporary_path).ok();
        return Err(format!("VACUUM INTO 备份失败: {error}"));
    }
    if target_path.exists() {
        fs::remove_file(&temporary_path).ok();
        return Err(format!(
            "数据库备份文件已存在，拒绝覆盖: {}",
            target_path.display()
        ));
    }
    if let Err(error) = fs::rename(&temporary_path, &target_path) {
        fs::remove_file(&temporary_path).ok();
        return Err(format!("提交数据库备份失败: {error}"));
    }
    if let Err(error) = write_settings_snapshot_atomically(&target_path, settings_snapshot) {
        return Err(remove_incomplete_database_backup(&target_path, error));
    }

    let target_path_str = target_path.to_string_lossy().to_string();

    log::info!("数据库热备份成功: {}", target_path_str);

    Ok(BackupResult {
        success: true,
        path: Some(target_path_str),
        message: "数据备份成功（含设置快照）".to_string(),
    })
}

/// 导入数据库文件（覆盖现有数据库）
///
/// # Arguments
///
/// * `source_path` - 要导入的数据库文件路径
///
/// # Returns
///
/// 导入结果，包含备份路径（如果备份成功）
#[command]
pub async fn import_database(
    source_path: String,
    current_settings_snapshot: String,
    db: State<'_, DatabaseConnection>,
) -> Result<ImportResult, String> {
    let src_path = PathBuf::from(&source_path);
    if !src_path.is_absolute() {
        return Err("源数据库路径必须是绝对路径".to_string());
    }
    if src_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("db")
    {
        return Err("无效的数据库文件，请选择 .db 文件".to_string());
    }
    validate_import_database_file(&src_path)?;
    validate_settings_snapshot(&current_settings_snapshot)
        .map_err(|error| format!("当前设置快照无效，当前数据库未修改: {error}"))?;
    let imported_settings_snapshot = read_settings_snapshot_if_present(&src_path)?;

    let target_db_path = get_db_path()?;
    if let (Ok(source), Ok(target)) = (
        fs::canonicalize(&src_path),
        fs::canonicalize(&target_db_path),
    ) && source == target
    {
        return Err("不能导入当前正在使用的数据库文件".to_string());
    }
    validate_current_database_target(&target_db_path)?;

    let _operation_guard = acquire_database_operation_lock().await;
    ensure_database_backup_available()?;

    // 在关闭连接前完成不可替代的封面归档。失败时绝不关闭或覆盖数据库。
    let backup_dir = resolve_backup_dir(&db).await?;
    let cover_backup_name = next_cover_backup_filename(&backup_dir)?;
    backup_custom_covers_archive_to(&backup_dir, &cover_backup_name)?;

    // 先在同一目录准备并校验导入副本；此时当前数据库和封面仍可照常使用。
    let prepared_path = import_staging_path(&target_db_path, "importing")?;
    if let Err(error) = copy_database_file_atomically(&src_path, &prepared_path)
        .and_then(|()| validate_import_database_file(&prepared_path))
    {
        fs::remove_file(&prepared_path).ok();
        return Err(format!("准备导入数据库失败，当前数据库未修改: {error}"));
    }

    // 暂存旧封面，使新数据库绝不读取旧 ID 的封面缓存；关闭连接失败时会回放。
    let staged_covers = match stage_covers_for_database_import() {
        Ok(staged_covers) => staged_covers,
        Err(error) => {
            fs::remove_file(&prepared_path).ok();
            return Err(format!("隔离旧封面缓存失败，当前数据库未修改: {error}"));
        }
    };

    // 步骤1：关闭数据库连接（必须先关闭才能安全备份和覆盖）
    let conn = db.inner().clone();
    if let Err(error) = close_connection(conn).await {
        fs::remove_file(&prepared_path).ok();
        let cover_rollback = staged_covers
            .as_deref()
            .map(restore_staged_covers_after_database_import)
            .transpose();
        return match cover_rollback {
            Ok(_) => Err(format!("关闭数据库连接失败，当前数据库未修改: {error}")),
            Err(rollback_error) => Err(format!(
                "关闭数据库连接失败，当前数据库未修改；同时恢复原封面缓存失败，暂存位置保留以便找回: {rollback_error}"
            )),
        };
    }
    mark_database_backup_unavailable();
    log::info!("数据库连接已关闭，准备备份和导入");

    // 步骤2：尽力冷备份旧数据库；失败时不放弃可回滚的导入提交。
    let result_backup_path = match generate_backup_filename(&backup_dir).and_then(|backup_name| {
        let backup_file_path = backup_dir.join(backup_name);
        copy_database_with_settings_atomically(
            &target_db_path,
            &backup_file_path,
            &current_settings_snapshot,
        )
        .map(|()| backup_file_path)
    }) {
        Ok(backup_file_path) => Some(backup_file_path.to_string_lossy().to_string()),
        Err(error) => {
            log::warn!("导入前冷备份失败: {error}，继续使用可回滚导入流程");
            None
        }
    };

    // 步骤3：提交数据库。失败时尝试回放旧封面目录。
    let database_warning = match commit_imported_database(&prepared_path, &target_db_path) {
        Ok(warning) => warning,
        Err(error) => {
            fs::remove_file(&prepared_path).ok();
            let cover_rollback = staged_covers
                .as_deref()
                .map(restore_staged_covers_after_database_import)
                .transpose();
            return match cover_rollback {
                Ok(_) => Err(error),
                Err(rollback_error) => Err(format!(
                    "{error}；同时恢复原封面缓存失败，暂存位置保留以便找回: {rollback_error}"
                )),
            };
        }
    };

    let mut warnings = database_warning.into_iter().collect::<Vec<_>>();
    let restored_settings_snapshot = if result_backup_path.is_some() {
        imported_settings_snapshot
    } else {
        if imported_settings_snapshot.is_some() {
            warnings
                .push("导入前完整备份失败，已保留当前设置，未应用所选备份的设置快照".to_string());
        }
        None
    };
    if let Some(staged_covers) = staged_covers
        && let Err(error) = discard_staged_covers_after_database_import(&staged_covers)
    {
        warnings.push(error);
    }
    log::info!(
        "数据库文件已安全导入: {} -> {:?}",
        source_path,
        target_db_path
    );

    // 导入成功，前端将负责重启应用以重新连接数据库
    Ok(ImportResult {
        success: true,
        message: if warnings.is_empty() {
            if restored_settings_snapshot.is_some() {
                "数据库和设置已导入，已备份自定义封面并清空封面缓存，应用将自动重启".to_string()
            } else {
                "数据库导入成功，已备份自定义封面并清空封面缓存，应用将自动重启".to_string()
            }
        } else {
            format!(
                "数据库导入成功，已备份自定义封面并清空封面缓存；{}",
                warnings.join("；")
            )
        },
        backup_path: result_backup_path,
        settings_snapshot: restored_settings_snapshot,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        copy_database_with_settings_atomically, settings_snapshot_path,
        validate_import_database_file,
    };
    use std::fs;

    fn valid_settings_snapshot() -> String {
        r#"{
            "version": 1,
            "stores": {
                "reina-manager-store": {"state": {}, "version": 0},
                "reina-manager-mod-store": {"state": {}, "version": 0},
                "reina-app-launcher": {"state": {}, "version": 2},
                "i18nextLng": "zh-CN"
            }
        }"#
        .to_string()
    }

    #[test]
    fn import_validation_requires_a_sqlite_header() {
        let root = std::env::temp_dir().join(format!(
            "reina_import_validation_{}_{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        let valid = root.join("valid.db");
        let invalid = root.join("invalid.db");
        fs::write(&valid, b"SQLite format 3\0test").unwrap();
        fs::write(&invalid, b"not a SQLite db").unwrap();

        assert!(validate_import_database_file(&valid).is_ok());
        assert!(validate_import_database_file(&invalid).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cold_backup_writes_database_and_matching_settings_snapshot() {
        let root = std::env::temp_dir().join(format!(
            "reina_database_snapshot_{}_{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.db");
        let target = root.join("backup.db");
        let snapshot = valid_settings_snapshot();
        fs::write(&source, b"SQLite format 3\0test database").unwrap();

        copy_database_with_settings_atomically(&source, &target, &snapshot).unwrap();

        assert_eq!(fs::read(&target).unwrap(), fs::read(&source).unwrap());
        assert_eq!(
            fs::read_to_string(settings_snapshot_path(&target).unwrap()).unwrap(),
            snapshot
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_settings_snapshot_does_not_create_database_backup() {
        let root = std::env::temp_dir().join(format!(
            "reina_database_snapshot_invalid_{}_{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.db");
        let target = root.join("backup.db");
        fs::write(&source, b"SQLite format 3\0test database").unwrap();

        assert!(copy_database_with_settings_atomically(&source, &target, "{}").is_err());
        assert!(!target.exists());
        assert!(!settings_snapshot_path(&target).unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }
}
