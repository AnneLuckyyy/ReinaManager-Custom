//! 启动迁移的安全入口。
//!
//! 旧库在存在待执行迁移时先生成一次可校验快照；快照失败即停止，避免在没有回退点时改写用户数据库。

use crate::backup::backup_connected_database;
use crate::{Migrator, MigratorTrait};
use sea_orm_migration::sea_orm::{
    ConnectionTrait, DatabaseConnection, DbBackend, DbErr, Statement,
};

pub async fn migrate_database(
    connection: &DatabaseConnection,
    target_version: &str,
) -> Result<(), DbErr> {
    let pending_count = pending_migration_count(connection).await?;
    if pending_count == 0 {
        log::debug!("[MIGRATION] 数据库已是最新结构，无需执行迁移");
        return Ok(());
    }

    let backup_path = if has_existing_schema(connection).await? {
        let path = backup_connected_database(connection, target_version)
            .await
            .map_err(|error| DbErr::Custom(format!("迁移前数据库备份失败，已停止迁移: {error}")))?;
        log::info!(
            "[MIGRATION] 迁移前备份完成，target_version={}, pending={}, backup={}",
            target_version,
            pending_count,
            path.display()
        );
        Some(path)
    } else {
        log::info!(
            "[MIGRATION] 初始化新数据库，跳过迁移前备份，pending={}",
            pending_count
        );
        None
    };

    Migrator::up(connection, None).await.map_err(|error| {
        if let Some(path) = backup_path {
            DbErr::Custom(format!(
                "数据库迁移失败，迁移前备份保留在 {}: {error}",
                path.display()
            ))
        } else {
            error
        }
    })
}

async fn has_existing_schema<C>(connection: &C) -> Result<bool, DbErr>
where
    C: ConnectionTrait,
{
    Ok(connection
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' \
             AND name <> 'seaql_migrations' AND name NOT GLOB 'sqlite_*' LIMIT 1",
        ))
        .await?
        .is_some())
}

async fn pending_migration_count(connection: &DatabaseConnection) -> Result<usize, DbErr> {
    let migration_table_exists = connection
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seaql_migrations' LIMIT 1",
        ))
        .await?
        .is_some();
    if !migration_table_exists {
        return Ok(Migrator::migrations().len());
    }

    let row = connection
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT COUNT(*) AS count FROM seaql_migrations",
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("无法读取已执行的数据库迁移数量".to_string()))?;
    let applied_count: i64 = row.try_get("", "count")?;
    Ok(Migrator::migrations()
        .len()
        .saturating_sub(applied_count.max(0) as usize))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::path_to_sqlite_url;
    use sea_orm_migration::sea_orm::Database;
    use sea_orm_migration::SchemaManager;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn create_test_directory(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "reina_migration_{}_{}_{}",
            name,
            std::process::id(),
            unique
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[async_std::test]
    async fn existing_database_is_snapshotted_before_dlsite_columns_are_added() {
        let directory = create_test_directory("dlsite_pre_migration_snapshot");
        let database_path = directory.join("source.db");
        let connection = Database::connect(path_to_sqlite_url(&database_path).unwrap())
            .await
            .unwrap();
        Migrator::up(&connection, Some(14)).await.unwrap();
        connection
            .execute_unprepared(
                "INSERT INTO games(id, id_type, custom_data) \
                 VALUES (1, 'mixed', '{\"keep\":true}')",
            )
            .await
            .unwrap();
        connection
            .execute_unprepared("INSERT OR IGNORE INTO user(id) VALUES (1)")
            .await
            .unwrap();

        migrate_database(&connection, "0.20.5").await.unwrap();

        assert!(SchemaManager::new(&connection)
            .has_column("games", "dlsite_id")
            .await
            .unwrap());
        assert!(SchemaManager::new(&connection)
            .has_column("user", "install_root_path")
            .await
            .unwrap());
        let user = connection
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, install_root_path FROM user WHERE id = 1",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(user.try_get::<i32>("", "id").unwrap(), 1);
        assert_eq!(
            user.try_get::<Option<String>>("", "install_root_path")
                .unwrap(),
            None
        );
        let backup_paths = fs::read_dir(directory.join("backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(backup_paths.len(), 1);

        let backup = Database::connect(path_to_sqlite_url(&backup_paths[0]).unwrap())
            .await
            .unwrap();
        assert!(!SchemaManager::new(&backup)
            .has_column("games", "dlsite_id")
            .await
            .unwrap());
        let row = backup
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id_type, custom_data FROM games WHERE id = 1",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<String>("", "id_type").unwrap(), "mixed");
        assert_eq!(
            row.try_get::<String>("", "custom_data").unwrap(),
            "{\"keep\":true}"
        );

        backup.close().await.unwrap();
        connection.close().await.unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[async_std::test]
    async fn existing_download_tasks_keep_download_defaults_when_install_fields_are_added() {
        let directory = create_test_directory("install_task_fields");
        let database_path = directory.join("source.db");
        let connection = Database::connect(path_to_sqlite_url(&database_path).unwrap())
            .await
            .unwrap();
        Migrator::up(&connection, Some(20)).await.unwrap();
        connection
            .execute_unprepared(
                "INSERT INTO tasks(title, status, url, root_path, progress_current, progress_total, created_at, updated_at) \
                 VALUES ('old download', 'paused', 'https://example.com/file.7z', 'C:\\Downloads', 0, 123, 1, 1)",
            )
            .await
            .unwrap();

        migrate_database(&connection, "0.20.5").await.unwrap();

        let row = connection
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT task_kind, install_stage, install_root_path, source_provider, \
                 source_resource_id, archive_format, metadata_json, install_result_json, error_code \
                 FROM tasks WHERE title = 'old download'",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<String>("", "task_kind").unwrap(), "download");
        for column in [
            "install_stage",
            "install_root_path",
            "source_provider",
            "source_resource_id",
            "archive_format",
            "metadata_json",
            "install_result_json",
            "error_code",
        ] {
            assert_eq!(row.try_get::<Option<String>>("", column).unwrap(), None);
        }

        connection.close().await.unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}
