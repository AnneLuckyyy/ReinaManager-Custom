mod backup;
mod backup_catalog;
mod database;
mod download_tasks;
mod entity;
mod install_archive;
mod shionlib_protocol;
mod utils;

use backup::savedata::{
    change_savedata_backup_root, create_savedata_backup, delete_savedata_backup,
    delete_savedata_backup_record, open_savedata_backup_folder, restore_savedata_backup,
};
use backup_catalog::{
    apply_backup_auto_matches, delete_backup_catalog_source, import_backup_catalog,
    list_backup_archives, list_backup_catalog_sources, list_game_backup_archives,
    list_game_backup_counts, preview_backup_catalog, set_backup_archive_match,
};
use database::*;
use database::{
    auto_backup::create_auto_backup,
    db::{backup_database, import_database},
};
use download_tasks::{
    DownloadTaskState, cancel_download_task, create_download_task, delete_download_task,
    discard_completed_download_archive_staging, extract_completed_download_archive,
    import_shionlib_installed_game, inspect_completed_download_archive, list_download_tasks,
    move_completed_download_archive_staging, pause_download_task, pause_interrupted_download_tasks,
    register_moved_download_game, restart_download_task, resume_download_task,
    update_download_task_automation,
};
use install_archive::{archive_game_directory, preflight_game_archive};
use migration::migrate_database;
use shionlib_protocol::{
    ShionlibProtocolState, create_shionlib_download_task, setup_shionlib_install_protocol,
    take_pending_shionlib_install_previews, take_pending_shionlib_install_rejections,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_store::StoreExt;
use url::Url;
use utils::{
    app_launcher::{
        copy_app_launcher_item_to_source, create_app_launcher_shortcut, get_app_launcher_icons,
        launch_app_launcher_item, open_app_launcher_item_location, resolve_app_launcher_paths,
        scan_app_launcher_folder,
    },
    bgm_auth::{bgm_oauth_exchange_code, bgm_oauth_refresh_token, bgm_oauth_start_login},
    clipboard_cover::import_clipboard_image_to_temp,
    disk_health::{
        check_disk_health_connection, prepare_disk_health_connection,
        prepare_disk_health_disconnection, read_disk_health,
    },
    dlsite_preview::register_dlsite_preview_protocol,
    drop_import::resolve_bulk_import_paths,
    fs::{
        backup_custom_covers, copy_file, delete_file, delete_game_covers, is_portable_mode,
        open_directory, restore_custom_covers,
    },
    game_cover::{delete_cloud_cache, register_game_cover_protocol},
    launch::{launch_game, stop_game},
    legacy_migration::run_startup_migrations,
    logs::{get_reina_log_level, set_reina_log_level},
    scan::scan_directory_for_games,
    steam::{resolve_steam_shortcut_file, scan_steam_launch_targets},
    system_proxy::get_windows_system_proxy,
};

const LOG_MAX_FILE_SIZE: u128 = 1_000_000;
const LOG_KEEP_FILE_COUNT: usize = 5;
const SETTINGS_STORE_PATH: &str = "settings.json";
const SILENT_AUTOSTART_STORE_KEY: &str = "silent_autostart";

#[derive(Default)]
struct SilentAutostartState(AtomicBool);

#[tauri::command]
fn is_silent_autostart_active(state: tauri::State<SilentAutostartState>) -> bool {
    state.0.load(Ordering::Relaxed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_dlsite_preview_protocol(register_game_cover_protocol(
        tauri::Builder::default().plugin(tauri_plugin_os::init()),
    ))
        // 单实例插件需要先接住浏览器给第二实例的安装链接，再交给已运行实例。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            for argument in args {
                if let Ok(url) = Url::parse(&argument) {
                    shionlib_protocol::enqueue_shionlib_install_url(app, url);
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        .difference(tauri_plugin_window_state::StateFlags::VISIBLE),
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--reina-autostart"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DownloadTaskState::default())
        .manage(ShionlibProtocolState::default())
		.manage(SilentAutostartState::default())
        .invoke_handler(tauri::generate_handler![
            // 工具类 commands
            launch_game,
            stop_game,
            scan_app_launcher_folder,
            resolve_app_launcher_paths,
            create_app_launcher_shortcut,
            copy_app_launcher_item_to_source,
            get_app_launcher_icons,
            launch_app_launcher_item,
            open_app_launcher_item_location,
            open_directory,
            is_portable_mode,
            scan_directory_for_games,
            resolve_bulk_import_paths,
            scan_steam_launch_targets,
            resolve_steam_shortcut_file,
            import_clipboard_image_to_temp,
			archive_game_directory,
			preflight_game_archive,
            copy_file,
            create_savedata_backup,
            delete_savedata_backup,
            delete_savedata_backup_record,
            change_savedata_backup_root,
            open_savedata_backup_folder,
            restore_savedata_backup,
            delete_file,
            delete_game_covers,
            delete_cloud_cache,
            backup_database,
            create_auto_backup,
            backup_custom_covers,
            restore_custom_covers,
            import_database,
            preview_backup_catalog,
            import_backup_catalog,
            list_backup_catalog_sources,
            delete_backup_catalog_source,
            list_backup_archives,
            list_game_backup_archives,
            list_game_backup_counts,
            set_backup_archive_match,
            apply_backup_auto_matches,
            create_download_task,
            list_download_tasks,
            inspect_completed_download_archive,
            extract_completed_download_archive,
            discard_completed_download_archive_staging,
            move_completed_download_archive_staging,
            register_moved_download_game,
            import_shionlib_installed_game,
            resume_download_task,
            restart_download_task,
            pause_download_task,
            cancel_download_task,
            delete_download_task,
			update_download_task_automation,
            take_pending_shionlib_install_previews,
            take_pending_shionlib_install_rejections,
            create_shionlib_download_task,
            // 游戏数据相关 commands
            insert_game,
            insert_games_batch,
            find_game_by_id,
            find_all_games,
            find_game_ids,
            update_game,
            delete_game,
            delete_games_batch,
            count_games,
            game_exists_by_bgm_id,
            game_exists_by_vndb_id,
            get_all_bgm_ids,
            get_all_vndb_ids,
            get_windows_system_proxy,
            update_games_batch,
            // 存档备份相关 commands
            save_savedata_record,
            get_savedata_count,
            get_savedata_records,
            // 游戏统计相关 commands
            record_game_session,
            get_game_sessions,
            get_recent_sessions_for_all,
            delete_game_session,
            update_game_statistics,
            get_game_statistics,
            get_multiple_game_statistics,
            get_all_game_statistics,
            delete_game_statistics,
            get_today_playtime,
            init_game_statistics,
            // 用户设置相关 commands
            get_all_settings,
            update_settings,
            // BGM OAuth 相关 commands
            bgm_oauth_start_login,
            bgm_oauth_exchange_code,
            bgm_oauth_refresh_token,
            // 日志相关 commands（运行时动态调整）
            set_reina_log_level,
            get_reina_log_level,
            read_disk_health,
            prepare_disk_health_connection,
            check_disk_health_connection,
            prepare_disk_health_disconnection,
            // 合集相关 commands
            create_collection,
            find_root_collections,
            update_collection,
            reorder_collection_categories,
            delete_collection,
            remove_games_from_collection,
            get_games_in_collection,
            get_game_collection_ids,
            add_games_to_collections,
            set_game_collections,
            update_category_games,
            batch_count_games_in_groups,
            count_games_in_group,
            get_categories_with_count,
			is_silent_autostart_active,
        ])
        .setup(|app| {
			// 必须在 WebView 创建和设置 Store 读取前处理历史错误安装包的状态。
			// 迁移只复制，不会触碰仍在运行的旧身份数据。
			let startup_migration_result = run_startup_migrations();
			let launched_by_autostart = std::env::args().any(|argument| {
				argument == "--reina-autostart" || argument == "--flag1"
			});
			let silent_autostart = match app.store(SETTINGS_STORE_PATH) {
				Ok(store) => store
					.get(SILENT_AUTOSTART_STORE_KEY)
					.and_then(|value| value.as_bool())
					.unwrap_or(false),
				Err(error) => {
					eprintln!("读取开机静默启动设置失败: {error}");
					false
				}
			};
			let should_start_silently = launched_by_autostart && silent_autostart;
			app.state::<SilentAutostartState>()
				.0
				.store(should_start_silently, Ordering::Relaxed);
			if should_start_silently {
				if let Some(window) = app.get_webview_window("main") {
					let _ = window.hide();
				}
			}
            setup_shionlib_install_protocol(app);
            // 仅在调试模式下自动打开开发者工具
            #[cfg(debug_assertions)]
            {
                // "main" 是他在 tauri.conf.json 中定义的窗口 label
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .timezone_strategy(TimezoneStrategy::UseLocal)
                        .level(log::LevelFilter::Debug) // 允许运行时动态调整到任意级别
                        .max_file_size(LOG_MAX_FILE_SIZE)
                        .rotation_strategy(RotationStrategy::KeepSome(LOG_KEEP_FILE_COUNT))
                        .targets([
                            Target::new(TargetKind::LogDir {
                                // set custom log file name for debug
                                file_name: Some("debug".into()),
                            }),
                            Target::new(TargetKind::Stdout),
                        ])
                        .build(),
                )?;
            } else {
                // 设置初始日志级别为 Info（运行时可通过命令调整）
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .timezone_strategy(TimezoneStrategy::UseLocal)
                        .level(log::LevelFilter::Info) // 允许运行时动态调整到任意级别
                        .max_file_size(LOG_MAX_FILE_SIZE)
                        .rotation_strategy(RotationStrategy::KeepSome(LOG_KEEP_FILE_COUNT))
                        .build(),
                )?;
            }

			match startup_migration_result {
                Ok(result) if result.executed == 0 => {
                    log::debug!("启动迁移检查完成，无需执行");
                }
                Ok(result) => {
                    log::info!(
                        "启动迁移完成: executed={}, skipped={}, moved={}, replaced={}, removed_legacy={}",
                        result.executed,
                        result.skipped,
                        result.migrated_files,
                        result.replaced_files,
                        result.removed_legacy_files
                    );
                }
                Err(err) => {
                    log::error!("启动迁移失败: {}", err);
                }
            }

            // 执行 SeaORM 数据库迁移并注册到状态管理
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                match db::establish_connection().await {
                    Ok(conn) => {
                        log::info!("数据库连接建立成功");

                        // 执行数据库迁移；已有数据库必须先完成可验证备份。
                        log::info!("开始执行数据库迁移...");
                        match migrate_database(&conn, env!("CARGO_PKG_VERSION")).await {
                            Ok(_) => log::info!("数据库迁移完成"),
                            Err(e) => {
                                log::error!("数据库迁移失败，已停止启动: {}", e);
                                panic!("数据库迁移失败，已停止启动: {}", e);
                            }
                        }

                        if let Err(error) = pause_interrupted_download_tasks(&conn).await {
                            log::error!("恢复下载任务状态失败: {error}");
                        }

                        // 将数据库连接注册到 Tauri 状态管理
                        app_handle.manage(conn.clone());
                    }
                    Err(e) => {
                        log::error!("无法建立数据库连接: {}", e);
                        panic!("数据库初始化失败: {}", e);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 监听应用退出事件
            if let tauri::RunEvent::Exit = event {
                // 同步获取并关闭数据库连接
                if let Some(conn_state) = app_handle.try_state::<sea_orm::DatabaseConnection>() {
                    let conn = conn_state.inner().clone();

                    // 使用 block_on 确保数据库连接在应用退出前完全关闭
                    tauri::async_runtime::block_on(async {
                        match db::close_connection(conn).await {
                            Ok(_) => log::info!("数据库连接已成功关闭"),
                            Err(e) => log::error!("关闭数据库连接时出错: {}", e),
                        }
                    });
                }
            }
        });
}
