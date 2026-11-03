use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const SEVEN_ZIP_VERSION: &str = "26.02";
const SEVEN_ZIP_URL: &str = "https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.exe";
const SEVEN_ZIP_SHA256: &str = "6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0";
const ZSTD_CODEC_URL: &str =
    "https://github.com/mcmilk/7-Zip-zstd/releases/download/v26.02-v1.5.7-R2/Codecs-x64.7z";
const ZSTD_CODEC_SHA256: &str = "2b20361214d0f7d06acc5567eb9bc90ac040204b69caf16915e9cb68d00747aa";
const SEVEN_ZIP_SIGNATURE: &[u8] = b"7z\xBC\xAF'\x1C";

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is required"));
    let _ = dotenvy::from_path(manifest_dir.join("../.env"));
    forward_env("BGM_APP_SECRET");
    prepare_bundled_seven_zip(&manifest_dir)
        .unwrap_or_else(|error| panic!("准备内置 7-Zip 失败: {error}"));
    tauri_build::build()
}

fn prepare_bundled_seven_zip(manifest_dir: &Path) -> Result<(), String> {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_OS");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_ARCH");

    let target_os =
        env::var("CARGO_CFG_TARGET_OS").map_err(|error| format!("读取目标系统失败: {error}"))?;
    let target_arch =
        env::var("CARGO_CFG_TARGET_ARCH").map_err(|error| format!("读取目标架构失败: {error}"))?;
    if target_os != "windows" || target_arch != "x86_64" {
        return Ok(());
    }

    let resource_root = manifest_dir.join("target/7zip");
    println!(
        "cargo:rerun-if-changed={}",
        resource_root.join(".reina-build-info").display()
    );
    if is_cached_seven_zip(&resource_root) {
        return Ok(());
    }

    let target_root = resource_root
        .parent()
        .ok_or_else(|| "无法定位构建缓存目录".to_string())?;
    let staging = target_root.join(format!(".reina-7zip-staging-{}", std::process::id()));
    remove_owned_directory(&staging)?;
    fs::create_dir_all(&staging).map_err(|error| format!("创建 7-Zip 暂存目录失败: {error}"))?;

    let result = prepare_seven_zip_files(&staging, &resource_root);
    let cleanup = remove_owned_directory(&staging);
    result?;
    cleanup
}

fn prepare_seven_zip_files(staging: &Path, resource_root: &Path) -> Result<(), String> {
    let installer = staging.join("7z2602-x64.exe");
    download_and_verify(SEVEN_ZIP_URL, &installer, SEVEN_ZIP_SHA256)?;
    let installer_files = staging.join("installer-files");
    extract_windows_installer(&installer, &installer_files)?;

    let codec = staging.join("Codecs-x64.7z");
    download_and_verify(ZSTD_CODEC_URL, &codec, ZSTD_CODEC_SHA256)?;
    let codec_files = staging.join("codec-files");
    extract_7z(&codec, &codec_files)?;

    let prepared = staging.join("prepared");
    fs::create_dir_all(prepared.join("Codecs"))
        .map_err(|error| format!("创建 7-Zip 输出目录失败: {error}"))?;
    copy_named_file(&installer_files, "7z.exe", &prepared)?;
    copy_named_file(&installer_files, "7z.dll", &prepared)?;
    copy_license(&installer_files, &prepared)?;
    copy_named_file(&codec_files, "zstd.dll", &prepared.join("Codecs"))?;
    copy_named_file(&codec_files, "LICENSE", &prepared.join("Codecs"))?;
    fs::write(
        prepared.join("NOTICE.md"),
        format!(
            "Bundled 7-Zip {SEVEN_ZIP_VERSION} for controlled archive extraction.\nSource: {SEVEN_ZIP_URL}\nLicense: License.txt\nBundled Zstd codec source: {ZSTD_CODEC_URL}\nCodec license: Codecs/LICENSE\n"
        ),
    )
    .map_err(|error| format!("写入 7-Zip 许可证说明失败: {error}"))?;
    fs::write(prepared.join(".reina-build-info"), cache_build_info())
        .map_err(|error| format!("写入 7-Zip 缓存标记失败: {error}"))?;

    remove_owned_directory(resource_root)?;
    fs::rename(&prepared, resource_root)
        .map_err(|error| format!("发布内置 7-Zip 文件失败: {error}"))
}

fn is_cached_seven_zip(resource_root: &Path) -> bool {
    fs::read_to_string(resource_root.join(".reina-build-info"))
        .is_ok_and(|value| value == cache_build_info())
        && resource_root.join("7z.exe").is_file()
        && resource_root.join("7z.dll").is_file()
        && resource_root.join("License.txt").is_file()
        && resource_root.join("Codecs/zstd.dll").is_file()
        && resource_root.join("Codecs/LICENSE").is_file()
}

fn cache_build_info() -> String {
    format!("{SEVEN_ZIP_VERSION}\nwindows-x86_64\n{ZSTD_CODEC_SHA256}\n")
}

fn download_and_verify(url: &str, destination: &Path, expected_sha256: &str) -> Result<(), String> {
    println!("cargo:warning=正在下载并校验内置 7-Zip 组件: {url}");
    let mut response = ureq::get(url)
        .call()
        .map_err(|error| format!("下载内置 7-Zip 组件失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "下载内置 7-Zip 组件返回 HTTP {}",
            response.status()
        ));
    }
    let temporary = destination.with_extension("part");
    let mut output = File::create(&temporary)
        .map_err(|error| format!("创建 7-Zip 临时下载文件失败: {error}"))?;
    io::copy(&mut response.body_mut().as_reader(), &mut output)
        .map_err(|error| format!("写入 7-Zip 下载文件失败: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("刷新 7-Zip 下载文件失败: {error}"))?;
    verify_sha256(&temporary, expected_sha256)?;
    fs::rename(&temporary, destination).map_err(|error| format!("完成 7-Zip 下载文件失败: {error}"))
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("读取校验文件失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取校验文件失败: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "7-Zip SHA-256 校验失败，期望 {expected}，实际 {actual}"
        ))
    }
}

fn extract_windows_installer(installer: &Path, output: &Path) -> Result<(), String> {
    if extract_7z(installer, output).is_ok() {
        return Ok(());
    }
    let bytes = fs::read(installer).map_err(|error| format!("读取 7-Zip 安装包失败: {error}"))?;
    for (offset, window) in bytes.windows(SEVEN_ZIP_SIGNATURE.len()).enumerate() {
        if window != SEVEN_ZIP_SIGNATURE {
            continue;
        }
        remove_owned_directory(output)?;
        let embedded = output.with_extension("embedded.7z");
        fs::write(&embedded, &bytes[offset..])
            .map_err(|error| format!("写入 7-Zip 内嵌归档失败: {error}"))?;
        let extracted = extract_7z(&embedded, output).is_ok();
        let _ = fs::remove_file(&embedded);
        if extracted {
            return Ok(());
        }
    }
    Err("无法从 7-Zip Windows 安装包提取受控运行文件".to_string())
}

fn extract_7z(archive: &Path, output: &Path) -> Result<(), String> {
    remove_owned_directory(output)?;
    fs::create_dir_all(output).map_err(|error| format!("创建 7-Zip 解压目录失败: {error}"))?;
    sevenz_rust2::decompress_file(archive, output)
        .map_err(|error| format!("解压 7-Zip 构建组件失败: {error}"))
}

fn copy_named_file(
    source_root: &Path,
    file_name: &str,
    destination_root: &Path,
) -> Result<(), String> {
    let source = find_named_file(source_root, file_name)?;
    fs::copy(&source, destination_root.join(file_name))
        .map_err(|error| format!("复制内置文件 {file_name} 失败: {error}"))?;
    Ok(())
}

fn copy_license(source_root: &Path, destination_root: &Path) -> Result<(), String> {
    let source = find_named_file(source_root, "License.txt")
        .or_else(|_| find_named_file(source_root, "license.txt"))?;
    fs::copy(source, destination_root.join("License.txt"))
        .map_err(|error| format!("复制 7-Zip 许可证失败: {error}"))?;
    Ok(())
}

fn find_named_file(directory: &Path, file_name: &str) -> Result<PathBuf, String> {
    let entries =
        fs::read_dir(directory).map_err(|error| format!("读取 7-Zip 解压目录失败: {error}"))?;
    for entry in entries {
        let path = entry
            .map_err(|error| format!("读取 7-Zip 解压目录项失败: {error}"))?
            .path();
        if path.is_dir() {
            if let Ok(found) = find_named_file(&path, file_name) {
                return Ok(found);
            }
        } else if path.file_name().is_some_and(|name| name == file_name) {
            return Ok(path);
        }
    }
    Err(format!("内置 7-Zip 文件缺失: {file_name}"))
}

fn remove_owned_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("拒绝清理符号链接目录: {}", path.display()))
        }
        Ok(metadata) if metadata.is_dir() => {
            fs::remove_dir_all(path).map_err(|error| format!("清理构建暂存目录失败: {error}"))
        }
        Ok(_) => Err(format!("构建缓存路径不是目录: {}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("读取构建缓存目录失败: {error}")),
    }
}

fn forward_env(name: &str) {
    println!("cargo:rerun-if-env-changed={}", name);
    println!("cargo:rerun-if-changed=../.env");

    if let Ok(value) = std::env::var(name) {
        let value = value.trim();
        if !value.is_empty() {
            println!("cargo:rustc-env={}={}", name, value);
        }
    }
}
