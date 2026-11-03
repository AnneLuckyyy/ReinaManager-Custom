use std::path::PathBuf;

/// 数据库相关路径常量
pub const DB_DATA_DIR: &str = "data";
pub const DB_FILE_NAME: &str = "reina_manager.db";

// 基础数据目录下的子目录名称
pub const BACKUP_SUBDIR: &str = "backups";
pub const RESOURCE_DIR: &str = "resources";

const RELEASE_DATA_IDENTIFIER: &str = "com.reinamanager.dev";
const DEVELOPMENT_DATA_IDENTIFIER: &str = "com.reinamanager.localtest";

fn data_identifier() -> &'static str {
    if cfg!(debug_assertions) {
        DEVELOPMENT_DATA_IDENTIFIER
    } else {
        RELEASE_DATA_IDENTIFIER
    }
}

/// 判断是否处于便携模式（纯 Rust 版本）
///
/// 检测逻辑：检查可执行文件同级目录下是否存在 resources/data 目录。
pub fn is_portable_mode() -> bool {
    // 开发构建必须始终使用隔离的 AppData 目录。即使开发启动方式、工作目录
    // 或测试环境意外落在便携版附近，也不能借由 resources/data 接触正式版数据。
    if cfg!(debug_assertions) {
        return false;
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let portable_data_dir = exe_dir.join(RESOURCE_DIR).join(DB_DATA_DIR);
            return portable_data_dir.is_dir();
        }
    }
    false
}

/// 获取基础数据根目录。
///
/// 该目录是应用非数据库资源的统一根目录：
/// - 便携模式: `<exe>/resources`
/// - 安装模式: `<system-data>/<identifier>`
///
/// 数据库属于该根目录下的专用子目录 `<base>/data`，不要把本函数当作数据库目录使用。
pub fn get_base_data_dir() -> Result<PathBuf, String> {
    if is_portable_mode() {
        get_base_data_dir_for_mode(true)
    } else {
        let system_dir = get_base_data_dir_for_mode(false)?;
        std::fs::create_dir_all(&system_dir)
            .map_err(|e| format!("无法创建系统数据目录 {}: {}", system_dir.display(), e))?;
        Ok(system_dir)
    }
}

/// 获取指定模式下的基础数据根目录。
///
/// 返回值语义与 `get_base_data_dir` 一致：
/// - 便携模式: `<exe>/resources`
/// - 安装模式: `<system-data>/<identifier>`
pub fn get_base_data_dir_for_mode(portable: bool) -> Result<PathBuf, String> {
    if portable {
        let exe_path =
            std::env::current_exe().map_err(|e| format!("无法获取可执行文件路径: {}", e))?;
        let exe_dir = exe_path
            .parent()
            .ok_or_else(|| "无法获取可执行文件父目录".to_string())?;
        Ok(exe_dir.join(RESOURCE_DIR))
    } else {
        use directories::BaseDirs;

        let base_dirs = BaseDirs::new().ok_or_else(|| "无法获取系统目录信息".to_string())?;

        Ok(base_dirs.data_dir().join(data_identifier()))
    }
}

/// 获取指定应用标识的本机 LocalAppData 目录。
///
/// 仅供受控的历史身份迁移使用；调用方不得将用户输入直接传入此函数。
pub fn get_local_data_dir_for_identifier(identifier: &str) -> Result<PathBuf, String> {
    use directories::BaseDirs;

    let base_dirs = BaseDirs::new().ok_or_else(|| "无法获取系统目录信息".to_string())?;
    Ok(base_dirs.data_local_dir().join(identifier))
}

/// 获取数据库专用目录 `<base>/data`。
pub fn get_db_data_dir() -> Result<PathBuf, String> {
    Ok(get_base_data_dir()?.join(DB_DATA_DIR))
}

/// 获取指定模式下的数据库专用目录 `<base>/data`。
pub fn get_db_data_dir_for_mode(portable: bool) -> Result<PathBuf, String> {
    Ok(get_base_data_dir_for_mode(portable)?.join(DB_DATA_DIR))
}

/// 获取数据库文件路径 `<base>/data/reina_manager.db`。
pub fn get_db_path() -> Result<PathBuf, String> {
    Ok(get_db_data_dir()?.join(DB_FILE_NAME))
}

/// 获取默认的数据库备份路径
pub fn get_default_db_backup_path() -> Result<PathBuf, String> {
    Ok(get_db_data_dir()?.join(BACKUP_SUBDIR))
}

/// 获取默认的存档备份路径
pub fn get_default_savedata_backup_path() -> Result<PathBuf, String> {
    Ok(get_base_data_dir()?.join(BACKUP_SUBDIR))
}
