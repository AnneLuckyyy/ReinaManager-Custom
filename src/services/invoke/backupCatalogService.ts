import { BaseService } from "./base";

export interface BackupCatalogFormatCounts {
	sevenZip: number;
	zip: number;
	rar: number;
}

export interface BackupCatalogWarning {
	code: string;
	message: string;
	path?: string | null;
}

export interface BackupCatalogPreview {
	suggestedSourceName: string;
	archiveCount: number;
	recognizedFileCount: number;
	singleArchiveCount: number;
	volumeArchiveCount: number;
	multiPartArchiveCount: number;
	ignoredEntryCount: number;
	duplicateNameCount: number;
	warningCount: number;
	formatCounts: BackupCatalogFormatCounts;
	warnings: BackupCatalogWarning[];
}

export interface BackupCatalogSourceSummary {
	id: number;
	name: string;
	originalFilePath: string;
	importedAt: string;
	archiveCount: number;
	partCount: number;
	warningCount: number;
	missingCount: number;
}

export interface BackupCatalogImportResult {
	source: BackupCatalogSourceSummary;
	preview: BackupCatalogPreview;
}

export interface BackupArchivePartRecord {
	fileName: string;
	relativePath: string;
	partNumber?: number | null;
}

export interface BackupArchiveRecord {
	id: number;
	sourceId: number;
	sourceName: string;
	relativeDirectory: string;
	baseName: string;
	archiveFormat: string;
	volumeStyle: string;
	partCount: number;
	sequenceStatus: string;
	isPresent: boolean;
	lastSeenAt: string;
	matchStatus?: "matched" | "no_game" | null;
	matchedGameId?: number | null;
	matchMethod?: "manual" | "auto_exact" | "auto_fuzzy" | null;
	matchScore?: number | null;
	matchConfirmed?: boolean | null;
	parts: BackupArchivePartRecord[];
}

export interface GameBackupArchiveRecord {
	id: number;
	sourceName: string;
	baseName: string;
	archiveFormat: string;
	partCount: number;
	isPresent: boolean;
	matchConfirmed: boolean;
	parts: BackupArchivePartRecord[];
}

export interface GameBackupCountRecord {
	gameId: number;
	backupCount: number;
}

export interface BackupMatchNameFill {
	gameId: number;
	matchName: string;
}

export interface BackupAutoMatchAssignment {
	archiveId: number;
	gameId: number;
	score?: number | null;
	confirmed: boolean;
}

export interface BackupAutoMatchResult {
	filledNameCount: number;
	confirmedArchiveCount: number;
	doubtfulArchiveCount: number;
}

class BackupCatalogService extends BaseService {
	preview(filePath: string): Promise<BackupCatalogPreview> {
		return this.invoke("preview_backup_catalog", { filePath });
	}

	listSources(): Promise<BackupCatalogSourceSummary[]> {
		return this.invoke("list_backup_catalog_sources");
	}

	import(
		filePath: string,
		sourceName: string,
		sourceId?: number,
	): Promise<BackupCatalogImportResult> {
		return this.invoke("import_backup_catalog", {
			filePath,
			sourceName,
			sourceId: sourceId ?? null,
		});
	}

	deleteSource(sourceId: number): Promise<void> {
		return this.invoke("delete_backup_catalog_source", { sourceId });
	}

	listArchives(): Promise<BackupArchiveRecord[]> {
		return this.invoke("list_backup_archives");
	}

	listGameArchives(gameId: number): Promise<GameBackupArchiveRecord[]> {
		return this.invoke("list_game_backup_archives", { gameId });
	}

	listGameBackupCounts(): Promise<GameBackupCountRecord[]> {
		return this.invoke("list_game_backup_counts");
	}

	setArchiveMatch(
		archiveId: number,
		status: "matched" | "no_game" | null,
		gameId?: number,
	): Promise<void> {
		return this.invoke("set_backup_archive_match", {
			archiveId,
			status,
			gameId: gameId ?? null,
		});
	}

	applyAutoMatches(
		nameFills: BackupMatchNameFill[],
		matches: BackupAutoMatchAssignment[],
	): Promise<BackupAutoMatchResult> {
		return this.invoke("apply_backup_auto_matches", { nameFills, matches });
	}
}

export const backupCatalogService = new BackupCatalogService();
