pub use sea_orm_migration::prelude::*;

mod backup;
mod m20250927_000001_baseline_migration;
mod m20250928_000002_split_games_table;
mod m20250930_000003_add_collections;
mod m20251229_000004_hybrid_single_table;
mod m20260104_000005_add_le_magpie_fields;
mod m20260131_000006_migrate_clear_to_play_status;
mod m20260201_000007_clean_empty_strings;
mod m20260318_000008_add_vndb_token_and_collection_sync;
mod m20260331_000009_add_kungal_support;
mod m20260505_000010_remove_redundant_created_at;
mod m20260508_000011_bgm_oauth;
mod m20261008_000012_backup_catalog;
mod m20261008_000013_backup_archive_matches;
mod m20261008_000014_backup_match_review;
mod m20261019_000015_add_dlsite_support;
mod m20261020_000016_add_download_tasks;
mod m20261021_000017_add_download_file_details;
mod m20261021_000018_add_download_remote_validators;
mod m20261021_000019_add_download_source_expiration;
mod m20261022_000020_add_install_root_path;
mod m20261022_000021_add_install_task_fields;
mod m20261024_000022_add_steam_launch_fields;
mod m20261027_000023_savedata_backup_root_semantics;
mod m20261103_000024_add_download_task_automation;
mod m20261103_000025_add_game_archive_protection;
mod runner;

pub use runner::migrate_database;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20250927_000001_baseline_migration::Migration),
            Box::new(m20250928_000002_split_games_table::Migration),
            Box::new(m20250930_000003_add_collections::Migration),
            Box::new(m20251229_000004_hybrid_single_table::Migration),
            Box::new(m20260104_000005_add_le_magpie_fields::Migration),
            Box::new(m20260131_000006_migrate_clear_to_play_status::Migration),
            Box::new(m20260201_000007_clean_empty_strings::Migration),
            Box::new(m20260318_000008_add_vndb_token_and_collection_sync::Migration),
            Box::new(m20260331_000009_add_kungal_support::Migration),
            Box::new(m20260505_000010_remove_redundant_created_at::Migration),
            Box::new(m20260508_000011_bgm_oauth::Migration),
            Box::new(m20261008_000012_backup_catalog::Migration),
            Box::new(m20261008_000013_backup_archive_matches::Migration),
            Box::new(m20261008_000014_backup_match_review::Migration),
            Box::new(m20261019_000015_add_dlsite_support::Migration),
            Box::new(m20261020_000016_add_download_tasks::Migration),
            Box::new(m20261021_000017_add_download_file_details::Migration),
            Box::new(m20261021_000018_add_download_remote_validators::Migration),
            Box::new(m20261021_000019_add_download_source_expiration::Migration),
            Box::new(m20261022_000020_add_install_root_path::Migration),
            Box::new(m20261022_000021_add_install_task_fields::Migration),
            Box::new(m20261024_000022_add_steam_launch_fields::Migration),
            Box::new(m20261027_000023_savedata_backup_root_semantics::Migration),
            Box::new(m20261103_000024_add_download_task_automation::Migration),
            Box::new(m20261103_000025_add_game_archive_protection::Migration),
        ]
    }
}
