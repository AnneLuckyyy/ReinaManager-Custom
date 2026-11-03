use crate::database::repository::games_repository::GamesRepository;
use crate::utils::game_monitor::{
    MonitorTarget, monitor_game, stop_game_session, stop_steam_game, wait_for_steam_game,
};
use crate::utils::steam::steam_app_id_from_launch_id;
use log::{debug, info};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use tauri::{AppHandle, Manager, Runtime, State, command};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct LaunchResult {
    success: bool,
    message: String,

    process_id: Option<u32>,
    systemd_scope: Option<String>,
    warning: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StopResult {
    success: bool,
    message: String,
    terminated_count: u32,
}

#[command]
pub async fn launch_game<R: Runtime>(
    app_handle: AppHandle<R>,
    db: State<'_, DatabaseConnection>,
    game_id: u32,
    args: Option<Vec<String>>,
    launch_path: Option<String>,
    magpie_hotkey: Option<String>,
) -> Result<LaunchResult, String> {
    let _ = magpie_hotkey;
    let game = GamesRepository::find_by_id(db.inner(), game_id as i32)
        .await
        .map_err(|e| format!("查询游戏失败: {}", e))?
        .ok_or_else(|| format!("游戏不存在: {}", game_id))?;

    if game.launch_type == "steam" {
        let steam_launch_id = game
            .steam_launch_id
            .as_deref()
            .map(str::trim)
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| "Steam 启动 ID 无效，请重新关联 Steam 启动项".to_string())?;
        let steam_app_id = steam_app_id_from_launch_id(steam_launch_id)
            .map_err(|error| format!("{error}，请重新关联 Steam 启动项"))?;
        let steam_uri = format!("steam://rungameid/{steam_launch_id}");
        #[allow(deprecated)]
        app_handle
            .shell()
            .open(&steam_uri, None)
            .map_err(|error| format!("打开 Steam 启动项失败: {error}"))?;

        let process_id = wait_for_steam_game(steam_app_id)
            .await
            .map_err(|error| format!("{error}，本次游玩未开始计时"))?;
        monitor_game(
            app_handle.clone(),
            game_id,
            process_id,
            MonitorTarget::SteamAppId(steam_app_id),
        )
        .await;

        return Ok(LaunchResult {
            success: true,
            message: format!("已交由 Steam 启动游戏 ({steam_launch_id})"),
            process_id: Some(process_id),
            systemd_scope: None,
            warning: None,
        });
    }

    let game_path = launch_path
        .or(game.localpath)
        .ok_or_else(|| "游戏路径未设置".to_string())?;

    if !Path::new(&game_path).exists() {
        return Err(format!("游戏可执行文件不存在: {}", game_path));
    }

    let game_dir = match Path::new(&game_path).parent() {
        Some(dir) => dir,
        None => return Err("无法获取游戏目录路径".to_string()),
    };

    let exe_name = match Path::new(&game_path).file_name() {
        Some(name) => name,
        None => return Err("无法获取游戏可执行文件名".to_string()),
    };

    let systemd_unit_name = format!("reina_game_{}.scope", game_id);
    let _ = check_scope_or_reset_failed(&systemd_unit_name).await;

    let mut command = {
        let linux_launch_command = app_handle
            .store("settings.json")
            .ok()
            .and_then(|store| store.get("linux_launch_command"))
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "wine".to_string());
        let linux_launch_command = expand_path(&app_handle, &linux_launch_command);
        debug!("使用的 Linux 启动命令: {:?}", linux_launch_command);

        let mut cmd = Command::new("systemd-run");
        cmd.arg("--scope");
        cmd.arg("--user");
        cmd.arg("-p");
        cmd.arg("Delegate=yes");
        cmd.arg("--unit");
        cmd.arg(&systemd_unit_name);

        if exe_name.to_string_lossy().ends_with(".exe") {
            cmd.arg(&linux_launch_command);
        }
        cmd.arg(&game_path);
        cmd.current_dir(game_dir);
        cmd
    };

    let args_clone = args.clone();
    if let Some(arguments) = &args_clone {
        command.args(arguments);
    }

    match command.spawn() {
        Ok(child) => {
            let process_id = child.id();

            monitor_game(
                app_handle.clone(),
                game_id,
                process_id,
                MonitorTarget::SystemdScope(systemd_unit_name.clone()),
            )
            .await;

            Ok(LaunchResult {
                success: true,
                message: format!(
                    "成功启动游戏: {}，工作目录: {:?}",
                    exe_name.to_string_lossy(),
                    game_dir
                ),
                process_id: Some(process_id),
                systemd_scope: Some(systemd_unit_name),
                warning: None,
            })
        }
        Err(e) => Err(format!("启动游戏失败: {}，目录: {:?}", e, game_dir)),
    }
}

#[command]
pub async fn stop_game(
    db: State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<StopResult, String> {
    let game = GamesRepository::find_by_id(db.inner(), game_id as i32)
        .await
        .map_err(|error| format!("查询游戏失败: {error}"))?
        .ok_or_else(|| format!("游戏不存在: {game_id}"))?;

    if game.launch_type == "steam" {
        let launch_id = game
            .steam_launch_id
            .as_deref()
            .map(str::trim)
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| "Steam 启动 ID 无效，请重新关联 Steam 启动项".to_string())?;
        let app_id = steam_app_id_from_launch_id(launch_id)
            .map_err(|error| format!("{error}，请重新关联 Steam 启动项"))?;
        let terminated_count = stop_steam_game(app_id)?;
        return Ok(StopResult {
            success: true,
            message: format!("成功停止游戏 {game_id}，终止进程数: {terminated_count}"),
            terminated_count,
        });
    }

    match stop_game_session(game_id).await {
        Ok(terminated_count) => Ok(StopResult {
            success: true,
            message: format!("成功停止游戏 {}，终止进程数: {}", game_id, terminated_count),
            terminated_count,
        }),
        Err(e) => Err(format!("停止游戏 {} 失败: {}", game_id, e)),
    }
}

fn expand_path<R: Runtime>(app_handle: &AppHandle<R>, path: &str) -> String {
    if path.starts_with('~') {
        // 使用 Tauri 提供的内置路径解析
        if let Ok(home_dir) = app_handle.path().home_dir() {
            path.replacen('~', &home_dir.to_string_lossy(), 1)
        } else {
            path.to_string()
        }
    } else {
        path.to_string()
    }
}

/// 在 Linux 上检查 systemd scope 的状态，如果是 failed 则重置它
/// 返回bool值表示scope是否已经存在
/// # Arguments
/// * `systemd_unit_name` - systemd 单元名称
///
/// # Returns
/// bool - 如果 scope 已存在则返回 true，否则返回 false
async fn check_scope_or_reset_failed(systemd_unit_name: &str) -> Result<bool, String> {
    use crate::utils::game_monitor::{get_connection, get_manager_proxy};
    let proxy = get_manager_proxy().await.map_err(|e| {
        format!(
            "连接到 systemd 失败，无法检查或重置单元 {}: {}",
            systemd_unit_name, e
        )
    })?;
    match proxy.get_unit(systemd_unit_name.to_string()).await {
        Ok(u) => {
            let conn = get_connection().await.map_err(|e| {
                format!(
                    "连接到 systemd 失败，无法检查或重置单元 {}: {}",
                    systemd_unit_name, e
                )
            })?;
            match zbus_systemd::systemd1::UnitProxy::new(conn, u).await {
                Ok(unit_proxy) => {
                    let active_state = unit_proxy
                        .active_state()
                        .await
                        .map_err(|e| format!("获取单元 {} 状态失败: {}", systemd_unit_name, e))?;
                    if active_state == "failed" {
                        proxy
                            .reset_failed_unit(systemd_unit_name.to_string())
                            .await
                            .map_err(|e| {
                                format!("重置单元 {} 状态失败: {}", systemd_unit_name, e)
                            })?;
                        info!("单元 {} 已被重置", systemd_unit_name);
                    }
                    Ok(true)
                }
                Err(_) => Ok(false),
            }
        }
        Err(_) => Ok(false),
    }
}
