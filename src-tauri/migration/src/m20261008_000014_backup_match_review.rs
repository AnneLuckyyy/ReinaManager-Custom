//! 为压缩包关联增加“待人工确认”状态。

use crate::backup::backup_sqlite;
use log::{error, info};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        info!("[MIGRATION] Backing up database before backup match review migration...");
        match backup_sqlite("v0.20.4-backup-match-review").await {
            Ok(path) => info!("[MIGRATION] Backup successful: {:?}", path),
            Err(error) => error!("[MIGRATION] Backup failed (continuing): {}", error),
        }

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                ALTER TABLE backup_archive_matches
                    ADD COLUMN review_confirmed INTEGER NOT NULL DEFAULT 1;

                CREATE INDEX IF NOT EXISTS idx_backup_archive_matches_review
                    ON backup_archive_matches(review_confirmed);
                "#,
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                DROP INDEX IF EXISTS idx_backup_archive_matches_review;
                ALTER TABLE backup_archive_matches DROP COLUMN review_confirmed;
                "#,
            )
            .await?;
        Ok(())
    }
}
