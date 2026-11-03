//! 为 115 目录树导入增加独立备份索引表。

use crate::backup::backup_sqlite;
use log::{error, info};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        info!("[MIGRATION] Backing up database before backup catalog migration...");
        match backup_sqlite("v0.20.4-backup-catalog").await {
            Ok(path) => info!("[MIGRATION] Backup successful: {:?}", path),
            Err(error) => error!("[MIGRATION] Backup failed (continuing): {}", error),
        }

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                CREATE TABLE IF NOT EXISTS backup_catalog_sources (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    original_file_path TEXT NOT NULL,
                    imported_at TEXT NOT NULL,
                    archive_count INTEGER NOT NULL DEFAULT 0,
                    part_count INTEGER NOT NULL DEFAULT 0,
                    warning_count INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS backup_archives (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_id INTEGER NOT NULL,
                    identity_key TEXT NOT NULL,
                    relative_directory TEXT NOT NULL,
                    base_name TEXT NOT NULL,
                    archive_format TEXT NOT NULL,
                    volume_style TEXT NOT NULL,
                    part_count INTEGER NOT NULL,
                    sequence_status TEXT NOT NULL,
                    is_present INTEGER NOT NULL DEFAULT 1,
                    last_seen_at TEXT NOT NULL,
                    FOREIGN KEY (source_id) REFERENCES backup_catalog_sources(id) ON DELETE CASCADE,
                    UNIQUE (source_id, identity_key)
                );

                CREATE TABLE IF NOT EXISTS backup_archive_parts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    archive_id INTEGER NOT NULL,
                    file_name TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    part_number INTEGER,
                    FOREIGN KEY (archive_id) REFERENCES backup_archives(id) ON DELETE CASCADE,
                    UNIQUE (archive_id, relative_path)
                );

                CREATE INDEX IF NOT EXISTS idx_backup_archives_source_present
                    ON backup_archives(source_id, is_present);
                CREATE INDEX IF NOT EXISTS idx_backup_archives_base_name
                    ON backup_archives(base_name);
                CREATE INDEX IF NOT EXISTS idx_backup_archive_parts_archive
                    ON backup_archive_parts(archive_id);
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
                DROP TABLE IF EXISTS backup_archive_parts;
                DROP TABLE IF EXISTS backup_archives;
                DROP TABLE IF EXISTS backup_catalog_sources;
                "#,
            )
            .await?;
        Ok(())
    }
}
