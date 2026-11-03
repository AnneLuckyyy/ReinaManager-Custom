//! 7z 压缩/解压工具模块
//!
//! 提供基于 Zstd 的 7z 压缩与解压功能，供存档备份、自定义封面备份等多处复用。

use sevenz_rust2::{ArchiveReader, ArchiveWriter, Password, encoder_options::ZstandardOptions};
use std::fs;
use std::path::Path;

/// 速度与压缩率折中：使用 Zstd 低压缩等级。
const ZSTD_COMPRESSION_LEVEL: u32 = 3;

/// 创建 7z 压缩包（递归压缩整个目录）
///
/// # Arguments
/// * `source_dir` - 源目录路径
/// * `archive_path` - 目标压缩包路径
///
/// # Returns
/// * `Result<u64, Box<dyn std::error::Error>>` - 压缩包文件大小或错误
pub fn create_7z_archive(
    source_dir: &Path,
    archive_path: &Path,
) -> Result<u64, Box<dyn std::error::Error>> {
    let mut writer = ArchiveWriter::create(archive_path)?;

    let zstd_options = ZstandardOptions::from_level(ZSTD_COMPRESSION_LEVEL);
    log::info!("7z 压缩参数: codec=ZSTD, level={}", ZSTD_COMPRESSION_LEVEL);
    writer.set_content_methods(vec![zstd_options.into()]);

    // 递归添加源目录中的所有文件，过滤器返回 true 表示包含
    writer.push_source_path(source_dir, |_| true)?;

    writer.finish()?;

    let metadata = fs::metadata(archive_path)?;
    Ok(metadata.len())
}

/// 重新打开归档并读取头部，避免发布无法解析的备份文件。
pub fn verify_7z_archive(archive_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    ArchiveReader::open(archive_path, Password::empty())?;
    Ok(())
}
