use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::command;

fn supported_image_extension(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "webp" => Some("webp"),
        "gif" => Some("gif"),
        "bmp" => Some("bmp"),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn clipboard_image_file() -> Option<(std::path::PathBuf, &'static str)> {
    use clipboard_win::{formats, get_clipboard};

    let files: Vec<std::path::PathBuf> = get_clipboard(formats::FileList).ok()?;
    files.into_iter().find_map(|path| {
        path.is_file()
            .then(|| supported_image_extension(&path).map(|extension| (path, extension)))
            .flatten()
    })
}

/// 从 Windows 剪贴板读取图片或已复制的图片文件，写入临时目录。
/// 临时文件只用于保存前预览，前端负责在替换、保存或离开编辑页时删除。
#[cfg(target_os = "windows")]
#[command]
pub async fn import_clipboard_image_to_temp(game_id: u32) -> Result<String, String> {
    use clipboard_win::{formats, get_clipboard};

    let timestamp_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("获取系统时间失败: {}", e))?
        .as_nanos();

    let temp_dir = std::env::temp_dir()
        .join("ReinaManager")
        .join("clipboard-cover");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建剪贴板图片临时目录失败: {}", e))?;

    if let Ok(bitmap) = get_clipboard::<Vec<u8>, _>(formats::Bitmap) {
        let target_path = temp_dir.join(format!(
            "clipboard_cover_{}_{}.bmp",
            game_id, timestamp_nanos
        ));
        fs::write(&target_path, bitmap)
            .map_err(|e| format!("CLIPBOARD_IMAGE_WRITE_FAILED: {}", e))?;
        return Ok(target_path.to_string_lossy().to_string());
    }

    if let Some((source_path, extension)) = clipboard_image_file() {
        let target_path = temp_dir.join(format!(
            "clipboard_cover_{}_{}.{}",
            game_id, timestamp_nanos, extension
        ));
        fs::copy(source_path, &target_path)
            .map_err(|e| format!("CLIPBOARD_IMAGE_WRITE_FAILED: {}", e))?;
        return Ok(target_path.to_string_lossy().to_string());
    }

    Err("CLIPBOARD_IMAGE_NOT_FOUND".to_string())
}

#[cfg(not(target_os = "windows"))]
#[command]
pub async fn import_clipboard_image_to_temp(_game_id: u32) -> Result<String, String> {
    Err("CLIPBOARD_IMAGE_READ_UNSUPPORTED".to_string())
}
