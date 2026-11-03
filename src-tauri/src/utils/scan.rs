use crate::database::repository::games_repository::{GamesRepository, ScanKnownGamePath};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{State, command};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    /// 文件夹名=游戏名
    pub name: String,
    /// 完整路径
    pub path: String,
    /// exe文件列表
    pub executables: Vec<String>,
}

/// 一次目录扫描的只读结果。
///
/// `unscanned_directories` 只用于提示用户检查扫描根目录的一级子目录：
/// 它们既没有已导入的本地游戏路径，也没有产生本次可导入候选。
/// 该列表绝不参与导入或写入数据库。
#[derive(Debug, Serialize)]
pub struct ScanDirectoryResult {
    pub candidates: Vec<ScanResult>,
    pub unscanned_directories: Vec<UnscannedDirectory>,
}

#[derive(Debug, Serialize)]
pub struct UnscannedDirectory {
    pub name: String,
    pub path: String,
    pub reason: String,
}

const VALID_EXE_EXTENSIONS: &[&str] = &["exe", "bat", "cmd"];
const MIN_SCAN_DEPTH: usize = 2;
const MAX_SCAN_DEPTH: usize = 5;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanMode {
    Executable,
    FirstLevelDirectory,
}

/// 扫描时跳过的目录名（不区分大小写）
const EXCLUDED_DIRS: &[&str] = &[
    // Windows 系统目录
    "$recycle.bin",
    "system volume information",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    // 开发 / 版本控制
    ".git",
    ".vs",
    "node_modules",
    "__pycache__",
    // 常见运行时 / 补丁目录（通常不含游戏主程序）
    "redist",
    "redistributables",
    "_commonredist",
    "directx",
    "vcredist",
];

/// exe 文件名（stem）中包含以下关键字则视为非游戏程序，予以排除
const EXCLUDED_EXE_PATTERNS: &[&str] = &[
    "unins", // 卸载程序
    "uninst",
    "uninstall",
    "setup", // 安装 / 配置向导
    "install",
    "dxsetup",  // DirectX
    "vcredist", // VC++ 运行时
    "vc_redist",
    "dotnetfx",     // .NET
    "oalinst",      // OpenAL
    "crashhandler", // 崩溃处理器
    "crash_handler",
    "crashreport",
    "crash_report",
    "bugreport",
    "bug_report",
    "unitycrashandler",
];

fn trim_dirname_to_search_name(dir_name: &str) -> String {
    let mut result = String::with_capacity(dir_name.len());
    let mut square_depth = 0_u32;
    let mut round_depth = 0_u32;
    let mut corner_depth = 0_u32;
    let mut fullwidth_round_depth = 0_u32;

    for ch in dir_name.chars() {
        match ch {
            '[' => square_depth += 1,
            ']' => square_depth = square_depth.saturating_sub(1),
            '(' => round_depth += 1,
            ')' => round_depth = round_depth.saturating_sub(1),
            '【' => corner_depth += 1,
            '】' => corner_depth = corner_depth.saturating_sub(1),
            '（' => fullwidth_round_depth += 1,
            '）' => fullwidth_round_depth = fullwidth_round_depth.saturating_sub(1),
            _ => {
                if square_depth == 0
                    && round_depth == 0
                    && corner_depth == 0
                    && fullwidth_round_depth == 0
                {
                    result.push(ch);
                }
            }
        }
    }

    let trimmed = result.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        dir_name.trim().to_string()
    } else {
        trimmed
    }
}

fn is_excluded_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    EXCLUDED_DIRS.iter().any(|&d| lower == d)
}

fn is_excluded_exe(path: &Path) -> bool {
    path.file_stem().is_some_and(|stem| {
        let lower = stem.to_string_lossy().to_lowercase();
        EXCLUDED_EXE_PATTERNS.iter().any(|&p| lower.contains(p))
    })
}

#[command]
pub async fn scan_directory_for_games(
    db: State<'_, DatabaseConnection>,
    path: String,
    max_depth: usize,
    scan_mode: ScanMode,
    scan_context_roots: Vec<String>,
) -> Result<ScanDirectoryResult, String> {
    // 先做路径预检查（一次 syscall，可在 async 上下文进行）
    if !Path::new(&path).is_dir() {
        return Err(format!("目录不存在或不是文件夹: {}", path));
    }

    // 异步查询 DB；每个游戏最多以一条普通本地路径参与排除，Steam 另加监控目录。
    let known_paths = GamesRepository::get_known_paths_for_directory_scan(&db)
        .await
        .map_err(|e| format!("查询已有路径失败: {}", e))?;
    let root = PathBuf::from(&path);
    let existing_dirs = build_existing_game_dirs(&root, &scan_context_roots, known_paths);

    // WalkDir 大量文件系统 I/O 属于阻塞操作，
    // 放入 Tokio 革层阻塞线程池，避免占用异步运行时线程。
    let max_depth = max_depth.clamp(MIN_SCAN_DEPTH, MAX_SCAN_DEPTH);
    tokio::task::spawn_blocking(move || {
        scan_games_with_audit_blocking(path, existing_dirs, max_depth, scan_mode)
    })
    .await
    .map_err(|e| format!("扫描任务异常: {}", e))?
}

fn scan_games_with_audit_blocking(
    path: String,
    existing_dirs: HashSet<PathBuf>,
    max_depth: usize,
    scan_mode: ScanMode,
) -> Result<ScanDirectoryResult, String> {
    let root = PathBuf::from(&path);
    let candidates = match scan_mode {
        ScanMode::Executable => scan_games_blocking(path, existing_dirs.clone(), max_depth)?,
        ScanMode::FirstLevelDirectory => scan_first_level_directories(&root, &existing_dirs),
    };
    let unscanned_directories = collect_unscanned_directories(&root, &existing_dirs, &candidates);

    Ok(ScanDirectoryResult {
        candidates,
        unscanned_directories,
    })
}

/// 将数据库中的已保存启动路径收敛为需要排除的游戏目录。
///
/// 默认扫描根目录可以嵌套（例如 `F:\\Games` 与 `F:\\Games\\Anime Games`）：
/// 对落入嵌套根的路径，优先使用最具体的根目录取得其一级游戏目录。没有明确根上下文时
/// 只退回到启动文件的直接父目录，绝不把扫描根或其上级集合目录当作一个游戏整体排除。
fn build_existing_game_dirs(
    scan_root: &Path,
    scan_context_roots: &[String],
    known_paths: Vec<ScanKnownGamePath>,
) -> HashSet<PathBuf> {
    let context_roots = scan_context_roots
        .iter()
        .map(|path| PathBuf::from(path.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    let mut existing_dirs = HashSet::new();

    for known in known_paths {
        let normal_localpath = known.localpath.or(known.fallback_localpath);
        if let Some(localpath) = normal_localpath {
            if let Some(directory) =
                derive_existing_game_dir(Path::new(&localpath), false, scan_root, &context_roots)
            {
                existing_dirs.insert(directory);
            }
        }
        if known.is_steam {
            if let Some(monitor_path) = known.steam_monitor_path {
                if let Some(directory) = derive_existing_game_dir(
                    Path::new(&monitor_path),
                    true,
                    scan_root,
                    &context_roots,
                ) {
                    existing_dirs.insert(directory);
                }
            }
        }
    }

    existing_dirs
}

/// 返回 `path` 位于 `root` 下方的相对路径。Windows 路径在此仅允许忽略
/// 盘符：其余每一个目录组件必须相同，且包含 `..` 的非常规路径宁可不匹配。
///
/// 这样可识别例如 `E:\Games\Title\game.exe` 移到
/// `F:\Games\Title\game.exe` 的情况，却不会把两个不同的游戏集合目录混为一谈。
fn relative_after_root_ignoring_volume(path: &Path, root: &Path) -> Option<PathBuf> {
    let components = |value: &Path| -> Option<Vec<std::ffi::OsString>> {
        let mut parts = Vec::new();
        for component in value.components() {
            match component {
                Component::Normal(part) => parts.push(part.to_os_string()),
                Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
                Component::ParentDir => return None,
            }
        }
        Some(parts)
    };
    let path_components = components(path)?;
    let root_components = components(root)?;
    if root_components.is_empty() || path_components.len() < root_components.len() {
        return None;
    }
    if !path_components
        .iter()
        .zip(&root_components)
        .all(|(left, right)| {
            left.to_string_lossy()
                .eq_ignore_ascii_case(&right.to_string_lossy())
        })
    {
        return None;
    }

    let mut relative = PathBuf::new();
    for component in path_components.into_iter().skip(root_components.len()) {
        relative.push(component);
    }
    Some(relative)
}

fn paths_equal_ignoring_volume(left: &Path, right: &Path) -> bool {
    matches!(
        relative_after_root_ignoring_volume(left, right),
        Some(relative) if relative.as_os_str().is_empty()
    ) && matches!(
        relative_after_root_ignoring_volume(right, left),
        Some(relative) if relative.as_os_str().is_empty()
    )
}

fn derive_existing_game_dir(
    saved_path: &Path,
    is_directory_path: bool,
    scan_root: &Path,
    context_roots: &[PathBuf],
) -> Option<PathBuf> {
    // 仅使用比当前根更具体的已配置根，或当前根下不受更深根覆盖的直接游戏目录。
    // 这避免在手动扫描一个宽泛目录时，把例如 `Anime Games` 这样的分类目录误作游戏。
    let nested_context_root = context_roots
        .iter()
        .filter(|root| {
            relative_after_root_ignoring_volume(root, scan_root)
                .is_some_and(|relative| !relative.as_os_str().is_empty())
                && relative_after_root_ignoring_volume(saved_path, root)
                    .is_some_and(|relative| !relative.as_os_str().is_empty())
        })
        .max_by_key(|root| root.components().count());

    if let Some(root) = nested_context_root {
        return relative_after_root_ignoring_volume(saved_path, root).and_then(|relative| {
            relative
                .components()
                .next()
                .map(|first_child| root.join(first_child.as_os_str()))
        });
    }

    // 当前扫描根本身只有在它来自“默认扫描根目录”配置时，才可视为明确的游戏容器。
    // 手动选取的任意文件夹没有该上下文，必须走下面更保守的直接父目录规则。
    if context_roots
        .iter()
        .any(|root| paths_equal_ignoring_volume(root, scan_root))
    {
        return relative_after_root_ignoring_volume(saved_path, scan_root).and_then(|relative| {
            relative
                .components()
                .next()
                .map(|first_child| scan_root.join(first_child.as_os_str()))
        });
    }

    if is_directory_path {
        return relative_after_root_ignoring_volume(saved_path, scan_root)
            .filter(|relative| !relative.as_os_str().is_empty())
            .map(|relative| scan_root.join(relative));
    }

    saved_path
        .parent()
        .and_then(|parent| relative_after_root_ignoring_volume(parent, scan_root))
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(|relative| scan_root.join(relative))
}

/// 仅枚举扫描根目录的一级子文件夹，便于用户发现扫描规则未覆盖的游戏目录。
/// 已导入目录及其父目录内已有已导入路径的目录不会显示，避免重复打扰。
fn collect_unscanned_directories(
    root: &Path,
    existing_dirs: &HashSet<PathBuf>,
    candidates: &[ScanResult],
) -> Vec<UnscannedDirectory> {
    let mut directories = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return directories;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }

        let already_imported = existing_dirs
            .iter()
            .any(|existing_dir| existing_dir == &path || existing_dir.starts_with(&path));
        let has_candidate = candidates
            .iter()
            .any(|candidate| Path::new(&candidate.path).starts_with(&path));
        if already_imported || has_candidate {
            continue;
        }

        directories.push(UnscannedDirectory {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            reason: "未找到可用的直属启动程序，或启动程序已被安全排除".to_string(),
        });
    }

    directories.sort_by(|left, right| left.name.cmp(&right.name));
    directories
}

/// 兼容当前改版的一级目录扫描：仅将拥有直属可用启动程序的文件夹作为候选。
///
/// 上游可以把没有可执行文件的目录直接作为游戏导入，但当前 `localpath`
/// 必须是完整启动文件，故此处保持路径契约；其余目录由待核对清单呈现。
fn scan_first_level_directories(root: &Path, existing_dirs: &HashSet<PathBuf>) -> Vec<ScanResult> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut results = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || is_excluded_dir(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if existing_dirs
            .iter()
            .any(|existing_dir| existing_dir == &path || existing_dir.starts_with(&path))
        {
            continue;
        }

        let Ok(children) = fs::read_dir(&path) else {
            continue;
        };
        let mut executables = children
            .flatten()
            .filter_map(|child| {
                let executable_path = child.path();
                let file_type = child.file_type().ok()?;
                if !file_type.is_file() || is_excluded_exe(&executable_path) {
                    return None;
                }
                let extension = executable_path.extension()?;
                VALID_EXE_EXTENSIONS
                    .iter()
                    .any(|expected| extension.eq_ignore_ascii_case(expected))
                    .then(|| child.file_name().to_string_lossy().into_owned())
            })
            .collect::<Vec<_>>();
        if executables.is_empty() {
            continue;
        }

        executables.sort();
        let raw_name = entry.file_name().to_string_lossy().into_owned();
        results.push(ScanResult {
            name: trim_dirname_to_search_name(&raw_name),
            path: path.to_string_lossy().into_owned(),
            executables,
        });
    }

    results.sort_by(|left, right| left.name.cmp(&right.name));
    results
}

/// 包含所有阻塞 I/O 和 CPU 密集计算的同步扫描逻辑
///
/// 由 [`scan_directory_for_games`] 通过 `tokio::task::spawn_blocking` 调用，
/// 运行在顶层阻塞线程池中而非异步运行时。
fn scan_games_blocking(
    path: String,
    existing_dirs: HashSet<PathBuf>,
    max_depth: usize,
) -> Result<Vec<ScanResult>, String> {
    let dir_path = PathBuf::from(&path);

    // Phase 1: DFS 遍历，收集所有有效 exe，按其所在目录分组
    // 使用手动迭代器控制代替 filter_entry，以便调用 skip_current_dir() 实现真正的短路：
    //   - 遇到排除目录 / 已导入目录 → skip_current_dir，剪掉整棵子树
    //   - 当某目录已确认含有直属 exe 时，之后遇到其子目录立即 skip_current_dir，
    //   - 忽略直接位于扫描根目录下的文件（它们不属于任何子游戏文件夹）
    let mut exe_by_dir: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    // 已发现直属 exe 的目录集合，用于对其子目录执行 skip_current_dir
    let mut dirs_with_exe: HashSet<PathBuf> = HashSet::new();

    let mut walker = WalkDir::new(&dir_path)
        .min_depth(1)
        .max_depth(max_depth)
        .follow_links(false)
        .sort_by(|a, b| {
            let a_is_dir = a.file_type().is_dir();
            let b_is_dir = b.file_type().is_dir();
            // bool 的比较规则中，false (文件) < true (文件夹)
            a_is_dir.cmp(&b_is_dir)
        })
        .into_iter();

    while let Some(entry) = walker.next() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let entry_path = entry.path();

        if entry.file_type().is_dir() {
            // walkdir 在 yield 目录时已将其 ReadDir 压栈，skip_current_dir() 将其弹出，
            // 从而跳过该目录的所有内容，但不影响同级其他条目。
            let should_skip = is_excluded_dir(&entry.file_name().to_string_lossy())
                || existing_dirs.contains(entry_path)
                // 父目录已有直属 exe → 该子目录无需遍历（祖先优先短路）
                || entry_path
                    .parent()
                    .is_some_and(|p| dirs_with_exe.contains(p));
            if should_skip {
                walker.skip_current_dir();
            }
            continue; // 目录条目本身无需记录
        }

        if entry.file_type().is_file() {
            let Some(parent) = entry_path.parent() else {
                continue;
            };
            if parent == dir_path.as_path() {
                continue; // 忽略根目录直属文件
            }
            // 收集有效可执行文件，并标记该目录已有 exe
            if let Some(ext) = entry_path.extension()
                && VALID_EXE_EXTENSIONS
                    .iter()
                    .any(|&e| ext.eq_ignore_ascii_case(e))
                && !is_excluded_exe(entry_path)
            {
                dirs_with_exe.insert(parent.to_path_buf());
                exe_by_dir
                    .entry(parent.to_path_buf())
                    .or_default()
                    .push(entry_path.to_path_buf());
            }
        }
    }

    // Phase 2: 短路 —— 祖先目录优先
    //   按路径深度升序排列候选目录，若某目录的祖先已被选中则跳过，
    //   这等效于 DFS 找到可执行文件后不再向下扫描的短路行为。
    let mut dirs: Vec<PathBuf> = exe_by_dir.keys().cloned().collect();
    dirs.sort_by_key(|p| p.components().count());

    let mut selected: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !selected.iter().any(|s| dir.starts_with(s) && dir != *s) {
            selected.push(dir);
        }
    }

    // Phase 3: 构建结果。只要目录直属存在有效启动程序就保留候选。
    // 旧版按“普通文件数大于 3”二次过滤，会漏掉精简的独立游戏；
    // 安装器、卸载器和运行库仍由 is_excluded_exe 明确过滤。
    let mut results: Vec<ScanResult> = selected
        .into_iter()
        .filter_map(|game_dir| {
            let exes = exe_by_dir.get(&game_dir)?;
            let raw_name = game_dir.file_name()?.to_string_lossy().to_string();
            let name = trim_dirname_to_search_name(&raw_name);
            let lower_name = name.to_lowercase();

            let mut executables: Vec<String> = exes
                .iter()
                .filter_map(|exe_path| {
                    exe_path
                        .strip_prefix(&game_dir)
                        .ok()
                        .map(|rel| rel.to_string_lossy().to_string())
                })
                .collect();

            // 排序：含 "chs" 的靠前（忽略大小写）；其次文件名含游戏目录名的靠前；最后路径越短越靠前
            executables.sort_by(|a, b| {
                let a_lower = a.to_lowercase();
                let b_lower = b.to_lowercase();
                let a_chs = a_lower.contains("chs");
                let b_chs = b_lower.contains("chs");
                if a_chs != b_chs {
                    return if a_chs {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Greater
                    };
                }
                let a_match = a_lower.contains(&lower_name);
                let b_match = b_lower.contains(&lower_name);
                match (a_match, b_match) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.len().cmp(&b.len()),
                }
            });

            Some(ScanResult {
                name,
                path: game_dir.to_string_lossy().to_string(),
                executables,
            })
        })
        .collect();

    results.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::{
        collect_unscanned_directories, derive_existing_game_dir,
        relative_after_root_ignoring_volume, scan_first_level_directories, scan_games_blocking,
        trim_dirname_to_search_name,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn trim_dirname_removes_common_tags() {
        assert_eq!(
            trim_dirname_to_search_name("[社团名] 游戏名 (完整版)"),
            "游戏名"
        );
        assert_eq!(
            trim_dirname_to_search_name("【品牌】 游戏名 （初回版）"),
            "游戏名"
        );
    }

    #[test]
    fn trim_dirname_falls_back_when_everything_is_removed() {
        assert_eq!(trim_dirname_to_search_name("[社团名]"), "[社团名]");
    }

    #[test]
    fn scan_audit_lists_only_first_level_directories_without_import_or_candidate() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("reina-scan-audit-{}-{unique}", std::process::id()));
        let imported = root.join("Imported");
        let candidate = root.join("Candidate");
        let missing = root.join("Missing");
        fs::create_dir_all(&imported).expect("应能创建已导入目录");
        fs::create_dir_all(&candidate).expect("应能创建候选目录");
        fs::create_dir_all(&missing).expect("应能创建待核对目录");
        fs::write(candidate.join("Game.exe"), []).expect("应能创建启动程序");
        fs::write(candidate.join("data1.bin"), []).expect("应能创建游戏文件");
        fs::write(candidate.join("data2.bin"), []).expect("应能创建游戏文件");
        fs::write(candidate.join("data3.bin"), []).expect("应能创建游戏文件");

        let mut existing_dirs = HashSet::new();
        existing_dirs.insert(imported.clone());
        let candidates = scan_games_blocking(
            root.to_string_lossy().into_owned(),
            existing_dirs.clone(),
            5,
        )
        .expect("扫描应成功");
        let audit = collect_unscanned_directories(&root, &existing_dirs, &candidates);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, candidate.to_string_lossy());
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].name, "Missing");
        assert_eq!(PathBuf::from(&audit[0].path), missing);

        fs::remove_dir_all(root).expect("应能清理测试目录");
    }

    #[test]
    fn first_level_scan_requires_a_direct_executable_and_skips_imported_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "reina-first-level-compat-{}-{unique}",
            std::process::id()
        ));
        let candidate = root.join("Candidate");
        let imported = root.join("Imported");
        let no_executable = root.join("NoExecutable");
        fs::create_dir_all(&candidate).expect("应能创建候选目录");
        fs::create_dir_all(&imported).expect("应能创建已导入目录");
        fs::create_dir_all(no_executable.join("Nested")).expect("应能创建无启动程序目录");
        fs::write(candidate.join("Game.exe"), []).expect("应能创建启动程序");
        fs::write(imported.join("Imported.exe"), []).expect("应能创建启动程序");

        let mut existing_dirs = HashSet::new();
        existing_dirs.insert(imported);
        let results = scan_first_level_directories(&root, &existing_dirs);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Candidate");
        assert_eq!(PathBuf::from(&results[0].path), candidate);
        assert_eq!(results[0].executables, ["Game.exe"]);

        fs::remove_dir_all(root).expect("应能清理测试目录");
    }

    #[test]
    fn executable_scan_keeps_a_minimal_game_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "reina-minimal-game-scan-{}-{unique}",
            std::process::id()
        ));
        let game = root.join("MinimalGame");
        fs::create_dir_all(&game).expect("应能创建游戏目录");
        fs::write(game.join("Game.exe"), []).expect("应能创建启动程序");
        fs::write(game.join("config.ini"), []).expect("应能创建配置文件");

        let results = scan_games_blocking(root.to_string_lossy().into_owned(), HashSet::new(), 5)
            .expect("扫描应成功");

        assert_eq!(results.len(), 1);
        assert_eq!(PathBuf::from(&results[0].path), game);
        assert_eq!(results[0].executables, ["Game.exe"]);

        fs::remove_dir_all(root).expect("应能清理测试目录");
    }

    #[test]
    fn known_path_exclusion_uses_the_most_specific_configured_root() {
        let games_root = PathBuf::from(r"F:\Games");
        let anime_root = PathBuf::from(r"F:\Games\Anime Games");
        let context = vec![games_root.clone(), anime_root.clone()];
        let alice = PathBuf::from(r"F:\Games\Anime Games\alicenation\alicenation.exe");
        let atelier = PathBuf::from(r"F:\Games\Anime Games\Atelier.Resleriana\Launcher\game.exe");

        assert_eq!(
            derive_existing_game_dir(&alice, false, &games_root, &context),
            Some(PathBuf::from(r"F:\Games\Anime Games\alicenation")),
        );
        assert_eq!(
            derive_existing_game_dir(&atelier, false, &anime_root, &context),
            Some(PathBuf::from(r"F:\Games\Anime Games\Atelier.Resleriana")),
        );
    }

    #[test]
    fn known_path_exclusion_ignores_only_the_drive_letter() {
        let games_root = PathBuf::from(r"F:\Games");
        let anime_root = PathBuf::from(r"F:\Games\Anime Games");
        let context = vec![games_root.clone(), anime_root.clone()];
        let moved_game = PathBuf::from(r"E:\Games\Anime Games\alicenation\alicenation.exe");

        assert_eq!(
            derive_existing_game_dir(&moved_game, false, &games_root, &context),
            Some(PathBuf::from(r"F:\Games\Anime Games\alicenation")),
        );
        assert_eq!(
            relative_after_root_ignoring_volume(
                Path::new(r"E:\Games\Anime Games\alicenation\alicenation.exe"),
                Path::new(r"F:\Games\Anime Games"),
            ),
            Some(PathBuf::from(r"alicenation\alicenation.exe")),
        );
        assert_eq!(
            relative_after_root_ignoring_volume(
                Path::new(r"E:\Games\Other\alicenation\alicenation.exe"),
                Path::new(r"F:\Games\Anime Games"),
            ),
            None,
        );
    }

    #[test]
    fn manual_root_never_excludes_a_collection_directory() {
        let games_root = PathBuf::from(r"F:\Games");
        let executable = PathBuf::from(r"F:\Games\Anime Games\alicenation\alicenation.exe");

        assert_eq!(
            derive_existing_game_dir(&executable, false, &games_root, &[]),
            Some(PathBuf::from(r"F:\Games\Anime Games\alicenation")),
        );
    }
}
