use std::fs;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use std::path::Path;

pub(super) fn reject_path_redirector(metadata: &fs::Metadata, path: &Path) -> Result<(), String> {
    if metadata.file_type().is_symlink() {
        return Err(format!("路径不能是符号链接: {}", path.display()));
    }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 && has_name_surrogate_reparse_tag(path)? {
        return Err(format!(
            "路径不能是 junction 或其他重定向型 reparse 对象: {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn has_name_surrogate_reparse_tag(path: &Path) -> Result<bool, String> {
    use std::mem::size_of;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo,
        GetFileInformationByHandleEx,
    };

    let file = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .custom_flags((FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS).0)
        .open(path)
        .map_err(|error| format!("打开 reparse 对象失败 {}: {error}", path.display()))?;
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: handle is held by `file`; the output allocation matches its type and length.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileAttributeTagInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    }
    .map_err(|error| format!("读取 reparse tag 失败 {}: {error}", path.display()))?;

    Ok(info.ReparseTag & 0x2000_0000 != 0)
}
