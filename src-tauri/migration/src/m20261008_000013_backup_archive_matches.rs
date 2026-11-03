//! 为逻辑压缩包增加独立的游戏关联记录。

use crate::backup::backup_sqlite;
use log::{error, info};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        info!("[MIGRATION] Backing up database before backup match migration...");
        match backup_sqlite("v0.20.4-backup-matches").await {
            Ok(path) => info!("[MIGRATION] Backup successful: {:?}", path),
            Err(error) => error!("[MIGRATION] Backup failed (continuing): {}", error),
        }

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                CREATE TABLE IF NOT EXISTS backup_archive_matches (
                    archive_id INTEGER PRIMARY KEY,
                    game_id INTEGER,
                    status TEXT NOT NULL,
                    match_method TEXT NOT NULL,
                    match_score REAL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (archive_id) REFERENCES backup_archives(id) ON DELETE CASCADE,
                    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
                    CHECK (status IN ('matched', 'no_game')),
                    CHECK ((status = 'matched' AND game_id IS NOT NULL) OR
                           (status = 'no_game' AND game_id IS NULL))
                );

                CREATE INDEX IF NOT EXISTS idx_backup_archive_matches_game
                    ON backup_archive_matches(game_id);
                CREATE INDEX IF NOT EXISTS idx_backup_archive_matches_status
                    ON backup_archive_matches(status);

                CREATE TRIGGER IF NOT EXISTS trg_backup_matches_game_delete
                AFTER DELETE ON games
                BEGIN
                    DELETE FROM backup_archive_matches WHERE game_id = OLD.id;
                END;

                CREATE TRIGGER IF NOT EXISTS trg_backup_matches_archive_delete
                AFTER DELETE ON backup_archives
                BEGIN
                    DELETE FROM backup_archive_matches WHERE archive_id = OLD.id;
                END;
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
                DROP TRIGGER IF EXISTS trg_backup_matches_archive_delete;
                DROP TRIGGER IF EXISTS trg_backup_matches_game_delete;
                DROP TABLE IF EXISTS backup_archive_matches;
                "#,
            )
            .await?;
        Ok(())
    }
}
