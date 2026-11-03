import type { DiskHealthSnapshot } from "@/types/diskHealth";
import { BaseService } from "./base";

export interface DiskHealthConnectionFile {
	filePath: string;
}

export interface DiskHealthConnectionCheck {
	executablePath: string;
	fingerprint: string;
	snapshot: DiskHealthSnapshot;
}

class DiskHealthService extends BaseService {
	async read(
		executablePath: string,
		useAuthorizedTask: boolean,
		authorizationFingerprint: string | null,
	): Promise<DiskHealthSnapshot> {
		return this.invoke<DiskHealthSnapshot>("read_disk_health", {
			executablePath,
			useAuthorizedTask,
			authorizationFingerprint,
		});
	}

	async prepareConnection(
		executablePath: string,
		workspacePath: string,
	): Promise<DiskHealthConnectionFile> {
		return this.invoke<DiskHealthConnectionFile>(
			"prepare_disk_health_connection",
			{ executablePath, workspacePath },
		);
	}

	async checkConnection(
		executablePath: string,
		workspacePath: string,
	): Promise<DiskHealthConnectionCheck> {
		return this.invoke<DiskHealthConnectionCheck>(
			"check_disk_health_connection",
			{ executablePath, workspacePath },
		);
	}

	async prepareDisconnection(
		workspacePath: string,
	): Promise<DiskHealthConnectionFile> {
		return this.invoke<DiskHealthConnectionFile>(
			"prepare_disk_health_disconnection",
			{ workspacePath },
		);
	}
}

export const diskHealthService = new DiskHealthService();
