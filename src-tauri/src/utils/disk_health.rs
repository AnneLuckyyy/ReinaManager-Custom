use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const DISK_INFO_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const DISK_HEALTH_TASK_NAME: &str = "ReinaManager Disk Health";
const CONNECT_FILE_NAME: &str = "ReinaManager-DiskHealth-Connect.cmd";
#[cfg(target_os = "windows")]
const DISCONNECT_FILE_NAME: &str = "ReinaManager-DiskHealth-Disconnect.cmd";
#[cfg(target_os = "windows")]
const CONNECT_LOG_NAME: &str = "ReinaManager-DiskHealth-Connect.log";
#[cfg(target_os = "windows")]
const DISCONNECT_LOG_NAME: &str = "ReinaManager-DiskHealth-Disconnect.log";
#[cfg(target_os = "windows")]
const POWERSHELL_PAYLOAD_MARKER: &str = "# REINA_POWERSHELL_PAYLOAD";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskHealthConnectionFile {
    pub file_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskHealthConnectionCheck {
    pub executable_path: String,
    pub fingerprint: String,
    pub snapshot: DiskHealthSnapshot,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskHealthIndicators {
    pub reallocated_sectors: Option<String>,
    pub pending_sectors: Option<String>,
    pub uncorrectable_sectors: Option<String>,
    pub nvme_critical_warning: Option<String>,
    pub nvme_media_errors: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskHealthDrive {
    pub id: String,
    pub model: String,
    pub drive_letters: String,
    pub health: String,
    pub health_percent: Option<u8>,
    pub temperature: Option<i32>,
    pub indicators: DiskHealthIndicators,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskHealthSnapshot {
    pub checked_at: String,
    pub drives: Vec<DiskHealthDrive>,
}

#[derive(Default)]
struct DiskDraft {
    model: String,
    serial_number: String,
    drive_letters: String,
    interface: String,
    health: String,
    health_percent: Option<u8>,
    temperature: Option<i32>,
    indicators: DiskHealthIndicators,
    in_smart_table: bool,
}

impl DiskDraft {
    fn finish(self) -> Option<DiskHealthDrive> {
        if self.model.is_empty() {
            return None;
        }

        let mut health = normalize_health(&self.health).to_string();
        if indicator_is_positive(&self.indicators.nvme_critical_warning) {
            health = "critical".to_string();
        } else if indicator_is_positive(&self.indicators.reallocated_sectors)
            || indicator_is_positive(&self.indicators.pending_sectors)
            || indicator_is_positive(&self.indicators.uncorrectable_sectors)
            || indicator_is_positive(&self.indicators.nvme_media_errors)
        {
            health = "attention".to_string();
        }

        let id = if self.serial_number.is_empty() {
            format!("{}|{}", self.model, self.drive_letters)
        } else {
            self.serial_number
        };

        Some(DiskHealthDrive {
            id,
            model: self.model,
            drive_letters: self.drive_letters,
            health,
            health_percent: self.health_percent,
            temperature: self.temperature,
            indicators: self.indicators,
        })
    }
}

#[tauri::command]
pub async fn read_disk_health(
    executable_path: String,
    use_authorized_task: Option<bool>,
    authorization_fingerprint: Option<String>,
) -> Result<DiskHealthSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_disk_health_blocking(
            &executable_path,
            use_authorized_task.unwrap_or(false),
            authorization_fingerprint.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("磁盘读取任务异常：{error}"))?
}

#[tauri::command]
pub async fn prepare_disk_health_connection(
    executable_path: String,
    workspace_path: String,
) -> Result<DiskHealthConnectionFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_disk_health_connection_blocking(&executable_path, &workspace_path)
    })
    .await
    .map_err(|error| format!("磁盘连接准备异常：{error}"))?
}

#[tauri::command]
pub async fn check_disk_health_connection(
    executable_path: String,
    workspace_path: String,
) -> Result<DiskHealthConnectionCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_disk_health_connection_blocking(&executable_path, &workspace_path)
    })
    .await
    .map_err(|error| format!("磁盘连接检查异常：{error}"))?
}

#[tauri::command]
pub async fn prepare_disk_health_disconnection(
    workspace_path: String,
) -> Result<DiskHealthConnectionFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_disk_health_disconnection_blocking(&workspace_path)
    })
    .await
    .map_err(|error| format!("磁盘取消连接准备异常：{error}"))?
}

fn read_disk_health_blocking(
    executable_path: &str,
    use_authorized_task: bool,
    authorization_fingerprint: Option<&str>,
) -> Result<DiskHealthSnapshot, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = executable_path;
        return Err("磁盘健康功能仅支持 Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let cleaned_path = trim_path_quotes(executable_path);
        let executable = PathBuf::from(cleaned_path);
        if !executable.is_file() {
            return Err("未找到 CrystalDiskInfo".to_string());
        }
        if !executable
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            return Err("请选择 CrystalDiskInfo 程序".to_string());
        }

        let working_directory = executable
            .parent()
            .ok_or_else(|| "CrystalDiskInfo 路径无效".to_string())?;
        let report_path = working_directory.join("DiskInfo.txt");
        let previous_report = report_signature(&report_path);

        if use_authorized_task {
            let expected_fingerprint = authorization_fingerprint
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "[AUTH_STALE] 磁盘连接已失效".to_string())?;
            let current_fingerprint = sha256_file(&executable)?;
            if !current_fingerprint.eq_ignore_ascii_case(expected_fingerprint) {
                return Err("[AUTH_STALE] CrystalDiskInfo 已变化，请重新连接".to_string());
            }
            run_authorized_disk_health_task(&report_path, previous_report)?;
            return read_and_parse_report(&report_path);
        }

        let mut command = Command::new(&executable);
        command
            .arg("/CopyExit")
            .current_dir(working_directory)
            .creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|error| {
            if error.raw_os_error() == Some(740) {
                "[ELEVATION_REQUIRED] CrystalDiskInfo 需要授权".to_string()
            } else {
                format!("CrystalDiskInfo 启动失败：{error}")
            }
        })?;

        let started_at = Instant::now();
        let exit_status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started_at.elapsed() < DISK_INFO_TIMEOUT => {
                    thread::sleep(Duration::from_millis(200));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("CrystalDiskInfo 读取超时".to_string());
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("CrystalDiskInfo 状态读取失败：{error}"));
                }
            }
        };

        if !exit_status.success() {
            return Err(format!(
                "CrystalDiskInfo 已退出，代码 {}",
                exit_status.code().unwrap_or(-1)
            ));
        }

        let current_report = report_signature(&report_path)
            .ok_or_else(|| "CrystalDiskInfo 未生成报告".to_string())?;
        if previous_report.is_some_and(|previous| previous == current_report) {
            return Err("CrystalDiskInfo 报告未更新".to_string());
        }

        read_and_parse_report(&report_path)
    }
}

fn read_and_parse_report(report_path: &Path) -> Result<DiskHealthSnapshot, String> {
    let report_bytes =
        fs::read(report_path).map_err(|error| format!("CrystalDiskInfo 报告读取失败：{error}"))?;
    let report = decode_report(&report_bytes);
    parse_disk_info_report(&report)
}

#[cfg(target_os = "windows")]
fn run_authorized_disk_health_task(
    report_path: &Path,
    previous_report: Option<(SystemTime, u64)>,
) -> Result<(), String> {
    let status = Command::new("schtasks.exe")
        .args(["/Run", "/TN", DISK_HEALTH_TASK_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("[AUTH_STALE] 连接任务启动失败：{error}"))?;
    if !status.success() {
        return Err("[AUTH_STALE] 磁盘连接已失效".to_string());
    }

    let started_at = Instant::now();
    let mut observed_report = previous_report;
    let mut stable_since: Option<Instant> = None;
    while started_at.elapsed() < DISK_INFO_TIMEOUT + Duration::from_secs(5) {
        if let Some(current_report) = report_signature(report_path) {
            if previous_report.is_none_or(|previous| previous != current_report) {
                if observed_report == Some(current_report) {
                    if stable_since.is_some_and(|since| since.elapsed() >= Duration::from_secs(1)) {
                        return Ok(());
                    }
                } else {
                    observed_report = Some(current_report);
                    stable_since = Some(Instant::now());
                }
            }
        }
        thread::sleep(Duration::from_millis(250));
    }

    Err("CrystalDiskInfo 报告未更新".to_string())
}

#[cfg(target_os = "windows")]
fn prepare_disk_health_connection_blocking(
    executable_path: &str,
    workspace_path: &str,
) -> Result<DiskHealthConnectionFile, String> {
    let workspace = validate_workspace_directory(workspace_path)?;
    let executable = validate_executable(executable_path)?;
    let executable_quoted = powershell_quote(&executable.to_string_lossy());
    let working_directory = executable
        .parent()
        .ok_or_else(|| "CrystalDiskInfo 路径无效".to_string())?;
    let working_directory_quoted = powershell_quote(&working_directory.to_string_lossy());
    let task_name = powershell_quote(DISK_HEALTH_TASK_NAME);
    let result_path = workspace.join(CONNECT_LOG_NAME);
    let result_path_quoted = powershell_quote(&result_path.to_string_lossy());
    let _ = fs::remove_file(&result_path);
    let setup_script = format!(
        r#"$ErrorActionPreference = 'Stop'
$result = '{result_path_quoted}'
try {{
$action = New-ScheduledTaskAction -Execute '{executable_quoted}' -Argument '/CopyExit' -WorkingDirectory '{working_directory_quoted}'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '{task_name}' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
}} catch {{
    try {{ [IO.File]::WriteAllText($result, ($_ | Out-String)) }} catch {{}}
    exit 31
}}
"#
    );
    write_manual_connection_file(&workspace, CONNECT_FILE_NAME, &setup_script, "Connected.")
}

#[cfg(not(target_os = "windows"))]
fn prepare_disk_health_connection_blocking(
    _executable_path: &str,
    _workspace_path: &str,
) -> Result<DiskHealthConnectionFile, String> {
    Err("磁盘健康功能仅支持 Windows".to_string())
}

#[cfg(target_os = "windows")]
fn check_disk_health_connection_blocking(
    executable_path: &str,
    workspace_path: &str,
) -> Result<DiskHealthConnectionCheck, String> {
    let executable = validate_executable(executable_path)?;
    let fingerprint = sha256_file(&executable)?;
    let snapshot =
        read_disk_health_blocking(executable_path, true, Some(&fingerprint)).map_err(|error| {
            if error.contains("[AUTH_STALE]") {
                let workspace = PathBuf::from(trim_path_quotes(workspace_path));
                let result_path = workspace.join(CONNECT_LOG_NAME);
                if result_path.is_file() {
                    return format!("连接文件执行失败，请查看 {}", result_path.to_string_lossy());
                }
            }
            error
        })?;

    Ok(DiskHealthConnectionCheck {
        executable_path: executable.to_string_lossy().into_owned(),
        fingerprint,
        snapshot,
    })
}

#[cfg(not(target_os = "windows"))]
fn check_disk_health_connection_blocking(
    _executable_path: &str,
    _workspace_path: &str,
) -> Result<DiskHealthConnectionCheck, String> {
    Err("磁盘健康功能仅支持 Windows".to_string())
}

#[cfg(target_os = "windows")]
fn prepare_disk_health_disconnection_blocking(
    workspace_path: &str,
) -> Result<DiskHealthConnectionFile, String> {
    let workspace = validate_workspace_directory(workspace_path)?;
    let task_name = powershell_quote(DISK_HEALTH_TASK_NAME);
    let result_path = workspace.join(DISCONNECT_LOG_NAME);
    let result_path_quoted = powershell_quote(&result_path.to_string_lossy());
    let _ = fs::remove_file(&result_path);
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$result = '{result_path_quoted}'
try {{
    Unregister-ScheduledTask -TaskName '{task_name}' -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
}} catch {{
    try {{ [IO.File]::WriteAllText($result, ($_ | Out-String)) }} catch {{}}
    exit 31
}}"#
    );
    write_manual_connection_file(&workspace, DISCONNECT_FILE_NAME, &script, "Disconnected.")
}

#[cfg(not(target_os = "windows"))]
fn prepare_disk_health_disconnection_blocking(
    _workspace_path: &str,
) -> Result<DiskHealthConnectionFile, String> {
    Err("磁盘健康功能仅支持 Windows".to_string())
}

#[cfg(target_os = "windows")]
fn validate_executable(executable_path: &str) -> Result<PathBuf, String> {
    let executable = PathBuf::from(trim_path_quotes(executable_path));
    if !executable.is_file() {
        return Err("未找到 CrystalDiskInfo".to_string());
    }
    if !executable
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
    {
        return Err("请选择 CrystalDiskInfo 程序".to_string());
    }
    Ok(executable)
}

#[cfg(target_os = "windows")]
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("程序校验失败：{error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = file
            .read(&mut buffer)
            .map_err(|error| format!("程序校验失败：{error}"))?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
    }
    Ok(format!("{:X}", digest.finalize()))
}

#[cfg(target_os = "windows")]
fn powershell_quote(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn write_manual_connection_file(
    directory: &Path,
    file_name: &str,
    script: &str,
    success_message: &str,
) -> Result<DiskHealthConnectionFile, String> {
    let file_path = directory.join(file_name);
    let batch = build_manual_connection_batch(script, success_message);
    fs::write(&file_path, batch).map_err(|error| format!("连接文件写入失败：{error}"))?;
    open_connection_file_location(&file_path)?;

    Ok(DiskHealthConnectionFile {
        file_path: file_path.to_string_lossy().into_owned(),
    })
}

#[cfg(target_os = "windows")]
fn build_manual_connection_batch(script: &str, success_message: &str) -> String {
    format!(
        r#"@echo off
setlocal
set "REINA_CONNECTION_FILE=%~f0"
fltmc >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:REINA_CONNECTION_FILE -Verb RunAs"
  exit /b
)
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$content = [IO.File]::ReadAllText($env:REINA_CONNECTION_FILE); $marker = ('# REINA_' + 'POWERSHELL_PAYLOAD'); $index = $content.IndexOf($marker); if ($index -lt 0) {{ exit 2 }}; Invoke-Expression $content.Substring($index + $marker.Length)"
if errorlevel 1 (
  echo.
  echo Operation failed.
  pause
  exit /b 1
)
echo.
echo {success_message}
timeout /t 3 /nobreak >nul
del /f /q "%~f0" >nul 2>&1
exit /b 0
{POWERSHELL_PAYLOAD_MARKER}
{script}
"#
    )
}

#[cfg(target_os = "windows")]
fn open_connection_file_location(file_path: &Path) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(format!("/select,\"{}\"", file_path.to_string_lossy()))
        .spawn()
        .map_err(|error| format!("连接文件位置打开失败：{error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn validate_workspace_directory(workspace_path: &str) -> Result<PathBuf, String> {
    let directory = PathBuf::from(trim_path_quotes(workspace_path));
    if !directory.is_dir() {
        return Err("未找到操作目录".to_string());
    }
    Ok(directory)
}

fn trim_path_quotes(value: &str) -> &str {
    value
        .trim()
        .trim_start_matches(['\'', '"'])
        .trim_end_matches(['\'', '"'])
        .trim()
}

fn report_signature(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

fn decode_report(bytes: &[u8]) -> String {
    if let Ok(value) = String::from_utf8(bytes.to_vec()) {
        return value.trim_start_matches('\u{feff}').to_string();
    }

    let (gbk, _, gbk_errors) = encoding_rs::GBK.decode(bytes);
    if !gbk_errors {
        return gbk.into_owned();
    }

    let (shift_jis, _, _) = encoding_rs::SHIFT_JIS.decode(bytes);
    shift_jis.into_owned()
}

fn parse_disk_info_report(report: &str) -> Result<DiskHealthSnapshot, String> {
    let mut drives = Vec::new();
    let mut current: Option<DiskDraft> = None;

    for line in report.lines() {
        if let Some(model) = field_value(line, "Model") {
            if let Some(drive) = current.take().and_then(DiskDraft::finish) {
                drives.push(drive);
            }
            current = Some(DiskDraft {
                model: model.to_string(),
                ..DiskDraft::default()
            });
            continue;
        }

        let Some(drive) = current.as_mut() else {
            continue;
        };

        if let Some(value) = field_value(line, "Serial Number") {
            drive.serial_number = value.to_string();
        } else if let Some(value) = field_value(line, "Interface") {
            drive.interface = value.to_string();
        } else if let Some(value) = field_value(line, "Temperature") {
            drive.temperature = parse_temperature(value);
        } else if let Some(value) = field_value(line, "Health Status") {
            drive.health = value.to_string();
            drive.health_percent = parse_health_percent(value);
        } else if let Some(value) = field_value(line, "Drive Letter") {
            drive.drive_letters = value.to_string();
        } else if line.starts_with("-- S.M.A.R.T.") {
            drive.in_smart_table = true;
        } else if line.starts_with("-- ") {
            drive.in_smart_table = false;
        } else if drive.in_smart_table {
            parse_smart_line(drive, line);
        }
    }

    if let Some(drive) = current.and_then(DiskDraft::finish) {
        drives.push(drive);
    }

    if drives.is_empty() {
        return Err("CrystalDiskInfo 报告中没有磁盘".to_string());
    }

    Ok(DiskHealthSnapshot {
        checked_at: Utc::now().to_rfc3339(),
        drives,
    })
}

fn field_value<'a>(line: &'a str, label: &str) -> Option<&'a str> {
    let (left, right) = line.split_once(':')?;
    (left.trim() == label).then(|| right.trim())
}

fn parse_temperature(value: &str) -> Option<i32> {
    let parts: Vec<_> = value.split_whitespace().collect();
    parts
        .windows(2)
        .find(|pair| pair[1].eq_ignore_ascii_case("C"))
        .and_then(|pair| pair[0].parse().ok())
}

fn parse_health_percent(value: &str) -> Option<u8> {
    let percent_index = value.find('%')?;
    value[..percent_index]
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .next_back()?
        .parse()
        .ok()
}

fn normalize_health(value: &str) -> &'static str {
    let value = value.to_lowercase();
    if ["bad", "critical", "异常", "危険", "危险", "故障"]
        .iter()
        .any(|keyword| value.contains(keyword))
    {
        "critical"
    } else if ["caution", "warning", "注意", "警告", "需关注"]
        .iter()
        .any(|keyword| value.contains(keyword))
    {
        "attention"
    } else if ["good", "normal", "良好", "正常"]
        .iter()
        .any(|keyword| value.contains(keyword))
    {
        "normal"
    } else {
        "unknown"
    }
}

fn parse_smart_line(drive: &mut DiskDraft, line: &str) {
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return;
    }

    let id = parts[0].to_ascii_uppercase();
    let is_nvme = drive.interface.to_ascii_lowercase().contains("nvm express");
    let raw_value = if is_nvme { parts.get(1) } else { parts.get(4) };
    let Some(raw_value) = raw_value.and_then(|value| parse_hex_value(value)) else {
        return;
    };

    match (is_nvme, id.as_str()) {
        (true, "01") => drive.indicators.nvme_critical_warning = Some(raw_value),
        (true, "0E") => drive.indicators.nvme_media_errors = Some(raw_value),
        (false, "05") => drive.indicators.reallocated_sectors = Some(raw_value),
        (false, "C5") => drive.indicators.pending_sectors = Some(raw_value),
        (false, "C6") => drive.indicators.uncorrectable_sectors = Some(raw_value),
        _ => {}
    }
}

fn parse_hex_value(value: &str) -> Option<String> {
    let trimmed = value.trim_matches(|character: char| !character.is_ascii_hexdigit());
    u128::from_str_radix(trimmed, 16)
        .ok()
        .map(|number| number.to_string())
}

fn indicator_is_positive(value: &Option<String>) -> bool {
    value
        .as_deref()
        .and_then(|value| value.parse::<u128>().ok())
        .is_some_and(|value| value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvme_and_ata_health() {
        let report = r#"
           Model : NVME Sample
   Serial Number : NV1
       Interface : NVM Express
     Temperature : 51 C (123 F)
   Health Status : 良好 (92 %)
    Drive Letter : C: E:
-- S.M.A.R.T. --------------------------------------------------------------
ID RawValues(6) Attribute Name
01 000000000000 严重警告标志
0E 000000000001 介质与数据完整性错误计数
-- SMART_NVME --------------------------------------------------------------
           Model : HDD Sample
   Serial Number : HDD1
       Interface : USB (Serial ATA)
     Temperature : 36 C (96 F)
   Health Status : Good
    Drive Letter : G:
-- S.M.A.R.T. --------------------------------------------------------------
ID Cur Wor Thr RawValues(6) Attribute Name
05 100 100 _50 000000000000 Reallocated Sectors Count
C5 100 100 __0 000000000000 Current Pending Sector Count
C6 100 100 __0 000000000000 Uncorrectable Sector Count
"#;

        let result = parse_disk_info_report(report).expect("report should parse");
        assert_eq!(result.drives.len(), 2);
        assert_eq!(result.drives[0].health, "attention");
        assert_eq!(result.drives[0].temperature, Some(51));
        assert_eq!(result.drives[0].health_percent, Some(92));
        assert_eq!(
            result.drives[0].indicators.nvme_media_errors.as_deref(),
            Some("1")
        );
        assert_eq!(result.drives[1].health, "normal");
        assert_eq!(
            result.drives[1].indicators.pending_sectors.as_deref(),
            Some("0")
        );
    }

    #[test]
    fn maps_localized_health_labels() {
        assert_eq!(normalize_health("Good (100 %)"), "normal");
        assert_eq!(normalize_health("良好"), "normal");
        assert_eq!(normalize_health("注意"), "attention");
        assert_eq!(normalize_health("Bad"), "critical");
        assert_eq!(normalize_health("不明"), "unknown");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn manual_connection_file_is_short_and_defers_elevation_until_opened() {
        let batch = build_manual_connection_batch("Write-Output 'payload'", "Connected.");
        assert!(batch.contains("Start-Process -FilePath $env:REINA_CONNECTION_FILE -Verb RunAs"));
        assert!(batch.contains("Write-Output 'payload'"));
        assert!(batch.contains("del /f /q \"%~f0\""));
        assert_eq!(batch.matches(POWERSHELL_PAYLOAD_MARKER).count(), 1);
        assert!(batch.lines().all(|line| line.len() < 8191));
        assert!(!batch.contains("ReinaManager.exe"));
    }
}
