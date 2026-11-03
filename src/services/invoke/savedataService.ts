/**
 * @file 存档备份服务
 * @description 封装所有存档备份相关的后端调用
 */

import type { SavedataRecord } from "@/types";
import { BaseService } from "./base";

/** 备份信息 */
export interface BackupInfo {
	folder_name: string;
	backup_time: number;
	file_size: number;
	backup_path: string;
}

export interface SavedataBackupDeleteResult {
	status: "deleted" | "missing_file" | "file_inaccessible";
	message?: string | null;
}

export interface RestoreSavedataResult {
	restored_path: string;
	replaced_existing: boolean;
	restored_to_alternate: boolean;
	cleanup_warning?: string | null;
}

export interface SavedataBackupRootMigrationResult {
	status: "completed" | "saved_with_warning";
	old_path: string;
	new_path: string;
	message: string;
	residue_path?: string | null;
}

class SavedataService extends BaseService {
	/**
	 * 创建存档备份
	 * @param gameId 游戏ID
	 * @param sourcePath 存档文件夹路径
	 */
	async createBackup(gameId: number, sourcePath: string): Promise<BackupInfo> {
		return this.invoke<BackupInfo>("create_savedata_backup", {
			gameId,
			sourcePath,
		});
	}

	/**
	 * 删除备份文件和数据库记录（二合一）
	 * @param backupId 备份记录ID
	 */
	async deleteBackup(backupId: number): Promise<SavedataBackupDeleteResult> {
		return this.invoke<SavedataBackupDeleteResult>("delete_savedata_backup", { backupId });
	}

	/** 仅删除已经确认无用的记录，不会删除任何本地文件。 */
	async deleteBackupRecord(backupId: number): Promise<void> {
		return this.invoke<void>("delete_savedata_backup_record", { backupId });
	}

	/**
	 * 恢复存档备份
	 * @param backupId 备份记录 ID（由后端解析安全文件位置）
	 * @param targetPath 目标恢复路径
	 */
	async restoreBackup(
		backupId: number,
		targetPath: string,
	): Promise<RestoreSavedataResult> {
		return this.invoke<RestoreSavedataResult>("restore_savedata_backup", {
			backupId,
			targetPath,
		});
	}

	async openBackupFolder(gameId: number): Promise<void> {
		return this.invoke<void>("open_savedata_backup_folder", { gameId });
	}

	async changeBackupRoot(
		newPath: string,
	): Promise<SavedataBackupRootMigrationResult> {
		return this.invoke<SavedataBackupRootMigrationResult>(
			"change_savedata_backup_root",
			{ newPath },
		);
	}

	/**
	 * 保存存档备份记录
	 */
	async saveSavedataRecord(
		gameId: number,
		fileName: string,
		backupTime: number,
		fileSize: number,
	): Promise<number> {
		return this.invoke<number>("save_savedata_record", {
			gameId,
			fileName,
			backupTime,
			fileSize,
		});
	}

	/**
	 * 获取指定游戏的备份数量
	 */
	async getSavedataCount(gameId: number): Promise<number> {
		return this.invoke<number>("get_savedata_count", { gameId });
	}

	/**
	 * 获取指定游戏的所有备份记录
	 */
	async getSavedataRecords(gameId: number): Promise<SavedataRecord[]> {
		return this.invoke<SavedataRecord[]>("get_savedata_records", { gameId });
	}
}

// 导出单例
export const savedataService = new SavedataService();
