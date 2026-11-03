//! 将拖拽的本地路径和 Steam 快捷方式统一转换为批量导入候选。
//! 该模块只读取文件系统和数据库索引，不会创建或更新游戏记录。

use crate::database::repository::games_repository::GamesRepository;
use crate::utils::steam::{SteamLaunchTarget, resolve_steam_shortcut_files_blocking};
use sea_orm::DatabaseConnection;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{State, command};

const LOCAL_EXECUTABLE_EXTENSIONS: &[&str] = &["exe", "bat", "cmd"];

#[derive(Debug, Serialize)]
pub struct BulkImportPathCandidate {
    pub name: String,
    pub path: String,
    pub executables: Vec<String>,
    pub selected_exe: Option<String>,
    pub launch_type: Option<String>,
    pub steam_launch_id: Option<String>,
    pub steam_monitor_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BulkImportPathIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct BulkImportPathResult {
    pub candidates: Vec<BulkImportPathCandidate>,
    pub issues: Vec<BulkImportPathIssue>,
}

fn normalized_path_key(path: &Path) -> String {
    let normalized = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key = normalized.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    return key.to_lowercase();
    #[cfg(not(target_os = "windows"))]
    key
}

fn path_is_same_or_descendant(path: &Path, root: &Path) -> bool {
    let path = normalized_path_key(path);
    let root = normalized_path_key(root);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn trimmed_display_name(path: &Path) -> String {
    let value = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let mut result = String::new();
    let mut square_depth = 0_u32;
    let mut round_depth = 0_u32;
    let mut corner_depth = 0_u32;
    let mut fullwidth_round_depth = 0_u32;
    for ch in value.chars() {
        match ch {
            '[' => square_depth += 1,
            ']' => square_depth = square_depth.saturating_sub(1),
            '(' => round_depth += 1,
            ')' => round_depth = round_depth.saturating_sub(1),
            '【' => corner_depth += 1,
            '】' => corner_depth = corner_depth.saturating_sub(1),
            '（' => fullwidth_round_depth += 1,
            '）' => fullwidth_round_depth = fullwidth_round_depth.saturating_sub(1),
            _ if square_depth == 0
                && round_depth == 0
                && corner_depth == 0
                && fullwidth_round_depth == 0 =>
            {
                result.push(ch)
            }
            _ => {}
        }
    }
    let result = result.split_whitespace().collect::<Vec<_>>().join(" ");
    if result.is_empty() { value } else { result }
}

fn is_supported_executable(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        LOCAL_EXECUTABLE_EXTENSIONS
            .iter()
            .any(|expected| extension.eq_ignore_ascii_case(expected))
    })
}

fn local_candidate(path: &Path) -> Result<BulkImportPathCandidate, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取路径：{error}"))?;
    if metadata.is_dir() {
        let mut executables = fs::read_dir(path)
            .map_err(|error| format!("无法读取文件夹：{error}"))?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                entry.file_type().ok().filter(|kind| kind.is_file())?;
                let file_name = entry.file_name();
                let file_path = Path::new(&file_name);
                is_supported_executable(file_path).then(|| file_name.to_string_lossy().into_owned())
            })
            .collect::<Vec<_>>();
        executables.sort();
        return Ok(BulkImportPathCandidate {
            name: trimmed_display_name(path),
            path: path.to_string_lossy().into_owned(),
            selected_exe: executables.first().cloned(),
            executables,
            launch_type: None,
            steam_launch_id: None,
            steam_monitor_path: None,
        });
    }
    if metadata.is_file() && is_supported_executable(path) {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| "启动文件缺少父目录".to_string())?;
        let executable = path
            .file_name()
            .ok_or_else(|| "启动文件缺少文件名".to_string())?
            .to_string_lossy()
            .into_owned();
        return Ok(BulkImportPathCandidate {
            name: trimmed_display_name(parent),
            path: parent.to_string_lossy().into_owned(),
            executables: vec![executable.clone()],
            selected_exe: Some(executable),
            launch_type: None,
            steam_launch_id: None,
            steam_monitor_path: None,
        });
    }
    Err("仅支持文件夹、exe/bat/cmd 启动文件或 Steam .url/.desktop 快捷方式".to_string())
}

fn steam_candidate(target: SteamLaunchTarget) -> Result<BulkImportPathCandidate, String> {
    let monitor_path = target
        .localpath
        .ok_or_else(|| "Steam 启动项缺少可监控的游戏目录".to_string())?;
    let executable = target.executable;
    Ok(BulkImportPathCandidate {
        name: target.name,
        path: monitor_path.clone(),
        executables: executable.clone().into_iter().collect(),
        selected_exe: executable,
        launch_type: Some("steam".to_string()),
        steam_launch_id: Some(target.steam_launch_id),
        steam_monitor_path: Some(monitor_path),
    })
}

fn resolve_paths_blocking(
    paths: Vec<String>,
    existing_localpaths: HashSet<String>,
    existing_steam_ids: HashSet<String>,
) -> BulkImportPathResult {
    let existing_dirs = existing_localpaths
        .into_iter()
        .filter_map(|path| PathBuf::from(path).parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    let mut issues = Vec::new();
    let path_bufs = paths
        .into_iter()
        .filter_map(|raw| {
            let path = PathBuf::from(raw);
            if path.is_absolute() {
                Some(path)
            } else {
                issues.push(BulkImportPathIssue {
                    path: path.to_string_lossy().into_owned(),
                    message: "拖拽路径必须是绝对路径".to_string(),
                });
                None
            }
        })
        .collect::<Vec<_>>();
    let shortcut_paths = path_bufs
        .iter()
        .filter(|path| {
            path.extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("url") || extension.eq_ignore_ascii_case("desktop")
            })
        })
        .map(PathBuf::as_path)
        .collect::<Vec<_>>();
    let mut shortcut_results = resolve_steam_shortcut_files_blocking(&shortcut_paths).into_iter();
    let mut seen_paths = HashSet::new();
    let mut seen_steam_ids = HashSet::new();
    let mut candidates = Vec::new();

    for path in path_bufs {
        let is_shortcut = path.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("url") || extension.eq_ignore_ascii_case("desktop")
        });
        let candidate = if is_shortcut {
            shortcut_results
                .next()
                .expect("快捷方式解析结果数量必须一致")
                .and_then(steam_candidate)
        } else {
            local_candidate(&path)
        };
        let candidate = match candidate {
            Ok(candidate) => candidate,
            Err(message) => {
                issues.push(BulkImportPathIssue {
                    path: path.to_string_lossy().into_owned(),
                    message,
                });
                continue;
            }
        };
        let candidate_path = Path::new(&candidate.path);
        let already_imported = existing_dirs.iter().any(|existing| {
            path_is_same_or_descendant(candidate_path, existing)
                || path_is_same_or_descendant(existing, candidate_path)
        });
        if candidate
            .steam_launch_id
            .as_ref()
            .is_some_and(|id| existing_steam_ids.contains(id))
            || already_imported
        {
            issues.push(BulkImportPathIssue {
                path: path.to_string_lossy().into_owned(),
                message: "该游戏已存在于游戏库中".to_string(),
            });
            continue;
        }
        if let Some(steam_id) = candidate.steam_launch_id.as_ref()
            && !seen_steam_ids.insert(steam_id.clone())
        {
            issues.push(BulkImportPathIssue {
                path: path.to_string_lossy().into_owned(),
                message: "该 Steam 游戏在本次拖拽中重复".to_string(),
            });
            continue;
        }
        if !seen_paths.insert(normalized_path_key(candidate_path)) {
            issues.push(BulkImportPathIssue {
                path: path.to_string_lossy().into_owned(),
                message: "该游戏目录在本次拖拽中重复".to_string(),
            });
            continue;
        }
        candidates.push(candidate);
    }
    BulkImportPathResult { candidates, issues }
}

#[command]
pub async fn resolve_bulk_import_paths(
    db: State<'_, DatabaseConnection>,
    paths: Vec<String>,
) -> Result<BulkImportPathResult, String> {
    let localpaths = GamesRepository::get_all_localpaths(&db)
        .await
        .map_err(|error| format!("查询已有路径失败: {error}"))?;
    let steam_ids = GamesRepository::get_all_steam_launch_ids(&db)
        .await
        .map_err(|error| format!("查询已有 Steam 启动 ID 失败: {error}"))?;
    tokio::task::spawn_blocking(move || resolve_paths_blocking(paths, localpaths, steam_ids))
        .await
        .map_err(|error| format!("批量解析拖拽路径任务异常: {error}"))
}
