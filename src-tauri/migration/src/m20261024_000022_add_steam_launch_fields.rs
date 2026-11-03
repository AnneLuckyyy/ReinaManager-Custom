//! 为 Steam 启动增加独立字段，不改变既有 `localpath` 的完整启动文件语义。
//!
//! 旧游戏全部保持 `local` 启动类型。Steam 的安装目录单独保存，避免目录被当作
//! 本地可执行文件而影响备用路径、自动换盘、打开目录或备份匹配名。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Games::Table)
                    .add_column_if_not_exists(
                        ColumnDef::new(Games::LaunchType)
                            .string()
                            .not_null()
                            .default("local"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Games::Table)
                    .add_column_if_not_exists(ColumnDef::new(Games::SteamLaunchId).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Games::Table)
                    .add_column_if_not_exists(ColumnDef::new(Games::SteamMonitorPath).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "此迁移无法回滚，请从迁移前备份恢复数据库".to_string(),
        ))
    }
}

#[derive(DeriveIden)]
enum Games {
    Table,
    LaunchType,
    SteamLaunchId,
    SteamMonitorPath,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[async_std::test]
    async fn keeps_existing_game_and_defaults_to_local_launch() {
        let database = Database::connect("sqlite::memory:").await.unwrap();
        database
            .execute_unprepared(
                "CREATE TABLE games (id INTEGER PRIMARY KEY, localpath TEXT); \
                 INSERT INTO games(id, localpath) VALUES (1, 'D:/Games/example.exe')",
            )
            .await
            .unwrap();

        Migration.up(&SchemaManager::new(&database)).await.unwrap();

        let row = database
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT localpath, launch_type, steam_launch_id, steam_monitor_path \
                 FROM games WHERE id = 1",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row.try_get::<Option<String>>("", "localpath").unwrap(),
            Some("D:/Games/example.exe".to_string())
        );
        assert_eq!(row.try_get::<String>("", "launch_type").unwrap(), "local");
        assert_eq!(
            row.try_get::<Option<String>>("", "steam_launch_id")
                .unwrap(),
            None
        );
        assert_eq!(
            row.try_get::<Option<String>>("", "steam_monitor_path")
                .unwrap(),
            None
        );
    }
}
