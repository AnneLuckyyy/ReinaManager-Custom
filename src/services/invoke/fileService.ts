/**
 * @file 文件与系统操作服务
 * @description 封装文件系统、目录打开与数据库备份/导入相关后端调用
 */

import type { ScanResult } from "@/types";
import { BaseService } from "./base";

export interface SteamLaunchTarget {
	steam_launch_id: string;
	name: string;
	localpath?: string;
	executable?: string;
}

export interface SteamLaunchTargetScanResult {
	targets: SteamLaunchTarget[];
	warnings: string[];
}

export interface BulkImportPathCandidate {
	name: string;
	path: string;
	executables: string[];
	selected_exe?: string;
	launch_type?: "steam";
	steam_launch_id?: string;
	steam_monitor_path?: string;
}

export interface BulkImportPathResult {
	candidates: BulkImportPathCandidate[];
	issues: Array<{ path: string; message: string }>;
}

export interface ScanDirectoryResult {
	candidates: ScanResult[];
	unscanned_directories: Array<{ name: string; path: string; reason?: string }>;
}

export type GameDirectoryScanMode = "executable" | "first_level_directory";

export interface BackupResult {
	success: boolean;
	path: string | null;
	message: string;
}

export interface CustomCoverRestoreResult {
	success: boolean;
	message: string;
	backup_path: string | null;
	restored_count: number;
}

export interface ImportResult {
	success: boolean;
	message: string;
	backup_path: string | null;
	settings_snapshot?: string | null;
}

export type AutoBackupTrigger = "scheduled" | "exit";

export interface AutoBackupResult {
	batchId: string;
	database: BackupResult;
	covers: BackupResult | null;
	warnings: string[];
}

export interface PortableModeResult {
	is_portable: boolean;
}

export interface GameArchiveResult {
	archive_path: string;
	source_deleted: boolean;
	warning: string | null;
}

class FileService extends BaseService {
	/**
	 * 扫描目录下的游戏文件夹
	 */
	async scanDirectoryForGames(
		path: string,
		maxDepth: number,
		scanMode: GameDirectoryScanMode,
		scanContextRoots: string[] = [],
	): Promise<ScanDirectoryResult> {
		return this.invoke<ScanDirectoryResult>("scan_directory_for_games", {
			path,
			maxDepth,
			scanMode,
			scanContextRoots,
		});
	}

	/** 扫描 Steam 库和已配置的非 Steam 快捷方式；不会写入游戏库。 */
	async scanSteamLaunchTargets(
		excludeExisting = true,
	): Promise<SteamLaunchTargetScanResult> {
		return this.invoke<SteamLaunchTargetScanResult>("scan_steam_launch_targets", {
			excludeExisting,
		});
	}

	/** 读取 .url / .desktop 中的 Steam 启动标识；不会执行文件。 */
	async resolveSteamShortcutFile(path: string): Promise<SteamLaunchTarget | null> {
		return this.invoke<SteamLaunchTarget | null>("resolve_steam_shortcut_file", {
			path,
		});
	}

	/** 将多项本地文件、文件夹和 Steam 快捷方式解析为批量导入候选，不写入游戏库。 */
	async resolveBulkImportPaths(paths: string[]): Promise<BulkImportPathResult> {
		return this.invoke<BulkImportPathResult>("resolve_bulk_import_paths", {
			paths,
		});
	}

	/**
	 * 打开目录
	 */
	async openDirectory(dirPath: string): Promise<void> {
		return this.invoke<void>("open_directory", { dirPath });
	}

	/** 打包当前游戏主路径所在目录；后端会校验内容，且仅在校验后才会删除原目录。 */
	async archiveGameDirectory(params: {
		gameId: number;
		format: "7z" | "zip";
		compressionLevel: number;
		password?: string;
		encryptHeaders: boolean;
		deleteSource: boolean;
		deleteBehavior: "permanent" | "recycle";
	}): Promise<GameArchiveResult> {
		return this.invoke<GameArchiveResult>("archive_game_directory", {
			gameId: params.gameId,
			format: params.format,
			compressionLevel: params.compressionLevel,
			password: params.password || null,
			encryptHeaders: params.encryptHeaders,
			deleteSource: params.deleteSource,
			deleteBehavior: params.deleteBehavior,
		});
	}

	/**
	 * 判断当前是否为便携模式
	 */
	async isPortableMode(): Promise<PortableModeResult> {
		return this.invoke<PortableModeResult>("is_portable_mode");
	}

	/**
	 * 复制文件
	 */
	async copyFile(src: string, dst: string): Promise<void> {
		return this.invoke<void>("copy_file", { src, dst });
	}

	/**
	 * 删除文件
	 */
	async deleteFile(filePath: string): Promise<void> {
		return this.invoke<void>("delete_file", { filePath });
	}

	/**
	 * 删除指定游戏的自定义封面
	 */
	async deleteGameCovers(gameId: number, coversDir: string): Promise<void> {
		return this.invoke<void>("delete_game_covers", { gameId, coversDir });
	}

	/**
	 * 删除本地的云端封面缓存
	 */
	async deleteCloudCoverCache(gameId: number): Promise<void> {
		return this.invoke<void>("delete_cloud_cache", { gameId });
	}

	/**
	 * 读取剪贴板图片并写入临时文件，供封面保存前预览
	 */
	async importClipboardImageToTemp(gameId: number): Promise<string> {
		return this.invoke<string>("import_clipboard_image_to_temp", { gameId });
	}

	/**
	 * 备份数据库
	 */
	async backupDatabase(settingsSnapshot: string): Promise<BackupResult> {
		return this.invoke<BackupResult>("backup_database", { settingsSnapshot });
	}

	/**
	 * 备份自定义封面（仅自定义封面，不含云端缓存）
	 */
	async backupCustomCovers(): Promise<BackupResult> {
		return this.invoke<BackupResult>("backup_custom_covers");
	}

	/** 恢复自定义封面归档；仅替换自定义 cover 文件，不影响网络封面缓存。 */
	async restoreCustomCovers(
		archivePath: string,
	): Promise<CustomCoverRestoreResult> {
		return this.invoke<CustomCoverRestoreResult>("restore_custom_covers", {
			archivePath,
		});
	}

	/** 创建数据库自动备份批次，仅清理自动生成的同类旧备份。 */
	async createAutoBackup(request: {
		trigger: AutoBackupTrigger;
		includeCovers: boolean;
		maxAutoBackups: number;
		settingsSnapshot: string;
	}): Promise<AutoBackupResult> {
		return this.invoke<AutoBackupResult>("create_auto_backup", { request });
	}

	/**
	 * 导入数据库
	 */
	async importDatabase(
		sourcePath: string,
		currentSettingsSnapshot: string,
	): Promise<ImportResult> {
		return this.invoke<ImportResult>("import_database", {
			sourcePath,
			currentSettingsSnapshot,
		});
	}
}

export const fileService = new FileService();
