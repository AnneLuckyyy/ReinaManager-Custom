use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::entity::{custom_data::CustomData, games};
use chrono::Local;
use encoding_rs::GBK;
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection, EntityTrait, Set,
    Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use tauri::{State, command};

const WARNING_SAMPLE_LIMIT: usize = 20;

#[derive(Debug, Clone)]
struct TreeEntry {
    depth: usize,
    name: String,
}

#[derive(Debug, Clone)]
struct ParsedPart {
    directory: String,
    file_name: String,
    base_name: String,
    format: String,
    volume_style: String,
    part_number: Option<u32>,
}

#[derive(Debug, Clone)]
struct ArchivePart {
    file_name: String,
    relative_path: String,
    part_number: Option<u32>,
}

#[derive(Debug, Clone)]
struct ParsedArchive {
    identity_key: String,
    relative_directory: String,
    base_name: String,
    format: String,
    volume_style: String,
    sequence_status: String,
    parts: Vec<ArchivePart>,
}

#[derive(Debug)]
struct ParsedCatalog {
    preview: BackupCatalogPreview,
    archives: Vec<ParsedArchive>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCatalogFormatCounts {
    seven_zip: usize,
    zip: usize,
    rar: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCatalogWarning {
    code: String,
    message: String,
    path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCatalogPreview {
    suggested_source_name: String,
    archive_count: usize,
    recognized_file_count: usize,
    single_archive_count: usize,
    volume_archive_count: usize,
    multi_part_archive_count: usize,
    ignored_entry_count: usize,
    duplicate_name_count: usize,
    warning_count: usize,
    format_counts: BackupCatalogFormatCounts,
    warnings: Vec<BackupCatalogWarning>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCatalogSourceSummary {
    id: i64,
    name: String,
    original_file_path: String,
    imported_at: String,
    archive_count: i64,
    part_count: i64,
    warning_count: i64,
    missing_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCatalogImportResult {
    source: BackupCatalogSourceSummary,
    preview: BackupCatalogPreview,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupArchivePartRecord {
    file_name: String,
    relative_path: String,
    part_number: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupArchiveRecord {
    id: i64,
    source_id: i64,
    source_name: String,
    relative_directory: String,
    base_name: String,
    archive_format: String,
    volume_style: String,
    part_count: i64,
    sequence_status: String,
    is_present: bool,
    last_seen_at: String,
    match_status: Option<String>,
    matched_game_id: Option<i64>,
    match_method: Option<String>,
    match_score: Option<f64>,
    match_confirmed: Option<bool>,
    parts: Vec<BackupArchivePartRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBackupArchiveRecord {
    id: i64,
    source_name: String,
    base_name: String,
    archive_format: String,
    part_count: i64,
    is_present: bool,
    match_confirmed: bool,
    parts: Vec<BackupArchivePartRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBackupCountRecord {
    game_id: i32,
    backup_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMatchNameFill {
    game_id: i32,
    match_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupAutoMatchAssignment {
    archive_id: i64,
    game_id: i32,
    score: Option<f64>,
    confirmed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupAutoMatchResult {
    filled_name_count: usize,
    confirmed_archive_count: usize,
    doubtful_archive_count: usize,
}

fn read_catalog_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec())
            .map_err(|error| format!("UTF-8 文件解析失败: {error}"));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units).map_err(|error| format!("UTF-16 文件解析失败: {error}"));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units).map_err(|error| format!("UTF-16 文件解析失败: {error}"));
    }
    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return Ok(text);
    }

    let (text, _, _) = GBK.decode(bytes);
    Ok(text.into_owned())
}

fn parse_tree_entry(line: &str) -> Option<TreeEntry> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() {
        return None;
    }

    if let Some(position) = line.find("——") {
        let name = line[position + "——".len()..].trim();
        return (!name.is_empty()).then(|| TreeEntry {
            depth: 0,
            name: name.to_string(),
        });
    }

    if let Some(position) = line.rfind("|-") {
        let name = line[position + 2..].trim();
        let depth = line[..position].matches("| ").count();
        return (!name.is_empty()).then(|| TreeEntry {
            depth,
            name: name.to_string(),
        });
    }

    for marker in ["├─", "└─", "├──", "└──"] {
        if let Some(position) = line.rfind(marker) {
            let name = line[position + marker.len()..].trim();
            let prefix = &line[..position];
            let depth = prefix.matches('│').count() + prefix.matches("  ").count() + 1;
            return (!name.is_empty()).then(|| TreeEntry {
                depth,
                name: name.to_string(),
            });
        }
    }

    None
}

fn numeric_suffix(value: &str, marker: &str) -> Option<(String, u32)> {
    let lower = value.to_ascii_lowercase();
    let position = lower.rfind(marker)?;
    let number = &lower[position + marker.len()..];
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((value[..position].to_string(), number.parse().ok()?))
}

fn parse_archive_part(directory: String, file_name: String) -> Option<ParsedPart> {
    let lower = file_name.to_ascii_lowercase();

    for format in ["7z", "zip", "rar"] {
        let marker = format!(".{format}.");
        if let Some((base_name, part_number)) = numeric_suffix(&file_name, &marker) {
            return Some(ParsedPart {
                directory,
                file_name,
                base_name,
                format: format.to_string(),
                volume_style: "numbered".to_string(),
                part_number: Some(part_number),
            });
        }
    }

    if lower.ends_with(".rar") {
        let stem = &file_name[..file_name.len() - 4];
        if let Some((base_name, part_number)) = numeric_suffix(stem, ".part") {
            return Some(ParsedPart {
                directory,
                file_name,
                base_name,
                format: "rar".to_string(),
                volume_style: "rar_part".to_string(),
                part_number: Some(part_number),
            });
        }
    }

    if let Some((base_name, extension)) = file_name.rsplit_once('.') {
        let extension = extension.to_ascii_lowercase();
        let digits = extension.get(1..).unwrap_or_default();
        if extension.starts_with('z')
            && extension.len() == 3
            && digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Some(ParsedPart {
                directory,
                file_name: file_name.clone(),
                base_name: base_name.to_string(),
                format: "zip".to_string(),
                volume_style: "zip_legacy".to_string(),
                part_number: digits.parse().ok(),
            });
        }
        if extension.starts_with('r')
            && extension.len() == 3
            && digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Some(ParsedPart {
                directory,
                file_name: file_name.clone(),
                base_name: base_name.to_string(),
                format: "rar".to_string(),
                volume_style: "rar_legacy".to_string(),
                part_number: digits.parse::<u32>().ok().map(|number| number + 2),
            });
        }
    }

    for format in ["7z", "zip", "rar"] {
        let suffix = format!(".{format}");
        if lower.ends_with(&suffix) {
            return Some(ParsedPart {
                directory,
                file_name: file_name.clone(),
                base_name: file_name[..file_name.len() - suffix.len()].to_string(),
                format: format.to_string(),
                volume_style: "single".to_string(),
                part_number: None,
            });
        }
    }

    None
}

fn join_remote_path(directory: &str, file_name: &str) -> String {
    if directory.is_empty() {
        file_name.to_string()
    } else {
        format!("{directory}/{file_name}")
    }
}

fn sequence_status(style: &str, parts: &[ArchivePart]) -> String {
    if style == "single" {
        return "complete".to_string();
    }

    let numbers = parts
        .iter()
        .filter_map(|part| part.part_number)
        .collect::<Vec<_>>();
    let starts_at_one = numbers.first().copied() == Some(1);
    let continuous = numbers.windows(2).all(|window| window[1] == window[0] + 1);

    if style == "zip_legacy" {
        let has_terminal_zip = parts
            .iter()
            .any(|part| part.file_name.to_ascii_lowercase().ends_with(".zip"));
        return if !starts_at_one {
            "missing_first".to_string()
        } else if !continuous {
            "gap".to_string()
        } else if !has_terminal_zip {
            "missing_terminal".to_string()
        } else {
            "complete".to_string()
        };
    }

    if !starts_at_one {
        "missing_first".to_string()
    } else if !continuous {
        "gap".to_string()
    } else {
        "continuous".to_string()
    }
}

fn parse_catalog(file_path: &Path, text: &str) -> Result<ParsedCatalog, String> {
    let entries = text
        .lines()
        .filter_map(parse_tree_entry)
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Err("目录树中没有可识别的层级内容".to_string());
    }

    let mut directory_stack = Vec::<String>::new();
    let mut parsed_parts = Vec::<ParsedPart>::new();
    let mut ignored_entry_count = 0usize;

    for (index, entry) in entries.iter().enumerate() {
        directory_stack.truncate(entry.depth);
        let next_is_deeper = entries
            .get(index + 1)
            .is_some_and(|next| next.depth > entry.depth);

        let directory = directory_stack
            .iter()
            .skip(1)
            .cloned()
            .collect::<Vec<_>>()
            .join("/");
        if let Some(part) = parse_archive_part(directory, entry.name.clone()) {
            parsed_parts.push(part);
        } else if next_is_deeper || entry.depth == 0 {
            directory_stack.push(entry.name.clone());
        } else {
            ignored_entry_count += 1;
        }
    }

    if parsed_parts.is_empty() {
        return Err("目录树中没有找到 7z、ZIP 或 RAR 压缩包".to_string());
    }

    let legacy_keys = parsed_parts
        .iter()
        .filter(|part| matches!(part.volume_style.as_str(), "zip_legacy" | "rar_legacy"))
        .map(|part| {
            format!(
                "{}\u{0}{}\u{0}{}",
                part.directory, part.base_name, part.format
            )
        })
        .collect::<HashSet<_>>();

    for part in &mut parsed_parts {
        if part.volume_style != "single" {
            continue;
        }
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            part.directory, part.base_name, part.format
        );
        if legacy_keys.contains(&key) {
            match part.format.as_str() {
                "zip" => part.volume_style = "zip_legacy".to_string(),
                "rar" => {
                    part.volume_style = "rar_legacy".to_string();
                    part.part_number = Some(1);
                }
                _ => {}
            }
        }
    }

    let mut groups = BTreeMap::<String, Vec<ParsedPart>>::new();
    for part in parsed_parts {
        let identity_key = format!(
            "{}\u{0}{}\u{0}{}\u{0}{}",
            part.directory, part.base_name, part.format, part.volume_style
        );
        groups.entry(identity_key).or_default().push(part);
    }

    let mut archives = Vec::with_capacity(groups.len());
    let mut warnings = Vec::new();
    let mut total_warning_count = 0usize;
    let mut format_counts = BackupCatalogFormatCounts {
        seven_zip: 0,
        zip: 0,
        rar: 0,
    };
    let mut single_archive_count = 0usize;
    let mut volume_archive_count = 0usize;
    let mut multi_part_archive_count = 0usize;

    for (identity_key, mut group_parts) in groups {
        group_parts.sort_by(|left, right| {
            left.part_number
                .unwrap_or(u32::MAX)
                .cmp(&right.part_number.unwrap_or(u32::MAX))
                .then_with(|| left.file_name.cmp(&right.file_name))
        });
        group_parts.dedup_by(|left, right| left.file_name == right.file_name);

        let first = group_parts
            .first()
            .expect("archive group must contain a part");
        let parts = group_parts
            .iter()
            .map(|part| ArchivePart {
                file_name: part.file_name.clone(),
                relative_path: join_remote_path(&part.directory, &part.file_name),
                part_number: part.part_number,
            })
            .collect::<Vec<_>>();
        let status = sequence_status(&first.volume_style, &parts);
        if !matches!(status.as_str(), "complete" | "continuous") {
            total_warning_count += 1;
            if warnings.len() < WARNING_SAMPLE_LIMIT {
                warnings.push(BackupCatalogWarning {
                    code: "volume_sequence".to_string(),
                    message: format!("分卷序号状态异常：{status}"),
                    path: parts.first().map(|part| part.relative_path.clone()),
                });
            }
        }

        match first.format.as_str() {
            "7z" => format_counts.seven_zip += 1,
            "zip" => format_counts.zip += 1,
            "rar" => format_counts.rar += 1,
            _ => {}
        }
        if first.volume_style == "single" {
            single_archive_count += 1;
        } else {
            volume_archive_count += 1;
        }
        if parts.len() > 1 {
            multi_part_archive_count += 1;
        }

        archives.push(ParsedArchive {
            identity_key,
            relative_directory: first.directory.clone(),
            base_name: first.base_name.clone(),
            format: first.format.clone(),
            volume_style: first.volume_style.clone(),
            sequence_status: status,
            parts,
        });
    }

    let mut name_directories = HashMap::<String, HashSet<String>>::new();
    for archive in &archives {
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            archive.base_name, archive.format, archive.volume_style
        );
        name_directories
            .entry(key)
            .or_default()
            .insert(archive.relative_directory.clone());
    }
    let duplicate_name_count = name_directories
        .values()
        .map(|directories| directories.len().saturating_sub(1))
        .sum::<usize>();
    if duplicate_name_count > 0 {
        total_warning_count += duplicate_name_count;
        if warnings.len() < WARNING_SAMPLE_LIMIT {
            warnings.push(BackupCatalogWarning {
                code: "same_name_different_directory".to_string(),
                message: format!("发现 {duplicate_name_count} 个同名但目录不同的备份，已分别保留"),
                path: None,
            });
        }
    }

    let recognized_file_count = archives.iter().map(|archive| archive.parts.len()).sum();
    let suggested_source_name = file_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("115 游戏备份")
        .to_string();

    Ok(ParsedCatalog {
        preview: BackupCatalogPreview {
            suggested_source_name,
            archive_count: archives.len(),
            recognized_file_count,
            single_archive_count,
            volume_archive_count,
            multi_part_archive_count,
            ignored_entry_count,
            duplicate_name_count,
            warning_count: total_warning_count,
            format_counts,
            warnings,
        },
        archives,
    })
}

async fn parse_catalog_file(file_path: &str) -> Result<ParsedCatalog, String> {
    let path = PathBuf::from(file_path);
    if !path.is_file() {
        return Err("所选目录树文件不存在或无法访问".to_string());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("读取目录树失败: {error}"))?;
    let text = read_catalog_text(&bytes)?;
    parse_catalog(&path, &text)
}

#[command]
pub async fn preview_backup_catalog(file_path: String) -> Result<BackupCatalogPreview, String> {
    Ok(parse_catalog_file(&file_path).await?.preview)
}

async fn get_source_summary(
    db: &impl ConnectionTrait,
    source_id: i64,
) -> Result<BackupCatalogSourceSummary, String> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            r#"
            SELECT s.id, s.name, s.original_file_path, s.imported_at,
                   s.archive_count, s.part_count, s.warning_count,
                   COALESCE(SUM(CASE WHEN a.is_present = 0 THEN 1 ELSE 0 END), 0) AS missing_count
            FROM backup_catalog_sources s
            LEFT JOIN backup_archives a ON a.source_id = s.id
            WHERE s.id = ?
            GROUP BY s.id
            "#,
            [source_id.into()],
        ))
        .await
        .map_err(|error| format!("读取目录来源失败: {error}"))?
        .ok_or_else(|| "目录来源不存在".to_string())?;

    Ok(BackupCatalogSourceSummary {
        id: row.try_get("", "id").map_err(|error| error.to_string())?,
        name: row.try_get("", "name").map_err(|error| error.to_string())?,
        original_file_path: row
            .try_get("", "original_file_path")
            .map_err(|error| error.to_string())?,
        imported_at: row
            .try_get("", "imported_at")
            .map_err(|error| error.to_string())?,
        archive_count: row
            .try_get("", "archive_count")
            .map_err(|error| error.to_string())?,
        part_count: row
            .try_get("", "part_count")
            .map_err(|error| error.to_string())?,
        warning_count: row
            .try_get("", "warning_count")
            .map_err(|error| error.to_string())?,
        missing_count: row
            .try_get("", "missing_count")
            .map_err(|error| error.to_string())?,
    })
}

#[command]
pub async fn list_backup_catalog_sources(
    db: State<'_, DatabaseConnection>,
) -> Result<Vec<BackupCatalogSourceSummary>, String> {
    let rows = db
        .query_all(Statement::from_string(
            DatabaseBackend::Sqlite,
            r#"
            SELECT s.id, s.name, s.original_file_path, s.imported_at,
                   s.archive_count, s.part_count, s.warning_count,
                   COALESCE(SUM(CASE WHEN a.is_present = 0 THEN 1 ELSE 0 END), 0) AS missing_count
            FROM backup_catalog_sources s
            LEFT JOIN backup_archives a ON a.source_id = s.id
            GROUP BY s.id
            ORDER BY s.imported_at DESC, s.id DESC
            "#
            .to_string(),
        ))
        .await
        .map_err(|error| format!("读取目录来源失败: {error}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(BackupCatalogSourceSummary {
                id: row.try_get("", "id").map_err(|error| error.to_string())?,
                name: row.try_get("", "name").map_err(|error| error.to_string())?,
                original_file_path: row
                    .try_get("", "original_file_path")
                    .map_err(|error| error.to_string())?,
                imported_at: row
                    .try_get("", "imported_at")
                    .map_err(|error| error.to_string())?,
                archive_count: row
                    .try_get("", "archive_count")
                    .map_err(|error| error.to_string())?,
                part_count: row
                    .try_get("", "part_count")
                    .map_err(|error| error.to_string())?,
                warning_count: row
                    .try_get("", "warning_count")
                    .map_err(|error| error.to_string())?,
                missing_count: row
                    .try_get("", "missing_count")
                    .map_err(|error| error.to_string())?,
            })
        })
        .collect()
}

#[command]
pub async fn import_backup_catalog(
    file_path: String,
    source_name: String,
    source_id: Option<i64>,
    db: State<'_, DatabaseConnection>,
) -> Result<BackupCatalogImportResult, String> {
    let source_name = source_name.trim();
    if source_name.is_empty() {
        return Err("目录来源名称不能为空".to_string());
    }

    let parsed = parse_catalog_file(&file_path).await?;
    let imported_at = Local::now().to_rfc3339();
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("开始导入事务失败: {error}"))?;

    let source_id = if let Some(source_id) = source_id {
        let result = transaction
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                r#"
                UPDATE backup_catalog_sources
                SET name = ?, original_file_path = ?, imported_at = ?,
                    archive_count = ?, part_count = ?, warning_count = ?
                WHERE id = ?
                "#,
                [
                    source_name.into(),
                    file_path.clone().into(),
                    imported_at.clone().into(),
                    (parsed.preview.archive_count as i64).into(),
                    (parsed.preview.recognized_file_count as i64).into(),
                    (parsed.preview.warning_count as i64).into(),
                    source_id.into(),
                ],
            ))
            .await
            .map_err(|error| format!("更新目录来源失败: {error}"))?;
        if result.rows_affected() == 0 {
            return Err("要更新的目录来源不存在".to_string());
        }
        source_id
    } else {
        transaction
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                r#"
                INSERT INTO backup_catalog_sources
                    (name, original_file_path, imported_at, archive_count, part_count, warning_count)
                VALUES (?, ?, ?, ?, ?, ?)
                "#,
                [
                    source_name.into(),
                    file_path.clone().into(),
                    imported_at.clone().into(),
                    (parsed.preview.archive_count as i64).into(),
                    (parsed.preview.recognized_file_count as i64).into(),
                    (parsed.preview.warning_count as i64).into(),
                ],
            ))
            .await
            .map_err(|error| format!("创建目录来源失败: {error}"))?
            .last_insert_id() as i64
    };

    transaction
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "UPDATE backup_archives SET is_present = 0 WHERE source_id = ?",
            [source_id.into()],
        ))
        .await
        .map_err(|error| format!("准备更新索引失败: {error}"))?;

    for archive in &parsed.archives {
        transaction
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                r#"
                INSERT INTO backup_archives
                    (source_id, identity_key, relative_directory, base_name, archive_format,
                     volume_style, part_count, sequence_status, is_present, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(source_id, identity_key) DO UPDATE SET
                    relative_directory = excluded.relative_directory,
                    base_name = excluded.base_name,
                    archive_format = excluded.archive_format,
                    volume_style = excluded.volume_style,
                    part_count = excluded.part_count,
                    sequence_status = excluded.sequence_status,
                    is_present = 1,
                    last_seen_at = excluded.last_seen_at
                "#,
                [
                    source_id.into(),
                    archive.identity_key.clone().into(),
                    archive.relative_directory.clone().into(),
                    archive.base_name.clone().into(),
                    archive.format.clone().into(),
                    archive.volume_style.clone().into(),
                    (archive.parts.len() as i64).into(),
                    archive.sequence_status.clone().into(),
                    imported_at.clone().into(),
                ],
            ))
            .await
            .map_err(|error| format!("写入压缩包索引失败: {error}"))?;

        let archive_row = transaction
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "SELECT id FROM backup_archives WHERE source_id = ? AND identity_key = ?",
                [source_id.into(), archive.identity_key.clone().into()],
            ))
            .await
            .map_err(|error| format!("读取压缩包索引失败: {error}"))?
            .ok_or_else(|| "写入后的压缩包索引不存在".to_string())?;
        let archive_id: i64 = archive_row
            .try_get("", "id")
            .map_err(|error| error.to_string())?;

        transaction
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "DELETE FROM backup_archive_parts WHERE archive_id = ?",
                [archive_id.into()],
            ))
            .await
            .map_err(|error| format!("更新分卷索引失败: {error}"))?;

        for part in &archive.parts {
            transaction
                .execute(Statement::from_sql_and_values(
                    DatabaseBackend::Sqlite,
                    r#"
                    INSERT INTO backup_archive_parts
                        (archive_id, file_name, relative_path, part_number)
                    VALUES (?, ?, ?, ?)
                    "#,
                    [
                        archive_id.into(),
                        part.file_name.clone().into(),
                        part.relative_path.clone().into(),
                        part.part_number.map(i64::from).into(),
                    ],
                ))
                .await
                .map_err(|error| format!("写入分卷索引失败: {error}"))?;
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| format!("提交目录树导入失败: {error}"))?;
    let source = get_source_summary(db.inner(), source_id).await?;

    Ok(BackupCatalogImportResult {
        source,
        preview: parsed.preview,
    })
}

#[command]
pub async fn list_backup_archives(
    db: State<'_, DatabaseConnection>,
) -> Result<Vec<BackupArchiveRecord>, String> {
    let part_rows = db
        .query_all(Statement::from_string(
            DatabaseBackend::Sqlite,
            r#"
            SELECT archive_id, file_name, relative_path, part_number
            FROM backup_archive_parts
            ORDER BY archive_id, COALESCE(part_number, 2147483647), file_name
            "#
            .to_string(),
        ))
        .await
        .map_err(|error| format!("读取压缩包分卷失败: {error}"))?;
    let mut parts_by_archive = HashMap::<i64, Vec<BackupArchivePartRecord>>::new();
    for row in part_rows {
        let archive_id: i64 = row
            .try_get("", "archive_id")
            .map_err(|error| error.to_string())?;
        parts_by_archive
            .entry(archive_id)
            .or_default()
            .push(BackupArchivePartRecord {
                file_name: row
                    .try_get("", "file_name")
                    .map_err(|error| error.to_string())?,
                relative_path: row
                    .try_get("", "relative_path")
                    .map_err(|error| error.to_string())?,
                part_number: row
                    .try_get("", "part_number")
                    .map_err(|error| error.to_string())?,
            });
    }

    let rows = db
        .query_all(Statement::from_string(
            DatabaseBackend::Sqlite,
            r#"
            SELECT a.id, a.source_id, s.name AS source_name,
                   a.relative_directory, a.base_name, a.archive_format,
                   a.volume_style, a.part_count, a.sequence_status,
                   a.is_present, a.last_seen_at,
                   m.status AS match_status, m.game_id AS matched_game_id,
                   m.match_method, m.match_score, m.review_confirmed
            FROM backup_archives a
            JOIN backup_catalog_sources s ON s.id = a.source_id
            LEFT JOIN backup_archive_matches m ON m.archive_id = a.id
            ORDER BY a.is_present DESC, a.base_name COLLATE NOCASE, a.id
            "#
            .to_string(),
        ))
        .await
        .map_err(|error| format!("读取压缩包索引失败: {error}"))?;

    rows.into_iter()
        .map(|row| {
            let id: i64 = row.try_get("", "id").map_err(|error| error.to_string())?;
            let is_present: i64 = row
                .try_get("", "is_present")
                .map_err(|error| error.to_string())?;
            Ok(BackupArchiveRecord {
                id,
                source_id: row
                    .try_get("", "source_id")
                    .map_err(|error| error.to_string())?,
                source_name: row
                    .try_get("", "source_name")
                    .map_err(|error| error.to_string())?,
                relative_directory: row
                    .try_get("", "relative_directory")
                    .map_err(|error| error.to_string())?,
                base_name: row
                    .try_get("", "base_name")
                    .map_err(|error| error.to_string())?,
                archive_format: row
                    .try_get("", "archive_format")
                    .map_err(|error| error.to_string())?,
                volume_style: row
                    .try_get("", "volume_style")
                    .map_err(|error| error.to_string())?,
                part_count: row
                    .try_get("", "part_count")
                    .map_err(|error| error.to_string())?,
                sequence_status: row
                    .try_get("", "sequence_status")
                    .map_err(|error| error.to_string())?,
                is_present: is_present != 0,
                last_seen_at: row
                    .try_get("", "last_seen_at")
                    .map_err(|error| error.to_string())?,
                match_status: row
                    .try_get("", "match_status")
                    .map_err(|error| error.to_string())?,
                matched_game_id: row
                    .try_get("", "matched_game_id")
                    .map_err(|error| error.to_string())?,
                match_method: row
                    .try_get("", "match_method")
                    .map_err(|error| error.to_string())?,
                match_score: row
                    .try_get("", "match_score")
                    .map_err(|error| error.to_string())?,
                match_confirmed: row
                    .try_get::<Option<i64>>("", "review_confirmed")
                    .map_err(|error| error.to_string())?
                    .map(|value| value != 0),
                parts: parts_by_archive.remove(&id).unwrap_or_default(),
            })
        })
        .collect()
}

#[command]
pub async fn list_game_backup_archives(
    game_id: i32,
    db: State<'_, DatabaseConnection>,
) -> Result<Vec<GameBackupArchiveRecord>, String> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            r#"
            SELECT a.id, s.name AS source_name, a.base_name, a.archive_format,
                   a.part_count, a.is_present, m.review_confirmed,
                   p.file_name, p.relative_path, p.part_number
            FROM backup_archive_matches m
            JOIN backup_archives a ON a.id = m.archive_id
            JOIN backup_catalog_sources s ON s.id = a.source_id
            LEFT JOIN backup_archive_parts p ON p.archive_id = a.id
            WHERE m.status = 'matched' AND m.game_id = ?
            ORDER BY a.is_present DESC, a.base_name COLLATE NOCASE,
                     COALESCE(p.part_number, 2147483647), p.file_name
            "#,
            [game_id.into()],
        ))
        .await
        .map_err(|error| format!("读取游戏关联备份失败: {error}"))?;

    let mut records = Vec::<GameBackupArchiveRecord>::new();
    let mut record_indexes = HashMap::<i64, usize>::new();
    for row in rows {
        let archive_id: i64 = row.try_get("", "id").map_err(|error| error.to_string())?;
        let record_index = if let Some(index) = record_indexes.get(&archive_id) {
            *index
        } else {
            let is_present: i64 = row
                .try_get("", "is_present")
                .map_err(|error| error.to_string())?;
            let review_confirmed: i64 = row
                .try_get("", "review_confirmed")
                .map_err(|error| error.to_string())?;
            records.push(GameBackupArchiveRecord {
                id: archive_id,
                source_name: row
                    .try_get("", "source_name")
                    .map_err(|error| error.to_string())?,
                base_name: row
                    .try_get("", "base_name")
                    .map_err(|error| error.to_string())?,
                archive_format: row
                    .try_get("", "archive_format")
                    .map_err(|error| error.to_string())?,
                part_count: row
                    .try_get("", "part_count")
                    .map_err(|error| error.to_string())?,
                is_present: is_present != 0,
                match_confirmed: review_confirmed != 0,
                parts: Vec::new(),
            });
            let index = records.len() - 1;
            record_indexes.insert(archive_id, index);
            index
        };

        let file_name: Option<String> = row
            .try_get("", "file_name")
            .map_err(|error| error.to_string())?;
        let relative_path: Option<String> = row
            .try_get("", "relative_path")
            .map_err(|error| error.to_string())?;
        if let (Some(file_name), Some(relative_path)) = (file_name, relative_path) {
            records[record_index].parts.push(BackupArchivePartRecord {
                file_name,
                relative_path,
                part_number: row
                    .try_get("", "part_number")
                    .map_err(|error| error.to_string())?,
            });
        }
    }

    Ok(records)
}

#[command]
pub async fn list_game_backup_counts(
    db: State<'_, DatabaseConnection>,
) -> Result<Vec<GameBackupCountRecord>, String> {
    let rows = db
        .query_all(Statement::from_string(
            DatabaseBackend::Sqlite,
            r#"
            SELECT m.game_id, COUNT(*) AS backup_count
            FROM backup_archive_matches m
            JOIN backup_archives a ON a.id = m.archive_id
            WHERE m.status = 'matched' AND m.game_id IS NOT NULL
              AND a.is_present = 1
            GROUP BY m.game_id
            "#
            .to_string(),
        ))
        .await
        .map_err(|error| format!("读取游戏网盘备份数量失败: {error}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(GameBackupCountRecord {
                game_id: row
                    .try_get("", "game_id")
                    .map_err(|error| error.to_string())?,
                backup_count: row
                    .try_get("", "backup_count")
                    .map_err(|error| error.to_string())?,
            })
        })
        .collect()
}

#[command]
pub async fn set_backup_archive_match(
    archive_id: i64,
    game_id: Option<i32>,
    status: Option<String>,
    db: State<'_, DatabaseConnection>,
) -> Result<(), String> {
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("开始保存关联失败: {error}"))?;
    let archive_exists = transaction
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "SELECT id FROM backup_archives WHERE id = ?",
            [archive_id.into()],
        ))
        .await
        .map_err(|error| format!("检查压缩包失败: {error}"))?
        .is_some();
    if !archive_exists {
        return Err("压缩包记录不存在".to_string());
    }

    let Some(status) = status else {
        transaction
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "DELETE FROM backup_archive_matches WHERE archive_id = ?",
                [archive_id.into()],
            ))
            .await
            .map_err(|error| format!("清除关联失败: {error}"))?;
        transaction
            .commit()
            .await
            .map_err(|error| format!("提交关联变更失败: {error}"))?;
        return Ok(());
    };

    let stored_game_id = match status.as_str() {
        "matched" => {
            let game_id = game_id.ok_or_else(|| "关联游戏不能为空".to_string())?;
            if games::Entity::find_by_id(game_id)
                .one(&transaction)
                .await
                .map_err(|error| format!("检查游戏失败: {error}"))?
                .is_none()
            {
                return Err("所选游戏不存在".to_string());
            }
            Some(game_id)
        }
        "no_game" => None,
        _ => return Err("无效的关联状态".to_string()),
    };

    transaction
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            r#"
            INSERT INTO backup_archive_matches
                (archive_id, game_id, status, match_method, match_score, updated_at,
                 review_confirmed)
            VALUES (?, ?, ?, 'manual', NULL, ?, 1)
            ON CONFLICT(archive_id) DO UPDATE SET
                game_id = excluded.game_id,
                status = excluded.status,
                match_method = 'manual',
                match_score = NULL,
                updated_at = excluded.updated_at,
                review_confirmed = 1
            "#,
            [
                archive_id.into(),
                stored_game_id.into(),
                status.into(),
                Local::now().to_rfc3339().into(),
            ],
        ))
        .await
        .map_err(|error| format!("保存压缩包关联失败: {error}"))?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("提交关联变更失败: {error}"))?;
    Ok(())
}

#[command]
pub async fn apply_backup_auto_matches(
    name_fills: Vec<BackupMatchNameFill>,
    matches: Vec<BackupAutoMatchAssignment>,
    db: State<'_, DatabaseConnection>,
) -> Result<BackupAutoMatchResult, String> {
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("开始自动匹配事务失败: {error}"))?;
    let mut filled_name_count = 0usize;
    let now_timestamp = chrono::Utc::now().timestamp() as i32;

    for fill in name_fills {
        let match_name = fill.match_name.trim();
        if match_name.is_empty() {
            continue;
        }
        let Some(game) = games::Entity::find_by_id(fill.game_id)
            .one(&transaction)
            .await
            .map_err(|error| format!("读取待补齐游戏失败: {error}"))?
        else {
            continue;
        };
        let mut custom_data = game.custom_data.unwrap_or_else(CustomData::default);
        if custom_data.backup_match_name_manual == Some(true)
            || custom_data
                .backup_match_name
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            continue;
        }
        custom_data.backup_match_name = Some(match_name.to_string());
        games::ActiveModel {
            id: Set(fill.game_id),
            custom_data: Set(Some(custom_data)),
            updated_at: Set(Some(now_timestamp)),
            ..Default::default()
        }
        .update(&transaction)
        .await
        .map_err(|error| format!("补齐游戏匹配名失败: {error}"))?;
        filled_name_count += 1;
    }

    let mut confirmed_archive_count = 0usize;
    let mut doubtful_archive_count = 0usize;
    let mut seen_archives = HashSet::new();
    for assignment in matches {
        if !seen_archives.insert(assignment.archive_id) {
            continue;
        }
        if games::Entity::find_by_id(assignment.game_id)
            .one(&transaction)
            .await
            .map_err(|error| format!("检查自动匹配游戏失败: {error}"))?
            .is_none()
        {
            continue;
        }
        let result = transaction
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                r#"
                INSERT OR IGNORE INTO backup_archive_matches
                    (archive_id, game_id, status, match_method, match_score, updated_at,
                     review_confirmed)
                SELECT id, ?, 'matched', ?, ?, ?, ?
                FROM backup_archives
                WHERE id = ? AND is_present = 1
                "#,
                [
                    assignment.game_id.into(),
                    (if assignment.confirmed {
                        "auto_exact"
                    } else {
                        "auto_fuzzy"
                    })
                    .into(),
                    assignment.score.into(),
                    Local::now().to_rfc3339().into(),
                    i32::from(assignment.confirmed).into(),
                    assignment.archive_id.into(),
                ],
            ))
            .await
            .map_err(|error| format!("保存自动匹配结果失败: {error}"))?;
        if assignment.confirmed {
            confirmed_archive_count += result.rows_affected() as usize;
        } else {
            doubtful_archive_count += result.rows_affected() as usize;
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| format!("提交自动匹配失败: {error}"))?;
    Ok(BackupAutoMatchResult {
        filled_name_count,
        confirmed_archive_count,
        doubtful_archive_count,
    })
}

#[command]
pub async fn delete_backup_catalog_source(
    source_id: i64,
    db: State<'_, DatabaseConnection>,
) -> Result<(), String> {
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("开始删除事务失败: {error}"))?;
    transaction
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "DELETE FROM backup_archive_matches WHERE archive_id IN (SELECT id FROM backup_archives WHERE source_id = ?)",
            [source_id.into()],
        ))
        .await
        .map_err(|error| format!("删除压缩包关联失败: {error}"))?;
    transaction
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "DELETE FROM backup_archive_parts WHERE archive_id IN (SELECT id FROM backup_archives WHERE source_id = ?)",
            [source_id.into()],
        ))
        .await
        .map_err(|error| format!("删除分卷索引失败: {error}"))?;
    transaction
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "DELETE FROM backup_archives WHERE source_id = ?",
            [source_id.into()],
        ))
        .await
        .map_err(|error| format!("删除压缩包索引失败: {error}"))?;
    let result = transaction
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "DELETE FROM backup_catalog_sources WHERE id = ?",
            [source_id.into()],
        ))
        .await
        .map_err(|error| format!("删除目录来源失败: {error}"))?;
    if result.rows_affected() == 0 {
        return Err("目录来源不存在".to_string());
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("提交删除失败: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sample_tree_and_groups_numbered_volumes() {
        let text =
            "|——根目录\n| |-Games\n| | |-A.7z.002\n| | |-A.7z.001\n| | |-B.zip\n| | |-ignore.exe\n";
        let parsed = parse_catalog(Path::new("目录树.txt"), text).unwrap();
        assert_eq!(parsed.preview.archive_count, 2);
        assert_eq!(parsed.preview.recognized_file_count, 3);
        assert_eq!(parsed.preview.multi_part_archive_count, 1);
        assert_eq!(parsed.preview.ignored_entry_count, 1);
        assert_eq!(parsed.archives[0].relative_directory, "Games");
    }

    #[test]
    fn keeps_same_name_in_different_directories_separate() {
        let text = "|——根目录\n| |-A\n| | |-Game.rar\n| |-B\n| | |-Game.rar\n";
        let parsed = parse_catalog(Path::new("目录树.txt"), text).unwrap();
        assert_eq!(parsed.preview.archive_count, 2);
        assert_eq!(parsed.preview.duplicate_name_count, 1);
    }

    #[test]
    fn reports_missing_first_volume() {
        let text = "|——根目录\n| |-Games\n| | |-A.7z.002\n";
        let parsed = parse_catalog(Path::new("目录树.txt"), text).unwrap();
        assert_eq!(parsed.archives[0].sequence_status, "missing_first");
        assert_eq!(parsed.preview.warning_count, 1);
    }
}
