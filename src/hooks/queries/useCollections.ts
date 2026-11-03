import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { getVirtualCategoryGameIds } from "@/hooks/common/useVirtualCollections";
import {
	matchesGameBackupFilter,
	useGameBackupCounts,
} from "@/hooks/queries/useBackupCatalog";
import { collectionService } from "@/services/invoke";
import { useModStore } from "@/store/modStore";
import { PlayStatus } from "@/types/collection";
import { getGameDisplayName } from "@/utils/appUtils";
import { matchesAllTagFilters } from "@/utils/tagFilter";
import type { GameIndex } from "@/utils/gameIndex";
import { getAllGameStatistics } from "@/utils/gameStats";
import { statsKeys } from "./useStats";

export const collectionKeys = {
	all: ["collections"] as const,
	groups: () => [...collectionKeys.all, "groups"] as const,
	categories: (groupId: string) =>
		[...collectionKeys.all, "categories", groupId] as const,
	games: (categoryId: number) =>
		[...collectionKeys.all, "games", categoryId] as const,
	gameCategories: (gameId: number) =>
		[...collectionKeys.all, "gameCategories", gameId] as const,
	groupCounts: (groupIds: number[]) =>
		[...collectionKeys.all, "groupCounts", groupIds] as const,
};

function useGroups() {
	return useQuery({
		queryKey: collectionKeys.groups(),
		queryFn: () => collectionService.getGroups(),
	});
}

function useGroupGameCounts(groupIds: number[]) {
	return useQuery({
		queryKey: collectionKeys.groupCounts(groupIds),
		queryFn: () => collectionService.batchCountGamesInGroups(groupIds),
		enabled: groupIds.length > 0,
	});
}

function useCategories(groupId: string | null) {
	const isEnabled = Boolean(groupId) && !groupId?.startsWith("default_");

	return useQuery({
		queryKey: collectionKeys.categories(groupId ?? "none"),
		queryFn: async () => {
			if (!groupId || groupId.startsWith("default_")) {
				return [];
			}

			const groupIdNum = Number.parseInt(groupId, 10);
			if (Number.isNaN(groupIdNum)) {
				return [];
			}

			return collectionService.getCategoriesWithCount(groupIdNum);
		},
		enabled: isEnabled,
	});
}

function useCategoryGameIds(categoryId: number | null) {
	return useQuery({
		queryKey: collectionKeys.games(categoryId ?? 0),
		queryFn: async () => {
			if (!categoryId || categoryId < 0) {
				return [];
			}

			return collectionService.getGamesInCollection(categoryId);
		},
		enabled: categoryId !== null && categoryId > 0,
	});
}

function useGameCategoryIds(gameId: number | null) {
	return useQuery({
		queryKey: collectionKeys.gameCategories(gameId ?? 0),
		queryFn: async () => {
			if (!gameId) {
				return [];
			}

			return collectionService.getGameCollectionIds(gameId);
		},
		enabled: gameId !== null && gameId > 0,
	});
}

/**
 * 从收藏分类中获取游戏 ID 列表
 *
 * 支持虚拟分类（负数 ID）和真实分类（正数 ID）。
 * 返回原始 ID 列表，不做 NSFW 过滤（收藏夹显示全部内容）。
 */
function useCategoryGames(
	categoryId: number | null,
	gameIndex: GameIndex,
) {
	const categoryGameIdsQuery = useCategoryGameIds(categoryId);
	const viewPref = useModStore((state) => 
		categoryId !== null ? state.collectionViewPrefs[categoryId] : null
	);
	const gameFilterType = viewPref?.gameFilterType ?? "all";
	const playStatusFilter = viewPref?.playStatusFilter ?? [];
	const backupStatusFilter = viewPref?.backupStatusFilter ?? "all";
	const tagFilters = viewPref?.tagFilters ?? [];
	const sortOption = viewPref?.sortOption ?? "addtime";
	const sortOrder = viewPref?.sortOrder ?? "asc";
	const customOrderInitialized = viewPref?.customOrderInitialized ?? true;
	const backupCountsQuery = useGameBackupCounts(backupStatusFilter !== "all");

	const allStatsQuery = useQuery({
		queryKey: statsKeys.all,
		queryFn: getAllGameStatistics,
	});

	const sourceData = useMemo((): number[] => {
		if (categoryId === null) {
			return [];
		}

		if (categoryId < 0) {
			// 虚拟分类：直接从 GameIndex 中读取预构建 ID 列表
			return getVirtualCategoryGameIds(categoryId, gameIndex);
		}

		// 真实分类：直接返回 ID 列表
		return categoryGameIdsQuery.data ?? [];
	}, [categoryGameIdsQuery.data, categoryId, gameIndex]);

	const orderedAllData = useMemo((): number[] => {
		const effectiveSortOption =
			sortOption === "custom" && !customOrderInitialized
				? "addtime"
				: sortOption;
		const statsMap = allStatsQuery.data;
		const sourceOrder = new Map(sourceData.map((id, index) => [id, index]));

		return [...sourceData].sort((aId, bId) => {
			const a = gameIndex.displayById.get(aId);
			const b = gameIndex.displayById.get(bId);
			if (!a || !b) {
				return (sourceOrder.get(aId) ?? 0) - (sourceOrder.get(bId) ?? 0);
			}

			let result = 0;
			switch (effectiveSortOption) {
				case "custom":
					result =
						(sourceOrder.get(aId) ?? 0) - (sourceOrder.get(bId) ?? 0);
					break;
				case "addtime":
					result = (a.created_at || 0) - (b.created_at || 0);
					break;
				case "datetime":
					result = (a.date || "").localeCompare(b.date || "");
					break;
				case "lastplayed":
					result =
						(statsMap?.get(aId)?.last_played || 0) -
						(statsMap?.get(bId)?.last_played || 0);
					break;
				case "bgmrank":
					result = (a.rank || 999999) - (b.rank || 999999);
					break;
				case "bgmscore":
					// [PROTECTED DESIGN]: ASC 保持高分在前。
					result = (b.score || 0) - (a.score || 0);
					break;
				case "vndbrank":
					result = (a.rank || 999999) - (b.rank || 999999);
					break;
				case "namesort":
					result = getGameDisplayName(a).localeCompare(
						getGameDisplayName(b),
						"zh-Hans-CN",
						{ sensitivity: "accent" },
					);
					break;
				default:
					result = 0;
			}

			if (result === 0) {
				result =
					(sourceOrder.get(aId) ?? 0) - (sourceOrder.get(bId) ?? 0);
			}
			return sortOrder === "asc" ? result : -result;
		});
	}, [
		sourceData,
		gameIndex,
		sortOption,
		sortOrder,
		customOrderInitialized,
		allStatsQuery.data,
	]);

	const data = useMemo((): number[] => {
		return orderedAllData.filter((id) => {
			const game = gameIndex.displayById.get(id);
			if (!game) return false;

			// 游戏来源筛选
			if (gameFilterType !== "all") {
				if (gameFilterType === "local" && game.localpath == null) return false;
				if (gameFilterType === "online" && game.localpath != null) return false;
				if (gameFilterType === "iscustom" && game.id_type !== "custom") return false;
			}

			// 游玩状态筛选
			if (playStatusFilter.length > 0) {
				if (!playStatusFilter.includes(game.clear ?? PlayStatus.WISH)) return false;
			}

			if (
				!matchesGameBackupFilter(
					backupCountsQuery.data?.get(id) ?? 0,
					backupStatusFilter,
				)
			) {
				return false;
			}

			if (!matchesAllTagFilters(game.tags ?? [], tagFilters)) return false;

			return true;
		});
	}, [
		orderedAllData,
		gameIndex,
		gameFilterType,
		playStatusFilter,
		backupStatusFilter,
		backupCountsQuery.data,
		tagFilters,
	]);

	return {
		data,
		sourceData,
		orderedAllData,
		sortOption,
		sortOrder,
		customOrderInitialized,
		isLoading:
			(categoryId !== null && categoryId > 0 && categoryGameIdsQuery.isLoading) ||
			backupCountsQuery.isLoading,
		isError:
			(categoryId !== null && categoryId > 0 && categoryGameIdsQuery.isError) ||
			backupCountsQuery.isError,
		error: categoryGameIdsQuery.error ?? backupCountsQuery.error,
	};
}

function useCreateGroup() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ name }: { name: string }) =>
			collectionService.createCollection(name, null, 0),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: collectionKeys.groups() });
		},
	});
}

function useDeleteGroup() {
	const queryClient = useQueryClient();
	const clearPinnedFolder = useModStore((state) => state.clearPinnedFolder);

	return useMutation({
		mutationFn: (groupId: number) =>
			collectionService.deleteCollection(groupId),
		onSuccess: (_, groupId) => {
			queryClient.invalidateQueries({ queryKey: collectionKeys.groups() });
			queryClient.invalidateQueries({ queryKey: collectionKeys.all });
			// 清理该分组下所有已固定的分类
			clearPinnedFolder("group", groupId.toString());
		},
	});
}

function useRenameGroup() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ groupId, newName }: { groupId: number; newName: string }) =>
			collectionService.updateCollection(groupId, newName),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: collectionKeys.groups() });
		},
	});
}

function useCreateCategory() {
	const queryClient = useQueryClient();
	const updateCollectionViewPref = useModStore(
		(state) => state.updateCollectionViewPref,
	);

	return useMutation({
		mutationFn: ({ name, groupId }: { name: string; groupId: number }) =>
			collectionService.createCollection(name, groupId, 0),
		onSuccess: (category, { groupId }) => {
			updateCollectionViewPref(category.id, {
				customOrderInitialized: false,
			});
			queryClient.invalidateQueries({
				queryKey: collectionKeys.categories(groupId.toString()),
			});
		},
	});
}

function useDeleteCategory() {
	const queryClient = useQueryClient();
	const clearPinnedFolder = useModStore((state) => state.clearPinnedFolder);
	const clearCollectionViewPref = useModStore(
		(state) => state.clearCollectionViewPref,
	);

	return useMutation({
		mutationFn: ({
			categoryId,
			groupId: _groupId,
		}: {
			categoryId: number;
			groupId?: string | null;
		}) => collectionService.deleteCollection(categoryId),
		onSuccess: (_, { categoryId, groupId }) => {
			queryClient.invalidateQueries({
				queryKey: collectionKeys.games(categoryId),
				exact: true,
			});
			if (groupId) {
				queryClient.invalidateQueries({
					queryKey: collectionKeys.categories(groupId),
				});
			} else {
				queryClient.invalidateQueries({ queryKey: collectionKeys.all });
			}
			// 清理该已固定的分类
			clearPinnedFolder("category", categoryId);
			clearCollectionViewPref(categoryId);
		},
	});
}

function useRenameCategory() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			categoryId,
			newName,
		}: {
			categoryId: number;
			newName: string;
		}) => collectionService.updateCollection(categoryId, newName),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: collectionKeys.all });
		},
	});
}

function useAddGamesToCategories() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			gameIds,
			categoryIds,
		}: {
			gameIds: number[];
			categoryIds: number[];
		}) => collectionService.addGamesToCollections(gameIds, categoryIds),
		onSuccess: (_, { gameIds, categoryIds }) => {
			for (const categoryId of categoryIds) {
				queryClient.invalidateQueries({
					queryKey: collectionKeys.games(categoryId),
					exact: true,
				});
			}
			for (const gameId of gameIds) {
				queryClient.invalidateQueries({
					queryKey: collectionKeys.gameCategories(gameId),
					exact: true,
				});
			}
			queryClient.invalidateQueries({ queryKey: collectionKeys.all });
		},
	});
}

function useSetGameCategories() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			gameId,
			categoryIds,
		}: {
			gameId: number;
			categoryIds: number[];
		}) => collectionService.setGameCollections(gameId, categoryIds),
		onSuccess: (_, { gameId }) => {
			queryClient.invalidateQueries({
				queryKey: collectionKeys.gameCategories(gameId),
				exact: true,
			});
			queryClient.invalidateQueries({ queryKey: collectionKeys.all });
		},
	});
}

function useRemoveGamesFromCategory() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			categoryId,
			gameIds,
		}: {
			categoryId: number;
			gameIds: number[];
		}) => collectionService.removeGamesFromCollection(gameIds, categoryId),
		onSuccess: (_, { categoryId, gameIds }) => {
			queryClient.invalidateQueries({
				queryKey: collectionKeys.games(categoryId),
				exact: true,
			});
			for (const gameId of gameIds) {
				queryClient.invalidateQueries({
					queryKey: collectionKeys.gameCategories(gameId),
					exact: true,
				});
			}
			queryClient.invalidateQueries({ queryKey: collectionKeys.all });
		},
	});
}

function useUpdateCategoryGames() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			categoryId,
			gameIds,
		}: {
			categoryId: number;
			gameIds: number[];
		}) => collectionService.updateCategoryGames(gameIds, categoryId),
		onMutate: async ({ categoryId, gameIds }) => {
			await queryClient.cancelQueries({
				queryKey: collectionKeys.games(categoryId),
			});
			const previousGameIds = queryClient.getQueryData<number[]>(
				collectionKeys.games(categoryId),
			);
			queryClient.setQueryData(collectionKeys.games(categoryId), gameIds);
			return { previousGameIds };
		},
		onError: (_error, { categoryId }, context) => {
			if (context?.previousGameIds) {
				queryClient.setQueryData(
					collectionKeys.games(categoryId),
					context.previousGameIds,
				);
			}
		},
		onSuccess: (_, { categoryId }) => {
			queryClient.invalidateQueries({
				queryKey: collectionKeys.games(categoryId),
				exact: true,
			});
			queryClient.invalidateQueries({ queryKey: collectionKeys.all });
		},
	});
}

/**
 * 更新分类排序顺序
 */
function useUpdateCategorySortOrder() {
	return useMutation({
		mutationFn: async ({
			categoryId,
			sortOrder,
		}: {
			categoryId: number;
			sortOrder: number;
		}) => {
			await collectionService.updateCollection(categoryId, undefined, undefined, sortOrder);
		},
	});
}

export {
	useAddGamesToCategories,
	useCategories,
	useCategoryGameIds,
	useCategoryGames,
	useCreateCategory,
	useCreateGroup,
	useDeleteCategory,
	useDeleteGroup,
	useGameCategoryIds,
	useGroupGameCounts,
	useGroups,
	useRemoveGamesFromCategory,
	useRenameCategory,
	useRenameGroup,
	useSetGameCategories,
	useUpdateCategoryGames,
	useUpdateCategorySortOrder,
};
