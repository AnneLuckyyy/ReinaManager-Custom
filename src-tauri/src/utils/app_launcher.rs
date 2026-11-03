//! 用户“应用”页的受限快捷方式读取与启动。
//! 不解析快捷方式目标、不接受参数，也不写入用户选择的目录。

#[cfg(target_os = "windows")]
use crate::utils::command_ext::CommandGuiExt;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLauncherCandidate {
    pub path: String,
    pub name: String,
    pub kind: String,
}

#[command]
pub async fn scan_app_launcher_folder(
    folder_path: String,
) -> Result<Vec<AppLauncherCandidate>, String> {
    let folder = absolute_normal_directory(&folder_path, "应用目录")?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&folder).map_err(|error| format!("读取应用目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取应用目录项失败: {error}"))?;
        let path = entry.path();
        let metadata =
            fs::symlink_metadata(&path).map_err(|error| format!("读取应用项失败: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let Some(kind) = supported_kind(&path) else {
            continue;
        };
        let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.trim().is_empty() {
            continue;
        }
        candidates.push(AppLauncherCandidate {
            path: path.to_string_lossy().into_owned(),
            name: name.trim().to_string(),
            kind: kind.to_string(),
        });
    }
    candidates.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(candidates)
}

/// 只解析拖入路径中的可支持应用项，不改写任何文件。
#[command]
pub async fn resolve_app_launcher_paths(
    paths: Vec<String>,
) -> Result<Vec<AppLauncherCandidate>, String> {
    let mut candidates = Vec::new();
    for value in paths {
        let path = PathBuf::from(value.trim());
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        if metadata.is_dir() {
            let nested = scan_app_launcher_folder(path.to_string_lossy().into_owned()).await?;
            candidates.extend(nested);
            continue;
        }
        let Some(kind) = supported_kind(&path) else {
            continue;
        };
        let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.trim().is_empty() {
            candidates.push(AppLauncherCandidate {
                path: path.to_string_lossy().into_owned(),
                name: name.trim().to_string(),
                kind: kind.to_string(),
            });
        }
    }
    candidates.sort_by(|left, right| left.path.to_lowercase().cmp(&right.path.to_lowercase()));
    candidates.dedup_by(|left, right| left.path.eq_ignore_ascii_case(&right.path));
    Ok(candidates)
}

/// 将一个已验证的 `.exe` 制作为来源目录中的普通 `.lnk`，从不覆盖已有文件。
#[command]
pub async fn create_app_launcher_shortcut(
    executable_path: String,
    destination_folder: String,
) -> Result<AppLauncherCandidate, String> {
    let executable = absolute_supported_file(&executable_path)?;
    if supported_kind(&executable) != Some("executable") {
        return Err("只能为普通 .exe 创建应用快捷方式".to_string());
    }
    let destination = absolute_normal_directory(&destination_folder, "快捷方式来源目录")?;
    let name = executable
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("无法从应用文件名创建快捷方式")?;
    let shortcut_path = destination.join(format!("{name}.lnk"));
    if fs::symlink_metadata(&shortcut_path).is_ok() {
        return Err("同名快捷方式已存在，未覆盖任何文件".to_string());
    }

    #[cfg(target_os = "windows")]
    create_shortcut_file(&executable, &shortcut_path)?;
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (executable, shortcut_path);
        return Err("创建应用快捷方式当前仅支持 Windows".to_string());
    }

    Ok(AppLauncherCandidate {
        path: shortcut_path.to_string_lossy().into_owned(),
        name: name.to_string(),
        kind: "shortcut".to_string(),
    })
}

/// 将普通 `.lnk` / `.url` 放入指定来源目录，不覆盖同名文件。
///
/// 该命令只复制用户确认的单个快捷方式文件；不会追踪或修改其目标程序。
#[command]
pub async fn copy_app_launcher_item_to_source(
    source_path: String,
    destination_folder: String,
) -> Result<AppLauncherCandidate, String> {
    let source = absolute_supported_file(&source_path)?;
    let kind = supported_kind(&source).ok_or("不支持的应用项")?;
    if kind == "executable" {
        return Err(".exe 请使用受控的快捷方式创建流程".to_string());
    }
    let destination = absolute_normal_directory(&destination_folder, "快捷方式来源目录")?;
    let file_name = source.file_name().ok_or("应用项缺少文件名")?;
    let target = destination.join(file_name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err("同名应用项已存在，未覆盖任何文件".to_string());
    }
    fs::copy(&source, &target).map_err(|error| format!("复制应用项失败: {error}"))?;
    let name = target
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("应用项文件名无效")?;
    Ok(AppLauncherCandidate {
        path: target.to_string_lossy().into_owned(),
        name: name.to_string(),
        kind: kind.to_string(),
    })
}

#[command]
pub async fn launch_app_launcher_item(path: String) -> Result<(), String> {
    let path = absolute_supported_file(&path)?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .gui_safe()
            .spawn()
            .map_err(|error| format!("启动应用失败: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("应用页当前仅支持 Windows 快捷方式启动".to_string())
    }
}

#[command]
pub async fn open_app_launcher_item_location(path: String) -> Result<(), String> {
    let path = absolute_supported_file(&path)?;
    let fallback_parent = path.parent().ok_or("应用项没有父目录")?;
    #[cfg(target_os = "windows")]
    let parent = if supported_kind(&path) == Some("shortcut") {
        shortcut_target_executable(&path)
            .and_then(|target| target.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| fallback_parent.to_path_buf())
    } else {
        fallback_parent.to_path_buf()
    };
    #[cfg(not(target_os = "windows"))]
    let parent = fallback_parent.to_path_buf();
    crate::utils::fs::open_directory(parent.to_string_lossy().into_owned()).await
}

/// 只从 Windows Shell 读取图标的显示像素；`.lnk` 只读解析为普通 exe 时借用目标图标，结果不落盘。
#[command]
pub async fn get_app_launcher_icons(paths: Vec<String>) -> Result<HashMap<String, String>, String> {
    let valid_paths = paths
        .into_iter()
        .filter_map(|original| {
            absolute_supported_file(&original)
                .ok()
                .map(|path| (original, path))
        })
        .collect::<Vec<_>>();

    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            valid_paths
                .into_iter()
                .filter_map(|(original, path)| {
                    app_icon_data_url(&path).map(|icon| (original, icon))
                })
                .collect()
        })
        .await
        .map_err(|error| format!("读取应用图标失败: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = valid_paths;
        Ok(HashMap::new())
    }
}

fn absolute_normal_directory(value: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return Err(format!("{label}必须是绝对路径"));
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| format!("读取{label}失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label}必须是普通目录，不能是链接"));
    }
    Ok(path)
}

fn absolute_supported_file(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return Err("应用路径必须是绝对路径".to_string());
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| format!("应用项不存在或无法读取: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || supported_kind(&path).is_none() {
        return Err("应用项必须是普通的 .lnk、.url 或 .exe 文件".to_string());
    }
    Ok(path)
}

fn supported_kind(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?;
    if extension.eq_ignore_ascii_case("lnk") {
        Some("shortcut")
    } else if extension.eq_ignore_ascii_case("url") {
        Some("url")
    } else if extension.eq_ignore_ascii_case("exe") {
        Some("executable")
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn create_shortcut_file(executable: &Path, shortcut_path: &Path) -> Result<(), String> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize, IPersistFile,
            },
            UI::Shell::{IShellLinkW, ShellLink},
        },
        core::{Interface, PCWSTR},
    };

    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };
    let result = (|| unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| format!("创建快捷方式失败: {error}"))?;
        let target = executable
            .as_os_str()
            .encode_wide()
            .chain(iter::once(0))
            .collect::<Vec<_>>();
        shell_link
            .SetPath(PCWSTR(target.as_ptr()))
            .map_err(|error| format!("写入快捷方式目标失败: {error}"))?;
        let persist_file: IPersistFile = shell_link
            .cast()
            .map_err(|error| format!("保存快捷方式失败: {error}"))?;
        let output = shortcut_path
            .as_os_str()
            .encode_wide()
            .chain(iter::once(0))
            .collect::<Vec<_>>();
        persist_file
            .Save(PCWSTR(output.as_ptr()), true)
            .map_err(|error| format!("保存快捷方式失败: {error}"))
    })();
    if initialized {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(target_os = "windows")]
fn app_icon_data_url(path: &Path) -> Option<String> {
    if supported_kind(path) == Some("shortcut") {
        return shortcut_target_executable(path).and_then(|target| shell_icon_data_url(&target));
    }
    shell_icon_data_url(path)
}

/// 只读取 `.lnk` 的目标路径来去除 Shell 的快捷方式箭头；只接受普通 `.exe`，不读取参数、不执行。
#[cfg(target_os = "windows")]
fn shortcut_target_executable(path: &Path) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::iter;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::{
        Win32::{
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize, IPersistFile, STGM_READ,
            },
            UI::Shell::{IShellLinkW, ShellLink},
        },
        core::{Interface, PCWSTR},
    };

    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };
    let target = (|| unsafe {
        let shell_link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist_file: IPersistFile = shell_link.cast().ok()?;
        let wide_path = path
            .as_os_str()
            .encode_wide()
            .chain(iter::once(0))
            .collect::<Vec<_>>();
        persist_file
            .Load(PCWSTR(wide_path.as_ptr()), STGM_READ)
            .ok()?;
        let mut target_path = vec![0u16; 32_768];
        shell_link
            .GetPath(&mut target_path, std::ptr::null_mut(), 0)
            .ok()?;
        let end = target_path.iter().position(|value| *value == 0)?;
        let target = PathBuf::from(OsString::from_wide(&target_path[..end]));
        let metadata = fs::symlink_metadata(&target).ok()?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || target
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
        {
            return None;
        }
        Some(target)
    })();
    if initialized {
        unsafe { CoUninitialize() };
    }
    target
}

#[cfg(target_os = "windows")]
fn shell_icon_data_url(path: &Path) -> Option<String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{
            Graphics::Gdi::{
                BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
                DIB_RGB_COLORS, DeleteDC, DeleteObject, HGDIOBJ, SelectObject,
            },
            Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
            UI::{
                Shell::{SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGetFileInfoW},
                WindowsAndMessaging::{DI_NORMAL, DestroyIcon, DrawIconEx},
            },
        },
        core::PCWSTR,
    };

    const ICON_SIZE: i32 = 40;
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let mut file_info = SHFILEINFOW::default();
    let received = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut file_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if received == 0 || file_info.hIcon.0.is_null() {
        return None;
    }

    let bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: ICON_SIZE,
            biHeight: -ICON_SIZE,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: (ICON_SIZE * ICON_SIZE * 4) as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = std::ptr::null_mut();
    let bitmap =
        unsafe { CreateDIBSection(None, &bitmap_info, DIB_RGB_COLORS, &mut pixels, None, 0).ok() };
    let Some(bitmap) = bitmap else {
        unsafe {
            let _ = DestroyIcon(file_info.hIcon);
        }
        return None;
    };
    let device_context = unsafe { CreateCompatibleDC(None) };
    if device_context.0.is_null() || pixels.is_null() {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DestroyIcon(file_info.hIcon);
        }
        return None;
    }

    let previous = unsafe { SelectObject(device_context, HGDIOBJ(bitmap.0)) };
    let rendered = unsafe {
        DrawIconEx(
            device_context,
            0,
            0,
            file_info.hIcon,
            ICON_SIZE,
            ICON_SIZE,
            0,
            None,
            DI_NORMAL,
        )
        .is_ok()
    };
    let pixel_count = (ICON_SIZE * ICON_SIZE * 4) as usize;
    let raw_pixels = if rendered {
        unsafe { std::slice::from_raw_parts(pixels.cast::<u8>(), pixel_count).to_vec() }
    } else {
        Vec::new()
    };
    unsafe {
        let _ = SelectObject(device_context, previous);
        let _ = DeleteDC(device_context);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DestroyIcon(file_info.hIcon);
    }
    if raw_pixels.is_empty() {
        return None;
    }

    let mut rgba = Vec::with_capacity(raw_pixels.len());
    for pixel in raw_pixels.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, ICON_SIZE as u32, ICON_SIZE as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded)
    ))
}

#[cfg(test)]
mod tests {
    use super::supported_kind;
    use std::path::Path;

    #[test]
    fn accepts_only_explicit_launcher_file_types() {
        assert_eq!(supported_kind(Path::new("tool.lnk")), Some("shortcut"));
        assert_eq!(supported_kind(Path::new("tool.url")), Some("url"));
        assert_eq!(supported_kind(Path::new("tool.exe")), Some("executable"));
        assert_eq!(supported_kind(Path::new("tool.cmd")), None);
    }
}
