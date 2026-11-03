//! 为当前改版新增受控下载目录和下载任务表。
//!
//! 不复用上游同号 migration，也不触碰 games、custom_data、115 表或既有路径字段。

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::ConnectionTrait;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(User::Table)
                    .add_column_if_not_exists(ColumnDef::new(User::DownloadRootPath).text().null())
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                CREATE TABLE IF NOT EXISTS tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL CHECK (trim(title) <> ''),
                    status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
                    url TEXT NOT NULL CHECK (trim(url) <> ''),
                    root_path TEXT NOT NULL CHECK (trim(root_path) <> ''),
                    progress_current INTEGER NOT NULL DEFAULT 0 CHECK (progress_current >= 0),
                    progress_total INTEGER NOT NULL CHECK (progress_total > 0),
                    error_message TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS tasks")
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(User::Table)
                    .drop_column(User::DownloadRootPath)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum User {
    Table,
    DownloadRootPath,
}
