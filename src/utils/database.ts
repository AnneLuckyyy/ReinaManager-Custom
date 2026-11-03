import { open } from "@tauri-apps/plugin-dialog";
import {
	type AutoBackupResult,
	type AutoBackupTrigger,
	type BackupResult,
	type CustomCoverRestoreResult,
	fileService,
	type ImportResult,
} from "@/services/invoke";
import {
	createPersistentSettingsSnapshot,
	restorePersistentSettingsSnapshot,
} from "@/utils/persistentSettingsSnapshot";

let databaseBackupPromise: Promise<BackupResult> | null = null;
let autoDatabaseBackupPromise: Promise<AutoBackupResult> | null = null;
let coverBackupPromise: Promise<BackupResult> | null = null;
let customCoverRestorePromise: Promise<CustomCoverRestoreResult> | null = null;
let databaseImportInProgress = false;

export function isDatabaseImportInProgress(): boolean {
	return databaseImportInProgress;
}

export function isDatabaseOperationInProgress(): boolean {
	return (
		databaseImportInProgress ||
		databaseBackupPromise !== null ||
		autoDatabaseBackupPromise !== null ||
		coverBackupPromise !== null ||
		customCoverRestorePromise !== null
	);
}

/**
 * 使用 VACUUM INTO 进行数据库热备份
 *
 * 此方法使用 SQLite 的 VACUUM INTO 语句，可以在数据库正在使用时安全地创建备份。
 * VACUUM INTO 会创建一个优化后的数据库副本，同时保持原数据库的完整性。
 *
 * 备份路径从数据库的 user 表中读取配置：
 * - 优先使用 user.db_backup_path（如果设置且非空）
 * - 否则使用默认的 AppData/data/backups 目录（或便携模式下的程序目录）
 *
 * @returns 备份结果，包含备份文件的路径
 */
export async function backupDatabase(): Promise<BackupResult> {
	if (databaseImportInProgress) {
		throw new Error("数据库正在导入，请稍后再备份");
	}

	if (databaseBackupPromise) return databaseBackupPromise;

	databaseBackupPromise = (async () => {
		try {
			const result = await fileService.backupDatabase(
				await createPersistentSettingsSnapshot(),
			);
			console.log(`数据库已备份到: ${result.path}`);
			return result;
		} catch (error) {
			console.error("备份数据库失败:", error);
			throw error;
		} finally {
			databaseBackupPromise = null;
		}
	})();

	return databaseBackupPromise;
}

/**
 * 备份自定义封面（仅自定义封面，不含云端缓存）
 *
 * 扫描所有 game_{id} 目录，仅复制匹配 cover_{id}_* 的文件，
 * 无自定义封面的目录不会包含在备份中。
 * 备份路径跟随数据库备份路径逻辑。
 *
 * @returns 备份结果，包含备份文件的路径
 */
export async function backupCustomCovers(): Promise<BackupResult> {
	if (databaseImportInProgress) {
		throw new Error("数据库正在导入，请稍后再备份封面");
	}
	if (coverBackupPromise) return coverBackupPromise;

	coverBackupPromise = (async () => {
		try {
			const result = await fileService.backupCustomCovers();
			if (result.path) {
				console.log(`自定义封面已备份到: ${result.path}`);
			}
			return result;
		} catch (error) {
			console.error("备份自定义封面失败:", error);
			throw error;
		} finally {
			coverBackupPromise = null;
		}
	})();

	return coverBackupPromise;
}

/** 选择并恢复 ReinaManager 自己创建的自定义封面备份。 */
export async function restoreCustomCovers(): Promise<CustomCoverRestoreResult | null> {
	if (databaseImportInProgress) {
		throw new Error("数据库正在导入，请在重启完成后再恢复自定义封面");
	}
	if (customCoverRestorePromise) return customCoverRestorePromise;

	const archivePath = await open({
		filters: [{ name: "ReinaManager Custom Covers", extensions: ["7z"] }],
		multiple: false,
		directory: false,
	});
	if (!archivePath) return null;

	customCoverRestorePromise = (async () => {
		try {
			return await fileService.restoreCustomCovers(archivePath);
		} finally {
			customCoverRestorePromise = null;
		}
	})();
	return customCoverRestorePromise;
}

/** 创建带专用命名的自动备份批次，手动/导入前备份不会参与清理。 */
export async function createAutoDatabaseBackup(
	trigger: AutoBackupTrigger,
	includeCovers: boolean,
	maxAutoBackups: number,
): Promise<AutoBackupResult> {
	if (databaseImportInProgress) {
		throw new Error("数据库正在导入，请稍后再自动备份");
	}
	if (autoDatabaseBackupPromise) return autoDatabaseBackupPromise;

	autoDatabaseBackupPromise = (async () => {
		try {
			return await fileService.createAutoBackup({
				trigger,
				includeCovers,
				maxAutoBackups,
				settingsSnapshot: await createPersistentSettingsSnapshot(),
			});
		} finally {
			autoDatabaseBackupPromise = null;
		}
	})();

	return autoDatabaseBackupPromise;
}

/**
 * 导入数据库文件（覆盖现有数据库）
 *
 * 流程：
 * 1. 关闭当前数据库连接
 * 2. 使用 fs::copy 备份当前数据库（冷备份，性能更好）
 * 3. 用导入的数据库文件覆盖现有数据库
 * 4. 重新建立数据库连接
 *
 * 备份路径从数据库的 user 表中读取配置
 *
 * 注意：由于需要关闭并重新打开数据库连接，导入后需要重启应用以确保数据正确加载
 *
 * @returns Promise<ImportResult | null> 导入成功返回结果对象，取消返回 null
 */
export async function importDatabase(): Promise<ImportResult | null> {
	// 打开文件选择对话框
	const filePath = await open({
		filters: [{ name: "SQLite Database", extensions: ["db"] }],
		multiple: false,
		directory: false,
	});

	if (!filePath) {
		return null; // 用户取消
	}

	// 避免导入与手动/自动热备份同时操作数据库。
	for (const operation of [
		databaseBackupPromise,
		autoDatabaseBackupPromise,
		coverBackupPromise,
		customCoverRestorePromise,
	]) {
		if (operation) await operation;
	}

	databaseImportInProgress = true;
	try {
		const result = await fileService.importDatabase(
			filePath,
			await createPersistentSettingsSnapshot(),
		);
		if (result.success && result.settings_snapshot) {
			try {
				await restorePersistentSettingsSnapshot(result.settings_snapshot);
			} catch (error) {
				const detail = error instanceof Error ? error.message : "未知错误";
				return {
					...result,
					message: `${result.message}；数据库已恢复，但设置快照未应用: ${detail}`,
				};
			}
		}
		return result;
	} finally {
		databaseImportInProgress = false;
	}
}
