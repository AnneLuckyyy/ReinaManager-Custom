import { BaseService } from "./base";
import type { DownloadTask } from "./downloadTaskService";

export interface ShionlibInstallPreview {
	request_id: string;
	title: string;
	resource_id: string;
	file_name: string;
	archive_format: string;
	size: number;
	checksum_algorithm?: string | null;
	download_host: string;
	expires_at?: number | null;
}

class ShionlibInstallService extends BaseService {
	takePendingPreviews(): Promise<ShionlibInstallPreview[]> {
		return this.invoke<ShionlibInstallPreview[]>(
			"take_pending_shionlib_install_previews",
		);
	}

	takePendingRejections(): Promise<string[]> {
		return this.invoke<string[]>(
			"take_pending_shionlib_install_rejections",
		);
	}

	createPausedDownloadTask(requestId: string, autoImport = false, autoDelete = false): Promise<DownloadTask> {
		return this.invoke<DownloadTask>("create_shionlib_download_task", {
			requestId,
			autoImport,
			autoDelete,
		});
	}
}

export const shionlibInstallService = new ShionlibInstallService();
