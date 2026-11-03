//! Windows 系统代理读取：仅返回当前用户明确启用的静态代理地址。
//! 不监听、不保存，也不读取 PAC 脚本或账户凭据。

#[cfg(target_os = "windows")]
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, REG_DWORD, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    RegOpenKeyExW, RegQueryValueExW,
};
#[cfg(target_os = "windows")]
use windows::core::{Owned, PCWSTR, w};

#[cfg(target_os = "windows")]
const INTERNET_SETTINGS_KEY: PCWSTR =
    w!("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
#[cfg(target_os = "windows")]
const PROXY_ENABLE_VALUE: PCWSTR = w!("ProxyEnable");
#[cfg(target_os = "windows")]
const PROXY_SERVER_VALUE: PCWSTR = w!("ProxyServer");

fn normalize_proxy_server(raw: &str) -> Option<String> {
    let value = raw
        .split(';')
        .find_map(|part| {
            let (scheme, address) = part.split_once('=')?;
            matches!(
                scheme.trim().to_ascii_lowercase().as_str(),
                "https" | "http"
            )
            .then_some(address.trim())
        })
        .or_else(|| raw.split(';').find(|part| !part.contains('=')))
        .unwrap_or("")
        .trim();

    if value.is_empty() {
        return None;
    }

    if value.starts_with("http://") || value.starts_with("https://") || value.starts_with("socks") {
        return Some(value.to_string());
    }

    Some(format!("http://{value}"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn get_windows_system_proxy() -> Option<String> {
    let mut key = HKEY::default();
    // SAFETY: 所有指针都指向当前栈帧内有效的常量或可写句柄位置。
    if unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            INTERNET_SETTINGS_KEY,
            None,
            KEY_QUERY_VALUE,
            &mut key,
        )
    }
    .is_err()
    {
        return None;
    }
    // SAFETY: RegOpenKeyExW 成功后，当前作用域唯一持有该注册表句柄。
    let key = unsafe { Owned::new(key) };

    let mut enabled = 0u32;
    let mut enabled_len = std::mem::size_of::<u32>() as u32;
    let mut enabled_type = REG_VALUE_TYPE::default();
    // SAFETY: enabled 缓冲区大小与 enabled_len 一致，注册表句柄有效。
    if unsafe {
        RegQueryValueExW(
            *key,
            PROXY_ENABLE_VALUE,
            None,
            Some(&mut enabled_type),
            Some(&mut enabled as *mut u32 as *mut u8),
            Some(&mut enabled_len),
        )
    }
    .is_err()
        || enabled_type != REG_DWORD
        || enabled == 0
    {
        return None;
    }

    let mut value_len = 0u32;
    let mut value_type = REG_VALUE_TYPE::default();
    // SAFETY: 空数据指针只查询所需长度，注册表句柄有效。
    if unsafe {
        RegQueryValueExW(
            *key,
            PROXY_SERVER_VALUE,
            None,
            Some(&mut value_type),
            None,
            Some(&mut value_len),
        )
    }
    .is_err()
        || value_len == 0
        || !value_len.is_multiple_of(2)
        || !matches!(value_type, REG_SZ | REG_EXPAND_SZ)
    {
        return None;
    }

    let mut bytes = vec![0u8; value_len as usize];
    // SAFETY: bytes 容量精确等于注册表查询得到的值；若值并发变大，API 返回错误。
    if unsafe {
        RegQueryValueExW(
            *key,
            PROXY_SERVER_VALUE,
            None,
            Some(&mut value_type),
            Some(bytes.as_mut_ptr()),
            Some(&mut value_len),
        )
    }
    .is_err()
    {
        return None;
    }
    if value_len as usize > bytes.len() || !value_len.is_multiple_of(2) {
        return None;
    }
    bytes.truncate(value_len as usize);
    let utf16 = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|chunk| u16::from_ne_bytes(*chunk))
        .collect::<Vec<_>>();
    let last_non_null = utf16.iter().rposition(|&value| value != 0)?;
    let raw = String::from_utf16_lossy(&utf16[..=last_non_null]);
    normalize_proxy_server(&raw)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_windows_system_proxy() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::normalize_proxy_server;

    #[test]
    fn normalizes_plain_and_protocol_specific_proxy_values() {
        assert_eq!(
            normalize_proxy_server("127.0.0.1:10808"),
            Some("http://127.0.0.1:10808".to_string())
        );
        assert_eq!(
            normalize_proxy_server("http=127.0.0.1:8080;https=127.0.0.1:10808"),
            Some("http://127.0.0.1:8080".to_string())
        );
    }
}
