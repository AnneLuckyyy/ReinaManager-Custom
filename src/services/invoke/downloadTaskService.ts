import { BaseService } from "./base";
import type { BgmData } from "@/types";

export type DownloadTaskStatus =
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export interface DownloadTask {
	id: number;
	title: string;
	status: DownloadTaskStatus;
	task_kind: "download" | "shionlib_install";
	url: string;
	root_path: string;
	file_name?: string | null;
	checksum_algorithm?: string | null;
	checksum_value?: string | null;
	remote_etag?: string | null;
	remote_last_modified?: string | null;
	source_expires_at?: number | null;
	install_stage?: string | null;
	install_root_path?: string | null;
	source_provider?: string | null;
	source_resource_id?: string | null;
	archive_format?: string | null;
	metadata_json?: string | null;
	install_result_json?: string | null;
	error_code?: string | null;
	auto_import: boolean;
	auto_delete: boolean;
	progress_current: number;
	progress_total: number;
	error_message?: string | null;
	created_at: number;
	updated_at: number;
}

export interface DownloadArchiveInspection {
	archive_format: string;
	is_multipart: boolean;
	part_index?: number | null;
	password_status: "required" | "not_required" | "unknown";
	readable: boolean;
	entry_count?: number | null;
	unpacked_size?: number | null;
	has_staging: boolean;
	note: string;
}

export interface DownloadArchiveStagingResult {
	staging_name: string;
	entry_count: number;
	unpacked_size: number;
}

export interface DownloadArchiveMoveResult {
	target_folder_name: string;
	target_path: string;
	file_count: number;
	source_staging_retained: boolean;
}

export interface RegisteredDownloadGame {
	game_id: number;
}

export interface ImportedShionlibGame {
	game_id: number;
	created_new_game: boolean;
	executable_path: string;
}

class DownloadTaskService extends BaseService {
	createTask(data: { title: string; url: string }): Promise<DownloadTask> {
		return this.invoke<DownloadTask>("create_download_task", { data });
	}

	listTasks(): Promise<DownloadTask[]> {
		return this.invoke<DownloadTask[]>("list_download_tasks");
	}

	inspectCompletedArchive(taskId: number): Promise<DownloadArchiveInspection> {
		return this.invoke<DownloadArchiveInspection>(
			"inspect_completed_download_archive",
			{ taskId },
		);
	}

	extractCompletedArchive(data: { taskId: number; password?: string }): Promise<DownloadArchiveStagingResult> {
		return this.invoke<DownloadArchiveStagingResult>(
			"extract_completed_download_archive",
			{ data },
		);
	}

	discardCompletedArchiveStaging(taskId: number): Promise<void> {
		return this.invoke<void>("discard_completed_download_archive_staging", { taskId });
	}

	moveCompletedArchiveStaging(data: {
		taskId: number;
		targetParent: string;
		targetFolderName: string;
	}): Promise<DownloadArchiveMoveResult> {
		return this.invoke<DownloadArchiveMoveResult>(
			"move_completed_download_archive_staging",
			{ data },
		);
	}

	registerMovedGame(data: {
		taskId: number;
		targetDirectory: string;
		executablePath: string;
		title: string;
	}): Promise<RegisteredDownloadGame> {
		return this.invoke<RegisteredDownloadGame>(
			"register_moved_download_game",
			{ data },
		);
	}

	importShionlibInstalledGame(data: {
		taskId: number;
		executableName: string;
		title: string;
		bgmId?: string;
		bgmData?: BgmData;
	}): Promise<ImportedShionlibGame> {
		return this.invoke<ImportedShionlibGame>(
			"import_shionlib_installed_game",
			{ data },
		);
	}

	resumeTask(taskId: number): Promise<DownloadTask> {
		return this.invoke<DownloadTask>("resume_download_task", { taskId });
	}

	restartTask(taskId: number): Promise<DownloadTask> {
		return this.invoke<DownloadTask>("restart_download_task", { taskId });
	}

	pauseTask(taskId: number): Promise<DownloadTask> {
		return this.invoke<DownloadTask>("pause_download_task", { taskId });
	}

	cancelTask(taskId: number): Promise<DownloadTask> {
		return this.invoke<DownloadTask>("cancel_download_task", { taskId });
	}

	deleteTask(taskId: number): Promise<void> {
		return this.invoke<void>("delete_download_task", { taskId });
	}

	updateTaskAutomation(taskId: number, autoImport: boolean, autoDelete: boolean): Promise<DownloadTask> {
		return this.invoke<DownloadTask>("update_download_task_automation", { taskId, autoImport, autoDelete });
	}
}

export const downloadTaskService = new DownloadTaskService();
