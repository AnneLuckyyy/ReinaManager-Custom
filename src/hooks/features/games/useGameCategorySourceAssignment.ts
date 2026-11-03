import { useCallback } from "react";
import { useAddGamesToCategories } from "@/hooks/queries/useCollections";
import { useModStore } from "@/store/modStore";
import { findGameCategorySourceFolder } from "@/utils/gameCategorySourceFolders";

export interface ImportedLocalGame {
	gameId: number;
	path: string | null | undefined;
}

/**
 * 将刚成功导入的本地游戏加入其最具体来源目录对应的收藏夹分类。
 * 这是附加归类，不会移除游戏已有分类；来源配置失效时由调用方提示，
 * 也绝不回滚已成功写入的游戏记录。
 */
export function useGameCategorySourceAssignment() {
	const sources = useModStore((state) => state.gameCategorySourceFolders);
	const addGamesToCategories = useAddGamesToCategories();

	const assignImportedGames = useCallback(async (games: ImportedLocalGame[]) => {
		const byCategory = new Map<number, number[]>();
		for (const game of games) {
			const source = findGameCategorySourceFolder(game.path, sources);
			if (!source) continue;
			const ids = byCategory.get(source.categoryId) ?? [];
			ids.push(game.gameId);
			byCategory.set(source.categoryId, ids);
		}

		let assigned = 0;
		let failed = 0;
		for (const [categoryId, gameIds] of byCategory) {
			try {
				await addGamesToCategories.mutateAsync({ gameIds, categoryIds: [categoryId] });
				assigned += gameIds.length;
			} catch {
				failed += gameIds.length;
			}
		}
		return { assigned, failed };
	}, [addGamesToCategories, sources]);

	return { assignImportedGames };
}
