import { useQuery } from "@tanstack/react-query";
import { backupCatalogService } from "@/services/invoke";
import type { BackupStatusFilter } from "@/types/collection";

export const backupCatalogKeys = {
	all: ["backupCatalog"] as const,
	gameCounts: () => [...backupCatalogKeys.all, "gameCounts"] as const,
};

export function useGameBackupCounts(enabled: boolean) {
	return useQuery({
		queryKey: backupCatalogKeys.gameCounts(),
		queryFn: async () => {
			const records = await backupCatalogService.listGameBackupCounts();
			return new Map(
				records.map((record) => [record.gameId, record.backupCount]),
			);
		},
		enabled,
	});
}

export function matchesGameBackupFilter(
	backupCount: number,
	filter: BackupStatusFilter,
): boolean {
	switch (filter) {
		case "has":
			return backupCount >= 1;
		case "multiple":
			return backupCount >= 2;
		case "none":
			return backupCount === 0;
		default:
			return true;
	}
}
