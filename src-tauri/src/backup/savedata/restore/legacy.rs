use super::common::{
    RestorePlan, RestoreSavedataResult, commit_restored_payload, create_restore_temp_dir,
    ensure_safe_existing_ancestors, ensure_safe_existing_object, extract_archive,
    validate_extracted_tree,
};
use super::service::remove_staging;
use crate::backup::savedata::archive::{SaveEntryKind, inspect_legacy_archive};
use sevenz_rust2::ArchiveReader;
use std::fs;
use std::io::{Read, Seek};
use std::path::Path;

pub(super) fn restore<R: Read + Seek>(
    reader: &mut ArchiveReader<R>,
    target_path: &Path,
) -> Result<RestoreSavedataResult, String> {
    let _info =
        inspect_legacy_archive(reader).map_err(|error| format!("旧版备份预检失败: {error}"))?;
    let target_kind = match fs::symlink_metadata(target_path) {
        Ok(_) => Some(ensure_safe_existing_object(target_path)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取当前存档路径失败: {error}")),
    };
    if target_kind.is_some_and(|kind| kind != SaveEntryKind::Directory) {
        return Err("旧版备份一定是目录备份，当前存档路径不是目录，拒绝恢复".to_string());
    }
    let parent = target_path.parent().ok_or("恢复目标没有父目录")?;
    ensure_safe_existing_ancestors(parent)?;
    fs::create_dir_all(parent).map_err(|error| format!("创建恢复目录失败: {error}"))?;
    ensure_safe_existing_ancestors(parent)?;
    let staging = create_restore_temp_dir(parent)?;
    if let Err(error) = extract_archive(reader, &staging) {
        remove_staging(&staging);
        return Err(format!("解压旧版备份失败: {error}"));
    }
    if let Err(error) = validate_extracted_tree(&staging) {
        remove_staging(&staging);
        return Err(format!("旧版备份解压内容校验失败: {error}"));
    }
    let plan = RestorePlan {
        final_path: target_path.to_path_buf(),
        replace_existing: target_kind.is_some(),
        restored_to_alternate: false,
    };
    let committed = commit_restored_payload(&staging, &plan, SaveEntryKind::Directory);
    if committed.is_err() {
        remove_staging(&staging);
    }
    let cleanup_warning = committed?;
    Ok(RestoreSavedataResult {
        restored_path: target_path.to_string_lossy().into_owned(),
        replaced_existing: plan.replace_existing,
        restored_to_alternate: false,
        cleanup_warning,
    })
}

#[cfg(test)]
mod tests {
    use super::super::service::restore_for_test;
    use crate::backup::archive::create_7z_archive;
    use std::fs;

    #[test]
    fn restores_legacy_directory_backup_without_touching_target_before_validation() {
        let root = std::env::temp_dir().join(format!(
            "reina_savedata_legacy_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let source = root.join("source");
        let target = root.join("game/SaveData");
        let archive = root.join("savedata_1_legacy.7z");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("slot"), b"legacy").unwrap();
        create_7z_archive(&source, &archive).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old"), b"old").unwrap();

        let result = restore_for_test(&archive, &target).unwrap();
        assert!(result.replaced_existing);
        assert_eq!(fs::read(target.join("slot")).unwrap(), b"legacy");
        assert!(!target.join("old").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
