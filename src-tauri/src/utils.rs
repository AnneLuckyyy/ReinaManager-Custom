#[cfg(target_os = "windows")]
pub mod command_ext;
pub mod drop_import;

pub mod app_launcher;
pub mod bgm_auth;
pub mod clipboard_cover;
pub mod disk_health;
pub mod dlsite_preview;
pub mod fs;
pub mod game_cover;
pub mod game_monitor;
pub mod launch;
pub mod legacy_migration;
pub mod logs;
pub mod scan;
pub mod steam;
pub mod system_proxy;
