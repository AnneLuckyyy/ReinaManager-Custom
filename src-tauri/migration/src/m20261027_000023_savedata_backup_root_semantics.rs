//! 将存档备份根目录配置转换为实际目录语义。
//!
//! 旧版把用户设置的目录当父目录，运行时额外拼接 `backups`。
//! 新规则直接保存实际备份根目录；本迁移仅转换配置文本，不移动、删除或扫描外部备份文件。

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use std::path::PathBuf;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        migrate_savedata_backup_roots(manager.get_connection()).await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "存档备份根目录迁移不可逆，无法区分旧配置和用户后来输入的新路径".to_string(),
        ))
    }
}

async fn migrate_savedata_backup_roots<C>(connection: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    let rows = connection
        .query_all(Statement::from_string(
            DatabaseBackend::Sqlite,
            "SELECT id, save_root_path FROM user \
             WHERE save_root_path IS NOT NULL AND trim(save_root_path) <> ''"
                .to_string(),
        ))
        .await?;

    for row in rows {
        let id = row.try_get::<i32>("", "id")?;
        let old_path = row.try_get::<String>("", "save_root_path")?;
        let new_path = PathBuf::from(old_path)
            .join(reina_path::BACKUP_SUBDIR)
            .to_string_lossy()
            .into_owned();
        connection
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "UPDATE user SET save_root_path = ? WHERE id = ?",
                [new_path.into(), id.into()],
            ))
            .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::Database;

    #[async_std::test]
    async fn converts_only_non_empty_legacy_roots() {
        let database = Database::connect("sqlite::memory:").await.unwrap();
        database
            .execute_unprepared(
                "CREATE TABLE user (id INTEGER PRIMARY KEY, save_root_path TEXT); \
                 INSERT INTO user(id, save_root_path) VALUES \
                 (1, 'configured'), (2, NULL), (3, '');",
            )
            .await
            .unwrap();

        migrate_savedata_backup_roots(&database).await.unwrap();

        let rows = database
            .query_all(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT id, save_root_path FROM user ORDER BY id".to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(
            rows[0]
                .try_get::<Option<String>>("", "save_root_path")
                .unwrap(),
            Some(
                PathBuf::from("configured")
                    .join(reina_path::BACKUP_SUBDIR)
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert_eq!(
            rows[1]
                .try_get::<Option<String>>("", "save_root_path")
                .unwrap(),
            None
        );
        assert_eq!(
            rows[2]
                .try_get::<Option<String>>("", "save_root_path")
                .unwrap(),
            Some(String::new())
        );
    }
}
