//! 游戏监控模块
//!
//! 使用事件驱动架构监控游戏进程的运行状态，追踪游戏时间。
//! 包含前台窗口检测、进程切换处理、逃逸进程检测等功能。
//
// ============================================================================
// 外部依赖导入
// ============================================================================
use log::{debug, error, info, warn};
use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde_json::json;
use std::collections::HashSet;
use std::env::home_dir;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::OnceCell;
use tokio::time::{MissedTickBehavior, interval};

// ============================================================================
// 常量定义
// ============================================================================

/// 连续失败次数阈值，超过此值认为进程已结束
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// 时间更新事件发送间隔（秒）
const TIME_UPDATE_INTERVAL_SECS: u64 = 1;

/// 监控循环检查间隔（秒）
const MONITOR_CHECK_INTERVAL_SECS: u64 = 1;

/// 等待 Steam 拉起游戏进程的最长时间（秒）。
const STEAM_START_TIMEOUT_SECS: u64 = 60;

/// 等待 Steam 拉起游戏进程时的轮询间隔（秒）。
const STEAM_START_POLL_INTERVAL_SECS: u64 = 1;

/// Steam 客户端 PID 文件的候选位置（第二项支持 Flatpak 布局）。
const STEAM_PID_FILE_CANDIDATES: &[&str] = &[
    ".steam/steam.pid",
    ".var/app/com.valvesoftware.Steam/.steam/steam.pid",
];

// ============================================================================
// systemd 会话连接缓存
// ============================================================================

static SESSION_CONN: OnceCell<zbus::Connection> = OnceCell::const_new();
static MANAGER_PROXY: OnceCell<zbus_systemd::systemd1::ManagerProxy<'static>> =
    OnceCell::const_new();

/// 游戏进程的监控来源。
///
/// Steam 游戏不是 ReinaManager 创建的 systemd scope；它需要按 Steam 的 AppId
/// 在客户端进程树中找到 reaper 及其子进程。本地游戏则沿用既有 scope 逻辑。
#[derive(Clone, Debug)]
pub enum MonitorTarget {
    SystemdScope(String),
    SteamAppId(u32),
}

impl MonitorTarget {
    fn describe(&self) -> String {
        match self {
            Self::SystemdScope(scope) => format!("scope={scope}"),
            Self::SteamAppId(app_id) => format!("steam_app_id={app_id}"),
        }
    }
}

/// 启动监控任务
pub async fn monitor_game<R: Runtime>(
    app_handle: AppHandle<R>,
    game_id: u32,
    process_id: u32,
    target: MonitorTarget,
) {
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        if let Err(e) = run_game_monitor(app_handle_clone.app_handle(), game_id, &target).await {
            error!("游戏监控任务 (game_id: {}) 出错: {}", game_id, e);
            if let Err(e) = finalize_session(&app_handle, game_id, process_id, get_timestamp(), 0) {
                error!("无法完成游戏会话结束: {}", e);
            }
        }
    });
}

// ============================================================================
// 公共 API
// ============================================================================

/// 停止指定游戏的监控并终止所有相关进程
///
/// # Arguments
/// * `game_id` - 游戏 ID
///
/// # Returns
/// 成功返回终止的进程数量，失败返回错误信息
pub async fn stop_game_session(game_id: u32) -> Result<u32, String> {
    stop_game_unit(game_id).await.map(|_| 1)
}

async fn stop_game_unit(game_id: u32) -> Result<(), String> {
    // 1. 连接到 Session Bus (对应 --user)
    let proxy = get_manager_proxy().await.map_err(|e| {
        format!(
            "无法连接到 D-Bus Session Bus 以停止游戏 {} 的 systemd scope: {}",
            game_id, e
        )
    })?;

    // 2. 构造单元名称
    let unit_name = format!("reina_game_{}.scope", game_id);

    // 3. 调用停止方法
    match proxy
        .stop_unit(unit_name.clone(), "replace".to_string())
        .await
    {
        Ok(job_path) => {
            debug!("停止请求已发送: {}, Job: {:?}", unit_name, job_path);
        }
        Err(e) => {
            error!("停止单元失败: {:?}", e);
            return Err(e)
                .map_err(|e| format!("停止游戏 {} 的 systemd scope 失败: {}", game_id, e));
        }
    }

    Ok(())
}

pub async fn get_connection() -> Result<&'static zbus::Connection, zbus::Error> {
    SESSION_CONN
        .get_or_try_init(|| async { zbus::Connection::session().await })
        .await
}

pub async fn get_manager_proxy()
-> Result<&'static zbus_systemd::systemd1::ManagerProxy<'static>, zbus::Error> {
    MANAGER_PROXY
        .get_or_try_init(|| async {
            let connection = get_connection().await?;
            zbus_systemd::systemd1::ManagerProxy::new(connection).await
        })
        .await
}

/// 根据 systemd user scope 名称查找所有正在运行的进程 PID 列表 (仅 Linux)。
async fn get_process_id_by_scope(systemd_scope: &str) -> Option<Vec<u32>> {
    let manager = match get_manager_proxy().await {
        Ok(m) => m,
        Err(e) => {
            debug!("无法连接到 systemd 管理器: {}", e);
            return None;
        }
    };
    let ps = match manager.get_unit_processes(systemd_scope.to_owned()).await {
        Ok(p) => p,
        Err(e) => {
            debug!(
                "无法获取 systemd scope '{}' 的进程列表: {}",
                systemd_scope, e
            );
            return None;
        }
    };
    #[cfg(debug_assertions)]
    {
        debug!(
            "找到 systemd scope '{}' 下的进程 PID 列表: {:?}",
            systemd_scope, ps
        );
    }

    ps.into_iter().map(|p| p.1).collect::<Vec<u32>>().into()
}
/// 获取游戏进程 pidss
async fn get_all_candidate_pids(target: &MonitorTarget) -> Vec<u32> {
    let manager_pid = std::process::id();

    let available_pids: Vec<u32> = match target {
        MonitorTarget::SystemdScope(systemd_scope) => get_process_id_by_scope(systemd_scope)
            .await
            .unwrap_or_default(),
        MonitorTarget::SteamAppId(app_id) => find_steam_game_pids(*app_id),
    }
    .into_iter()
    .filter(|&pid| pid != manager_pid) // 过滤掉管理器自身
    .collect();

    if available_pids.is_empty() {
        debug!("未找到 {} 的匹配进程", target.describe());
    } else {
        debug!(
            "{} 找到 {} 个候选进程: {:?}",
            target.describe(),
            available_pids.len(),
            available_pids
        );
    }

    available_pids
}
#[allow(unused)]
fn is_process_running(pid: u32) -> bool {
    use std::fs::exists;
    // 在 Linux 上，可以通过检查 /proc/<pid> 目录是否存在来判断进程是否运行
    let proc_path = format!("/proc/{}", pid);
    exists(&proc_path).unwrap_or(false)
}

/// 检查指定的 systemd user scope 是否处于活动状态（仅 Linux）。
///# Arguments
/// * `systemd_scope` - systemd user scope 的名称。
/// # Returns
/// 如果 scope 处于活动状态，返回 true；否则返回 false。
async fn is_game_running(target: &MonitorTarget, cached_reaper_pid: &mut Option<u32>) -> bool {
    match target {
        MonitorTarget::SystemdScope(systemd_scope) => is_scope_active(systemd_scope).await,
        MonitorTarget::SteamAppId(app_id) => {
            if let Some(pid) = *cached_reaper_pid
                && is_steam_reaper_pid(pid, *app_id)
            {
                return true;
            }

            let previous = *cached_reaper_pid;
            let found = find_steam_reaper_pids(*app_id).into_iter().next();
            if found.is_some() && found != previous {
                debug!(
                    "{} 重新定位 Steam reaper PID: {previous:?} -> {found:?}",
                    target.describe()
                );
            }
            *cached_reaper_pid = found;
            found.is_some()
        }
    }
}

async fn is_scope_active(systemd_scope: &str) -> bool {
    match get_manager_proxy().await {
        Ok(manager) => match manager.get_unit(systemd_scope.to_owned()).await {
            Ok(u) => {
                if let Ok(connection) = get_connection().await {
                    match zbus_systemd::systemd1::UnitProxy::new(connection, u).await {
                        Ok(unit) => match unit.active_state().await {
                            Ok(state) => {
                                debug!(
                                    "systemd scope '{}' 的 active_state: {}",
                                    systemd_scope, state
                                );
                                state == "active"
                            }
                            Err(e) => {
                                error!(
                                    "无法获取 systemd scope '{}' 的 active_state: {}",
                                    systemd_scope, e
                                );
                                false
                            }
                        },
                        Err(e) => {
                            error!("无法创建 systemd Unit 代理: {}", e);
                            false
                        }
                    }
                } else {
                    error!("无法连接到 systemd 管理器");
                    false
                }
            }
            Err(e) => {
                error!("无法获取 systemd unit '{}': {}", systemd_scope, e);
                false
            }
        },
        Err(e) => {
            error!("无法连接到 systemd 管理器: {}", e);
            false
        }
    }
}

fn select_best_from_candidates(candidate_pids: &[u32]) -> Option<u32> {
    if let Some(p) = check_any_foreground(candidate_pids) {
        info!("从候选列表中找到聚焦进程 PID: {}", p);
        Some(p)
    } else if let Some(p) = check_any_has_window(candidate_pids) {
        info!("从候选列表中找到有窗口的进程 PID: {}", p);
        Some(p)
    } else if !candidate_pids.is_empty() {
        let first_pid = candidate_pids[0];
        info!("使用候选列表中的第一个进程 PID: {}", first_pid);
        Some(first_pid)
    } else {
        None
    }
}

/// TODO: 未来可考虑集成其他 wayland 合成器特定功能实现。
fn check_any_foreground(_candidate_pids: &[u32]) -> Option<u32> {
    check_any_foreground_x11(_candidate_pids)
}

/// TODO: 未来可考虑集成 x11 或 wayland 合成器特定功能实现。
fn check_any_has_window(_candidate_pids: &[u32]) -> Option<u32> {
    check_any_has_window_x11(_candidate_pids)
}

fn check_any_foreground_x11(candidate_pids: &[u32]) -> Option<u32> {
    // 1. 连接到 X Server
    let (conn, screen_num) = xcb::Connection::connect(None).ok()?;
    let setup = conn.get_setup();
    // 获取当前屏幕的根窗口 (Root Window)
    let screen = setup.roots().nth(screen_num as usize)?;
    let root_window = screen.root();

    // 2. 获取 Atom 标识符
    // 我们需要 "_NET_ACTIVE_WINDOW" 来找当前活动窗口
    // 我们需要 "_NET_WM_PID" 来找窗口对应的 PID
    let cookie_active = conn.send_request(&xcb::x::InternAtom {
        only_if_exists: true,
        name: b"_NET_ACTIVE_WINDOW",
    });
    let cookie_pid = conn.send_request(&xcb::x::InternAtom {
        only_if_exists: true,
        name: b"_NET_WM_PID",
    });

    let atom_active_window = conn.wait_for_reply(cookie_active).ok()?.atom();
    let atom_net_wm_pid = conn.wait_for_reply(cookie_pid).ok()?.atom();

    // 3. 获取当前活动窗口的 ID
    // 向 Root Window 请求 _NET_ACTIVE_WINDOW 属性
    let active_win_cookie = conn.send_request(&xcb::x::GetProperty {
        delete: false,
        window: root_window,
        property: atom_active_window,
        long_offset: 0,
        long_length: 1, // 我们只需要读 1 个值
        r#type: xcb::x::ATOM_WINDOW,
    });

    let active_win_reply = conn.wait_for_reply(active_win_cookie).ok()?;

    // 如果没有值，说明没有活动窗口或不支持 EWMH
    if active_win_reply.value::<xcb::x::Window>().is_empty() {
        return None;
    }

    // 提取 Window ID
    let active_window = active_win_reply
        .value::<xcb::x::Window>()
        .first()
        .copied()?;

    // 4. 获取该窗口的 PID
    // 向活动窗口请求 _NET_WM_PID 属性
    let pid_cookie = conn.send_request(&xcb::x::GetProperty {
        delete: false,
        window: active_window,
        property: atom_net_wm_pid,
        r#type: xcb::x::ATOM_CARDINAL, // PID 通常是 Cardinal 类型
        long_offset: 0,
        long_length: 1,
    });

    let pid_reply = conn.wait_for_reply(pid_cookie).ok()?;

    if pid_reply.value::<xcb::x::Window>().is_empty() {
        return None;
    }

    // 提取 PID
    let active_pid = pid_reply.value::<u32>().first().copied()?;

    // 5. 检查是否匹配
    if candidate_pids.contains(&active_pid) {
        Some(active_pid)
    } else {
        None
    }
}

fn check_any_has_window_x11(candidate_pids: &[u32]) -> Option<u32> {
    // 1. 连接到 X Server
    let (conn, screen_num) = xcb::Connection::connect(None).ok()?;
    let setup = conn.get_setup();
    let screen = setup.roots().nth(screen_num as usize)?;
    let root_window = screen.root();

    // 2. 获取需要的 Atom 标识符
    let cookie_client_list = conn.send_request(&xcb::x::InternAtom {
        only_if_exists: true,
        name: b"_NET_CLIENT_LIST",
    });
    let cookie_pid = conn.send_request(&xcb::x::InternAtom {
        only_if_exists: true,
        name: b"_NET_WM_PID",
    });

    let atom_client_list = conn.wait_for_reply(cookie_client_list).ok()?.atom();
    let atom_net_wm_pid = conn.wait_for_reply(cookie_pid).ok()?.atom();

    // 检查 atom 是否有效
    if atom_client_list == xcb::x::ATOM_NONE || atom_net_wm_pid == xcb::x::ATOM_NONE {
        return None;
    }

    // 3. 获取所有客户端窗口列表
    let client_list_cookie = conn.send_request(&xcb::x::GetProperty {
        delete: false,
        window: root_window,
        property: atom_client_list,
        r#type: xcb::x::ATOM_WINDOW,
        long_offset: 0,
        long_length: 1024, // 足够容纳大量窗口
    });

    let client_list_reply = conn.wait_for_reply(client_list_cookie).ok()?;
    let windows = client_list_reply.value::<xcb::x::Window>();

    if windows.is_empty() {
        return None;
    }

    // 4. 遍历所有窗口，检查其 PID 是否在候选列表中
    for &window in windows {
        let pid_cookie = conn.send_request(&xcb::x::GetProperty {
            delete: false,
            window,
            property: atom_net_wm_pid,
            r#type: xcb::x::ATOM_CARDINAL,
            long_offset: 0,
            long_length: 1,
        });

        if let Ok(pid_reply) = conn.wait_for_reply(pid_cookie) {
            if let Some(&pid) = pid_reply.value::<u32>().first() {
                if candidate_pids.contains(&pid) {
                    return Some(pid);
                }
            }
        }
    }

    None
}
async fn run_game_monitor(
    app_handle: &AppHandle<impl Runtime>,
    game_id: u32,
    target: &MonitorTarget,
) -> Result<(), String> {
    // Linux 版本的监控逻辑实现
    // {
    let mut accumulated_seconds = 0u64;
    let start_time = get_timestamp();
    tokio::time::sleep(Duration::from_secs(MONITOR_CHECK_INTERVAL_SECS * 3)).await;

    // 初始扫描：获取所有候选 PID
    let candidate_pids = get_all_candidate_pids(target).await;

    // 从候选中选择最佳 PID 作为主监控对象
    let mut best_pid = match select_best_from_candidates(&candidate_pids) {
        Some(p) => p,
        None => {
            return Err("未找到任何候选进程进行监控".to_string());
        }
    };

    info!(
        "开始监控游戏: ID={}, 最佳 PID={}, 候选进程组={:?}",
        game_id, best_pid, candidate_pids
    );

    // 通知前端会话开始
    app_handle
        .emit(
            "game-session-started",
            json!({ "gameId": game_id, "processId": best_pid, "startTime": start_time }),
        )
        .map_err(|e| format!("无法发送 game-session-started 事件: {}", e))?;
    let mut consecutive_failures = 0u32;
    let mut cached_reaper_pid = None;

    // 等待 3 秒让游戏进程充分启动（例如 Launcher -> Game 的切换）
    info!("等待 9 秒以便游戏进程充分启动...");
    tokio::time::sleep(Duration::from_secs(MONITOR_CHECK_INTERVAL_SECS * 9)).await;

    // 等待后重新扫描，获取最新的进程状态
    let mut candidate_pids = get_all_candidate_pids(target).await;
    if let Some(new_best) = select_best_from_candidates(&candidate_pids) {
        if new_best != best_pid {
            info!(
                "等待期间发现更优进程，切换 PID: {} -> {}",
                best_pid, new_best
            );
            best_pid = new_best;
        }
    }

    // 创建精确的 1 秒间隔定时器
    let mut tick_interval = interval(Duration::from_secs(MONITOR_CHECK_INTERVAL_SECS));
    tick_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tick_interval.tick().await;

        let game_running = is_game_running(target, &mut cached_reaper_pid).await;
        if !game_running {
            consecutive_failures += 1;
            debug!(
                "最佳进程 {} 检查失败次数: {}/{}",
                best_pid, consecutive_failures, MAX_CONSECUTIVE_FAILURES
            );

            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                warn!("{} 已失活，结束监控会话", target.describe());
                break;
            }
        } else {
            // 最佳 PID 仍在运行，重置失败计数
            consecutive_failures = 0;

            // 2. 清理候选列表中已失活的 PID（轻量级维护）

            // 3. 前台判定：检查候选列表中是否有任何进程在前台
            //    这是关键优化点 - 即使最佳 PID 不在前台，其他候选 PID 在前台也算数
            if let Some(foreground_pid) = check_any_foreground(&candidate_pids) {
                accumulated_seconds += 1;

                // 如果前台进程不是当前的最佳 PID，考虑切换
                if foreground_pid != best_pid {
                    debug!(
                        "前台进程 {} 不是最佳 PID {}，考虑调整",
                        foreground_pid, best_pid
                    );
                    best_pid = foreground_pid;
                }

                // 发送时间更新
                if accumulated_seconds > 0
                    && accumulated_seconds.is_multiple_of(TIME_UPDATE_INTERVAL_SECS)
                {
                    let minutes = accumulated_seconds / 60;
                    // debug!(
                    //     "发送时间更新事件: {} 分钟 ({} 秒)",
                    //     minutes, accumulated_seconds
                    // );
                    app_handle
                        .emit(
                            "game-time-update",
                            json!({
                                "gameId": game_id,
                                "totalMinutes": minutes,
                                "totalSeconds": accumulated_seconds,
                                "startTime": start_time,
                                "currentTime": get_timestamp(),
                                "processId": best_pid
                            }),
                        )
                        .map_err(|e| format!("无法发送 game-time-update 事件: {}", e))?;
                }
            } else {
                candidate_pids = get_all_candidate_pids(target).await;
            }
        }
    }

    finalize_session(
        app_handle,
        game_id,
        best_pid,
        start_time,
        accumulated_seconds,
    )
}

/// 完成游戏监控会话并发送结束事件
///
/// # Arguments
/// * `app_handle` - Tauri 应用句柄
/// * `game_id` - 游戏 ID
/// * `process_id` - 最终的进程 PID
/// * `start_time` - 会话开始时间戳
/// * `accumulated_seconds` - 累计的活动时间（秒）
///
/// # 返回值
/// 成功返回 `Ok(())`，失败返回包含错误信息的 `Err(String)`
fn finalize_session<R: Runtime>(
    app_handle: &AppHandle<R>,
    game_id: u32,
    process_id: u32,
    start_time: u64,
    accumulated_seconds: u64,
) -> Result<(), String> {
    let end_time = get_timestamp();
    let total_minutes = accumulated_seconds / 60;
    let remainder_seconds = accumulated_seconds % 60;

    // 将秒数四舍五入到最接近的分钟数
    let final_minutes = if remainder_seconds >= 30 {
        total_minutes + 1
    } else {
        total_minutes
    };

    info!(
        "游戏会话结束: ID={}, 最终 PID={}, 总活动时间={}秒 (计为 {} 分钟)",
        game_id, process_id, accumulated_seconds, final_minutes
    );

    // 发送会话结束事件到前端
    app_handle
        .emit(
            "game-session-ended",
            json!({
                "gameId": game_id,
                "startTime": start_time,
                "endTime": end_time,
                "totalMinutes": final_minutes,
                "totalSeconds": accumulated_seconds,
                "processId": process_id
            }),
        )
        .map_err(|e| format!("无法发送 game-session-ended 事件: {}", e))
}

// ============================================================================
// 工具函数
// ============================================================================

/// 获取当前的 Unix 时间戳（秒）
///
/// # Returns
/// 返回当前时间的 Unix 时间戳（秒）
///
/// # Panics
/// 如果系统时间早于 UNIX_EPOCH（1970-01-01 00:00:00 UTC），会 panic
fn get_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时间错误: 时间回溯")
        .as_secs()
}

/// 等待 Steam 为目标 AppId 创建游戏进程，返回其 reaper PID。
pub async fn wait_for_steam_game(app_id: u32) -> Result<u32, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(STEAM_START_TIMEOUT_SECS);

    loop {
        if let Some(pid) = find_steam_reaper_pids(app_id).into_iter().next() {
            info!(
                "检测到 Steam 游戏进程: AppId={}, reaper_pid={}",
                app_id, pid
            );
            return Ok(pid);
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "已请求 Steam 启动游戏，但 {} 秒内未检测到游戏进程 (AppId={})",
                STEAM_START_TIMEOUT_SECS, app_id
            ));
        }

        tokio::time::sleep(Duration::from_secs(STEAM_START_POLL_INTERVAL_SECS)).await;
    }
}

/// 停止 Steam 创建的游戏进程树。
pub fn stop_steam_game(app_id: u32) -> Result<u32, String> {
    let pids = find_steam_game_pids(app_id);
    if pids.is_empty() {
        return Err(format!("未找到 Steam 游戏进程 (AppId={app_id})"));
    }

    let mut signaled = 0u32;
    let mut last_error = None;
    for pid in pids {
        match kill(Pid::from_raw(pid as i32), Signal::SIGTERM) {
            Ok(()) => signaled += 1,
            Err(Errno::ESRCH) => {}
            Err(error) => last_error = Some(error),
        }
    }

    if signaled == 0
        && let Some(error) = last_error
    {
        return Err(format!("终止 Steam 游戏进程失败: {error}"));
    }

    Ok(signaled)
}

fn find_steam_game_pids(app_id: u32) -> Vec<u32> {
    home_dir()
        .map(|home| find_steam_game_pids_in(app_id, &home))
        .unwrap_or_default()
}

fn find_steam_game_pids_in(app_id: u32, home: &Path) -> Vec<u32> {
    let roots = find_steam_reaper_pids_in(app_id, home);
    if roots.is_empty() {
        return roots;
    }
    collect_process_tree(&roots)
}

fn find_steam_reaper_pids(app_id: u32) -> Vec<u32> {
    home_dir()
        .map(|home| find_steam_reaper_pids_in(app_id, &home))
        .unwrap_or_default()
}

fn find_steam_reaper_pids_in(app_id: u32, home: &Path) -> Vec<u32> {
    let Some(steam_pid) = find_steam_client_pid(home) else {
        debug!("未找到运行中的 Steam 客户端，跳过 AppId={app_id} 的进程检测");
        return Vec::new();
    };

    let mut pids = Vec::new();
    let mut visited = HashSet::new();
    let mut pending = vec![steam_pid];
    while let Some(pid) = pending.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if is_steam_reaper_pid(pid, app_id) {
            pids.push(pid);
        }
        pending.extend(read_children(pid));
    }
    pids.sort_unstable();
    pids
}

fn is_steam_reaper_pid(pid: u32, app_id: u32) -> bool {
    let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return false;
    };
    is_steam_reaper_cmdline(&cmdline, format!("AppId={app_id}").as_bytes())
}

fn is_steam_reaper_cmdline(cmdline: &[u8], expected_app_id: &[u8]) -> bool {
    let mut args = cmdline
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty());
    let Some(executable) = args.next() else {
        return false;
    };
    if executable.rsplit(|byte| *byte == b'/').next() != Some(b"reaper".as_slice()) {
        return false;
    }
    args.next() == Some(b"SteamLaunch".as_slice()) && args.next() == Some(expected_app_id)
}

fn collect_process_tree(roots: &[u32]) -> Vec<u32> {
    let mut pids = Vec::new();
    let mut visited = HashSet::new();
    let mut pending = roots.to_vec();
    while let Some(pid) = pending.pop() {
        if !visited.insert(pid) {
            continue;
        }
        pids.push(pid);
        pending.extend(read_children(pid));
    }
    pids
}

fn read_children(pid: u32) -> Vec<u32> {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return Vec::new();
    };
    tasks
        .flatten()
        .filter_map(|task| std::fs::read_to_string(task.path().join("children")).ok())
        .flat_map(|children| {
            children
                .split_whitespace()
                .filter_map(|value| value.parse::<u32>().ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn find_steam_client_pid(home: &Path) -> Option<u32> {
    for relative in STEAM_PID_FILE_CANDIDATES {
        let pid_file = home.join(relative);
        let Ok(raw) = std::fs::read_to_string(&pid_file) else {
            continue;
        };
        let Ok(pid) = raw.trim().parse::<u32>() else {
            continue;
        };
        if holds_steam_pipe(pid) {
            return Some(pid);
        }
        debug!(
            "{} 中的 PID {} 未持有 steam.pipe，判定为过期文件",
            pid_file.display(),
            pid
        );
    }
    None
}

fn holds_steam_pipe(pid: u32) -> bool {
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    entries.flatten().any(|entry| {
        std::fs::read_link(entry.path()).is_ok_and(|target| target.ends_with(".steam/steam.pipe"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmdline(args: &[&str]) -> Vec<u8> {
        let mut buffer = Vec::new();
        for arg in args {
            buffer.extend_from_slice(arg.as_bytes());
            buffer.push(0);
        }
        buffer
    }

    #[test]
    fn matches_proton_launch_command() {
        let line = cmdline(&[
            "/home/user/.local/share/Steam/ubuntu12_32/reaper",
            "SteamLaunch",
            "AppId=4513880",
            "--",
            "proton",
        ]);
        assert!(is_steam_reaper_cmdline(&line, b"AppId=4513880"));
    }

    #[test]
    fn requires_exact_app_id_argument() {
        let line = cmdline(&[
            "/home/user/.local/share/Steam/ubuntu12_32/reaper",
            "SteamLaunch",
            "AppId=413150",
        ]);
        assert!(!is_steam_reaper_cmdline(&line, b"AppId=41315"));
        assert!(!is_steam_reaper_cmdline(&line, b"AppId=4131500"));
    }

    #[test]
    fn rejects_processes_that_are_not_steam_reaper() {
        let wrapper = cmdline(&[
            "/home/user/.local/share/Steam/ubuntu12_32/steam-launch-wrapper",
            "--",
            "/home/user/.local/share/Steam/ubuntu12_32/reaper",
            "SteamLaunch",
            "AppId=413150",
        ]);
        assert!(!is_steam_reaper_cmdline(&wrapper, b"AppId=413150"));

        let similar_name = cmdline(&[
            "/home/user/.local/share/Steam/ubuntu12_32/reaper-wrapper",
            "SteamLaunch",
            "AppId=413150",
        ]);
        assert!(!is_steam_reaper_cmdline(&similar_name, b"AppId=413150"));

        let other_subcommand = cmdline(&[
            "/home/user/.local/share/Steam/ubuntu12_32/reaper",
            "AppId=413150",
        ]);
        assert!(!is_steam_reaper_cmdline(&other_subcommand, b"AppId=413150"));
    }

    #[test]
    fn cached_reaper_pid_is_rejected_for_non_reaper_processes() {
        assert!(!is_steam_reaper_pid(std::process::id(), 413150));
        assert!(!is_steam_reaper_pid(u32::MAX, 413150));
    }
}
