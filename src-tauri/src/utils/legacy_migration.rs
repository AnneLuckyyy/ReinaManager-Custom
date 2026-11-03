use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use reina_path::{
    get_base_data_dir, get_base_data_dir_for_mode, get_local_data_dir_for_identifier,
};

use crate::utils::fs::move_file;

#[derive(Debug, Default)]
pub struct StartupMigrationResult {
    pub migrated_files: usize,
    pub replaced_files: usize,
    pub removed_legacy_files: usize,
    pub skipped: usize,
    pub executed: usize,
}

pub fn run_startup_migrations() -> Result<StartupMigrationResult, String> {
    let mut result = StartupMigrationResult::default();

    run_startup_migration(
        &mut result,
        m20261103_000002_migrate_wrong_release_web_storage,
    )?;
    run_startup_migration(&mut result, m20260326_000001_migrate_legacy_covers)?;

    Ok(result)
}

/// 曾有一次本地打包未加载发布配置，正式安装包错误地使用了开发标识
/// `com.reinamanager.localdev`。该身份的 WebView 本地存储中包含设置和
/// 应用页分类。正式身份没有这类状态时，安全地复制该状态；已有正式状态
/// 时绝不覆盖，避免把用户较新的正式数据回退。
fn m20261103_000002_migrate_wrong_release_web_storage() -> Result<StartupMigrationResult, String> {
    if cfg!(debug_assertions) {
        return Ok(StartupMigrationResult {
            skipped: 1,
            ..Default::default()
        });
    }

    const LEGACY_IDENTIFIER: &str = "com.reinamanager.localdev";
    const RELEASE_IDENTIFIER: &str = "com.reinamanager.dev";
    const MARKER_FILE: &str = ".migrated-localdev-web-storage";

    let legacy_root = get_local_data_dir_for_identifier(LEGACY_IDENTIFIER)?;
    let release_root = get_local_data_dir_for_identifier(RELEASE_IDENTIFIER)?;
    let marker = release_root.join(MARKER_FILE);

    if marker.exists() || !legacy_root.exists() {
        return Ok(StartupMigrationResult {
            skipped: 1,
            ..Default::default()
        });
    }

    let legacy_webview = legacy_root.join("EBWebView");
    // WebView 运行时会保留这个锁文件。源正式版尚在运行时不复制 LevelDB，
    // 以免得到不完整的状态；下次启动会自动再次检查。
    if legacy_webview.join("lockfile").exists() {
        return Ok(StartupMigrationResult {
            skipped: 1,
            ..Default::default()
        });
    }

    let legacy_storage = web_storage_dir(&legacy_root);
    if !contains_persisted_web_state(&legacy_storage)? {
        write_migration_marker(&marker, "legacy profile has no persisted application state")?;
        return Ok(StartupMigrationResult {
            executed: 1,
            skipped: 1,
            ..Default::default()
        });
    }

    let release_storage = web_storage_dir(&release_root);
    if contains_persisted_web_state(&release_storage)? {
        write_migration_marker(&marker, "kept existing release application state")?;
        return Ok(StartupMigrationResult {
            executed: 1,
            skipped: 1,
            ..Default::default()
        });
    }

    let release_default_dir = release_storage.parent().ok_or_else(|| {
        format!(
            "无法定位发布版 WebView 配置目录: {}",
            release_storage.display()
        )
    })?;
    fs::create_dir_all(release_default_dir).map_err(|error| {
        format!(
            "无法创建发布版 WebView 配置目录 {}: {error}",
            release_default_dir.display()
        )
    })?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成迁移时间戳: {error}"))?
        .as_secs();
    let staged_storage = release_default_dir.join(format!(".localdev-import-{stamp}"));
    copy_directory_without_links(&legacy_storage, &staged_storage)?;
    if !contains_persisted_web_state(&staged_storage)? {
        let _ = fs::remove_dir_all(&staged_storage);
        return Err("复制后的旧版应用状态校验失败".to_string());
    }

    let backup_storage = release_root
        .join("legacy-profile-backups")
        .join(format!("web-storage-before-localdev-{stamp}"));
    if release_storage.exists() {
        if let Some(parent) = backup_storage.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "无法创建 WebView 状态备份目录 {}: {error}",
                    parent.display()
                )
            })?;
        }
        fs::rename(&release_storage, &backup_storage).map_err(|error| {
            format!(
                "无法保留原正式版 WebView 状态 {}: {error}",
                release_storage.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(&staged_storage, &release_storage) {
        if backup_storage.exists() {
            let _ = fs::rename(&backup_storage, &release_storage);
        }
        return Err(format!("无法启用迁移后的 WebView 状态: {error}"));
    }
    write_migration_marker(&marker, "copied legacy localdev application state")?;

    Ok(StartupMigrationResult {
        executed: 1,
        migrated_files: 1,
        ..Default::default()
    })
}

fn web_storage_dir(app_local_data_root: &Path) -> PathBuf {
    app_local_data_root
        .join("EBWebView")
        .join("Default")
        .join("Local Storage")
}

fn contains_persisted_web_state(storage_dir: &Path) -> Result<bool, String> {
    const STATE_KEYS: [&[u8]; 3] = [
        b"reina-manager-store",
        b"reina-app-launcher",
        b"reina-manager-mod-store",
    ];

    let level_db_dir = storage_dir.join("leveldb");
    if !level_db_dir.is_dir() {
        return Ok(false);
    }

    for entry in fs::read_dir(&level_db_dir).map_err(|error| {
        format!(
            "无法读取 WebView 本地存储目录 {}: {error}",
            level_db_dir.display()
        )
    })? {
        let entry = entry.map_err(|error| format!("无法读取 WebView 本地存储项: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取 WebView 本地存储项类型: {error}"))?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let metadata = entry.metadata().map_err(|error| {
            format!("无法读取 WebView 本地存储文件 {}: {error}", path.display())
        })?;
        if metadata.len() > 64 * 1024 * 1024 {
            return Err(format!(
                "WebView 本地存储文件过大，拒绝迁移: {}",
                path.display()
            ));
        }
        let content = fs::read(&path).map_err(|error| {
            format!("无法读取 WebView 本地存储文件 {}: {error}", path.display())
        })?;
        if STATE_KEYS
            .iter()
            .any(|key| content.windows(key.len()).any(|window| window == *key))
        {
            return Ok(true);
        }
    }

    Ok(false)
}

fn copy_directory_without_links(source: &Path, destination: &Path) -> Result<(), String> {
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("无法读取迁移来源目录 {}: {error}", source.display()))?;
    if !source_metadata.is_dir() || source_metadata.file_type().is_symlink() {
        return Err(format!("迁移来源不是安全目录: {}", source.display()));
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("无法创建迁移暂存目录 {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("无法读取迁移来源目录 {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("无法读取迁移来源项: {error}"))?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取迁移来源项类型 {}: {error}", from.display()))?;
        if file_type.is_symlink() {
            return Err(format!("迁移来源包含链接，已拒绝复制: {}", from.display()));
        }
        if file_type.is_dir() {
            copy_directory_without_links(&from, &to)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to)
                .map_err(|error| format!("无法复制迁移来源文件 {}: {error}", from.display()))?;
        }
    }
    Ok(())
}

fn write_migration_marker(marker: &Path, outcome: &str) -> Result<(), String> {
    let parent = marker
        .parent()
        .ok_or_else(|| format!("无法定位迁移标记目录: {}", marker.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建迁移标记目录 {}: {error}", parent.display()))?;
    fs::write(marker, outcome)
        .map_err(|error| format!("无法写入迁移标记 {}: {error}", marker.display()))
}

fn run_startup_migration(
    aggregate: &mut StartupMigrationResult,
    migration: fn() -> Result<StartupMigrationResult, String>,
) -> Result<(), String> {
    let result = migration()?;

    aggregate.migrated_files += result.migrated_files;
    aggregate.replaced_files += result.replaced_files;
    aggregate.removed_legacy_files += result.removed_legacy_files;
    aggregate.skipped += result.skipped;
    aggregate.executed += result.executed;

    Ok(())
}

fn m20260326_000001_migrate_legacy_covers() -> Result<StartupMigrationResult, String> {
    let legacy_covers_dir = get_base_data_dir_for_mode(true)?.join("covers");
    let current_covers_dir = get_base_data_dir()?.join("covers");

    if current_covers_dir == legacy_covers_dir || !legacy_covers_dir.exists() {
        return Ok(StartupMigrationResult {
            skipped: 1,
            ..Default::default()
        });
    }

    if !legacy_covers_dir.is_dir() {
        return Err(format!(
            "旧版 covers 路径不是目录: {}",
            legacy_covers_dir.display()
        ));
    }

    fs::create_dir_all(&current_covers_dir).map_err(|e| {
        format!(
            "无法创建新的 covers 目录 {}: {}",
            current_covers_dir.display(),
            e
        )
    })?;

    let mut result = StartupMigrationResult {
        executed: 1,
        ..Default::default()
    };

    merge_covers_dir(&legacy_covers_dir, &current_covers_dir, &mut result)?;
    remove_dir_if_empty(&legacy_covers_dir)?;
    // 清理可能存在的空 resources 目录
    remove_dir_if_empty(&legacy_covers_dir)?;

    Ok(result)
}

fn merge_covers_dir(
    from_dir: &Path,
    to_dir: &Path,
    result: &mut StartupMigrationResult,
) -> Result<(), String> {
    for entry in fs::read_dir(from_dir)
        .map_err(|e| format!("读取 legacy covers 目录失败 {}: {}", from_dir.display(), e))?
    {
        let entry = entry.map_err(|e| format!("读取 legacy covers 项失败: {}", e))?;
        let from_path = entry.path();
        let to_path = to_dir.join(entry.file_name());

        if from_path.is_dir() {
            fs::create_dir_all(&to_path)
                .map_err(|e| format!("创建目标目录失败 {}: {}", to_path.display(), e))?;
            merge_covers_dir(&from_path, &to_path, result)?;
            remove_dir_if_empty(&from_path)?;
            continue;
        }

        if !from_path.is_file() {
            continue;
        }

        if !to_path.exists() {
            move_file(&from_path, &to_path)?;
            result.migrated_files += 1;
            continue;
        }

        if !to_path.is_file() {
            return Err(format!(
                "目标 covers 路径已存在且不是文件: {}",
                to_path.display()
            ));
        }

        let from_modified = file_modified_time(&from_path)?;
        let to_modified = file_modified_time(&to_path)?;

        if from_modified > to_modified {
            fs::remove_file(&to_path)
                .map_err(|e| format!("删除旧目标文件失败 {}: {}", to_path.display(), e))?;
            move_file(&from_path, &to_path)?;
            result.migrated_files += 1;
            result.replaced_files += 1;
        } else {
            fs::remove_file(&from_path)
                .map_err(|e| format!("删除 legacy 重复文件失败 {}: {}", from_path.display(), e))?;
            result.removed_legacy_files += 1;
        }
    }

    Ok(())
}

fn file_modified_time(path: &Path) -> Result<SystemTime, String> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|e| format!("读取文件修改时间失败 {}: {}", path.display(), e))
}

fn remove_dir_if_empty(path: &Path) -> Result<(), String> {
    if !path.exists() || !path.is_dir() {
        return Ok(());
    }

    let mut entries = fs::read_dir(path)
        .map_err(|e| format!("检查目录是否为空失败 {}: {}", path.display(), e))?;

    if entries.next().is_none() {
        fs::remove_dir(path).map_err(|e| format!("删除空目录失败 {}: {}", path.display(), e))?;
    }

    Ok(())
}
