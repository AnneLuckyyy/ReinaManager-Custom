/**
 * @file useVirtualCollections Hook
 * @description 虚拟分组生成器，开发商分组复用 GameIndex 中的预构建索引
 * @module src/hooks/useVirtualCollections
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Category } from "@/types/collection";
import {
	type GameIndex,
	getDeveloperNames,
	UNKNOWN_DEVELOPER_KEY,
} from "@/utils/gameIndex";

export { getDeveloperNames };

/**
 * 判断是否为虚拟分类
 */
export function isVirtualCategory(categoryId: number): boolean {
	return categoryId < 0;
}

/**
 * 判断是否为开发商分组
 */
export function isDeveloperGroup(categoryId: number): boolean {
	return categoryId <= -101;
}

function translateDeveloperCategoryName(
	name: string,
	unknownDeveloper: string,
): string {
	return name === UNKNOWN_DEVELOPER_KEY ? unknownDeveloper : name;
}

/**
 * 生成开发商分类列表
 *
 * 分类计数和排序来自 GameIndex，Hook 只负责把内部未知开发商 key 映射为当前语言文案。
 */
export function useDeveloperCategories(
	gameIndex: Pick<GameIndex, "developerCategories">,
): Category[] {
	const { t } = useTranslation();
	const unknownDeveloper = t("category.unknownDeveloper", "未知开发商");

	return useMemo(
		() =>
			gameIndex.developerCategories.map((category) => ({
				...category,
				name: translateDeveloperCategoryName(category.name, unknownDeveloper),
			})),
		[gameIndex.developerCategories, unknownDeveloper],
	);
}

/**
 * 获取虚拟分类下的游戏 ID 列表
 */
export function getVirtualCategoryGameIds(
	categoryId: number,
	gameIndex: Pick<GameIndex, "developerGameIdsByCategoryId">,
): number[] {
	if (isDeveloperGroup(categoryId)) {
		return gameIndex.developerGameIdsByCategoryId.get(categoryId) ?? [];
	}

	return [];
}

/**
 * 统一的虚拟分类 Hook
 * 返回所有虚拟分类相关的数据和方法
 */
export function useVirtualCategories(
	gameIndex: Pick<
		GameIndex,
		"developerCategories" | "developerGameIdsByCategoryId"
	>,
) {
	const developerCategories = useDeveloperCategories(gameIndex);

	/**
	 * 根据分组ID获取对应的分类列表
	 */
	const getCategoriesByGroupId = (
		groupId: string,
		realCategories: Category[],
	): Category[] => {
		switch (groupId) {
			case "default_developer":
				return developerCategories;
			default:
				return realCategories;
		}
	};

	/**
	 * 获取虚拟分类的名称（用于面包屑）
	 */
	const getVirtualCategoryName = (
		_categoryId: number,
		storedName: string | null,
	): string | null => {
		return storedName;
	};

	const getGameIds = (categoryId: number): number[] =>
		getVirtualCategoryGameIds(categoryId, gameIndex);

	return {
		developerCategories,
		getCategoriesByGroupId,
		getVirtualCategoryName,
		isVirtual: isVirtualCategory,
		isDeveloper: isDeveloperGroup,
		getGameIds,
	};
}
