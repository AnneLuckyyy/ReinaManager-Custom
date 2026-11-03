/**
 * @file ManageGamesDialog 管理游戏弹窗组件
 * @description 双栏穿梭框模式的游戏管理对话框，支持添加/移除游戏到分类
 * @module src/components/Collection/ManageGamesDialog
 * @author ReinaManager
 * @copyright AGPL-3.0
 */

import FilterListIcon from "@mui/icons-material/FilterList";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Pagination from "@mui/material/Pagination";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDebouncedValue } from "@/hooks/common/useDebouncedValue";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import {
	collectionKeys,
	useCategoryGameIds,
	useUpdateCategoryGames,
} from "@/hooks/queries/useCollections";
import { collectionService } from "@/services/invoke";
import { snackbar } from "@/providers/snackBar";
import type { GameData } from "@/types";
import { getGameDisplayName } from "@/utils/appUtils";
import { createSearchIndex, searchWithIndex } from "@/utils/enhancedSearch";

interface ManageGamesDialogProps {
	open: boolean;
	onClose: () => void;
	categoryId: number;
	categoryName?: string;
}

const GAMES_PER_PAGE = 10;

/**
 * 筛选模式定义
 */
type FilterMode = "none" | "group" | "all";

/**
 * 管理游戏弹窗组件
 */
export const ManageGamesDialog: React.FC<ManageGamesDialogProps> = ({
	open,
	onClose,
	categoryId,
	categoryName,
}) => {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const { index } = useGameIndex();
	const displayAllGames = index.displayList;
	const categoryGameIdsQuery = useCategoryGameIds(categoryId);
	const updateCategoryGamesMutation = useUpdateCategoryGames();

	// 1. 获取全量分类树状数据（仅在 Dialog 打开时有效，利用缓存）
	const allUserCollectionsQuery = useQuery({
		queryKey: ["collections", "all_user_data"],
		queryFn: async () => {
			const groups = await collectionService.getGroups();
			const results = await Promise.all(
				groups.map(async (group) => {
					const categories = await collectionService.getCategoriesWithCount(
						group.id,
					);
					const categoriesWithGames = await Promise.all(
						categories.map(async (cat) => {
							// 复用 useCategoryGameIds 的缓存 Key
							const gameIds = await queryClient.fetchQuery({
								queryKey: collectionKeys.games(cat.id),
								queryFn: () => collectionService.getGamesInCollection(cat.id),
								staleTime: 1000 * 60 * 5,
							});
							return { ...cat, gameIds, parent_id: group.id };
						}),
					);
					return { ...group, categories: categoriesWithGames };
				}),
			);
			return results;
		},
		enabled: open,
		staleTime: 1000 * 60, // 1分钟内不重复请求
	});

	// 从缓存获取分类游戏 ID（未经 NSFW 筛选的完整列表）
	const categoryGameIds = useMemo(() => {
		return categoryGameIdsQuery.data || [];
	}, [categoryGameIdsQuery.data]);

	// 对话框状态
	const [leftSearchInput, setLeftSearchInput] = useState(""); // 左栏搜索输入
	const [rightSearchInput, setRightSearchInput] = useState(""); // 右栏搜索输入
	const [filterMode, setFilterMode] = useState<FilterMode>("group"); // 筛选模式

	// 防抖后的搜索值（300ms 延迟）
	const leftSearchText = useDebouncedValue(leftSearchInput, 300);
	const rightSearchText = useDebouncedValue(rightSearchInput, 300);
	const [leftPage, setLeftPage] = useState(1); // 左栏页码
	const [rightPage, setRightPage] = useState(1); // 右栏页码
	const [gamesInCategory, setGamesInCategory] = useState<Set<number>>(
		new Set(),
	); // 当前分类中的游戏ID本地 Snapshot
	const [isProcessing, setIsProcessing] = useState(false);

	// 初始化：加载分类游戏
	useEffect(() => {
		if (open) {
			setLeftSearchInput("");
			setRightSearchInput("");
			setFilterMode("group");
			setLeftPage(1);
			setRightPage(1);
		}
	}, [open]);

	// 同步分类游戏到本地状态
	useEffect(() => {
		if (open) {
			setGamesInCategory(new Set(categoryGameIds));
		}
	}, [open, categoryGameIds]);

	/**
	 * 核心逻辑：计算已分配的游戏 ID 集合
	 * [PROTECTED LOGIC]: 必须区分 Group 与 Category，必须排除虚拟分类。
	 */
	const assignedData = useMemo(() => {
		if (!allUserCollectionsQuery.data)
			return { groupIds: new Set<number>(), allIds: new Set<number>() };

		const groupIds = new Set<number>();
		const allIds = new Set<number>();

		// 找到当前 categoryId 所属的 groupId
		let currentGroupId: number | null = null;
		for (const group of allUserCollectionsQuery.data) {
			if (group.categories.some((cat) => cat.id === categoryId)) {
				currentGroupId = group.id;
				break;
			}
		}

		// 遍历所有分组和分类进行汇总
		for (const group of allUserCollectionsQuery.data) {
			for (const cat of group.categories) {
				// 仅处理真实分类 (categoryId > 0 && parent_id !== null)
				if (cat.id <= 0 || cat.parent_id === null) continue;

				// 如果是当前正在编辑的分类，跳过数据库数据，后面会用本地 gamesInCategory 覆盖
				if (cat.id === categoryId) continue;

				const gameIds = cat.gameIds || [];
				for (const gid of gameIds) {
					allIds.add(gid);
					if (group.id === currentGroupId) {
						groupIds.add(gid);
					}
				}
			}
		}

		return { groupIds, allIds };
	}, [allUserCollectionsQuery.data, categoryId]);

	// 左栏过滤基础集合 (除当前分类外的分配情况)
	const assignedExcludingCurrent = useMemo(() => {
		if (filterMode === "group") return assignedData.groupIds;
		if (filterMode === "all") return assignedData.allIds;
		return new Set<number>();
	}, [filterMode, assignedData]);

	// 左栏：根据模式筛选可用游戏
	const availableGames = useMemo(() => {
		return displayAllGames.filter((game) => {
			// 1. 永远排除当前正在右栏的游戏 (本地 Snapshot 实时反馈)
			if (gamesInCategory.has(game.id)) return false;

			// 2. 根据模式排除其他分类的游戏 (数据库 Snapshot)
			if (filterMode !== "none" && assignedExcludingCurrent.has(game.id)) {
				return false;
			}

			return true;
		});
	}, [displayAllGames, gamesInCategory, filterMode, assignedExcludingCurrent]);
	const availableSearchIndex = useMemo(
		() => createSearchIndex(availableGames),
		[availableGames],
	);

	// 右栏：已在分类中的游戏
	const categoryGamesList = useMemo(() => {
		return displayAllGames.filter((game) => gamesInCategory.has(game.id));
	}, [displayAllGames, gamesInCategory]);
	const categorySearchIndex = useMemo(
		() => createSearchIndex(categoryGamesList),
		[categoryGamesList],
	);

	// 左栏搜索过滤
	const filteredAvailableGames = useMemo(() => {
		if (!leftSearchText) return availableGames;

		const searchResults = searchWithIndex(
			availableSearchIndex,
			leftSearchText,
			{
				limit: availableGames.length,
			},
		);

		return searchResults.map((result) => result.item);
	}, [availableGames, availableSearchIndex, leftSearchText]);

	// 右栏搜索过滤
	const filteredCategoryGames = useMemo(() => {
		if (!rightSearchText) return categoryGamesList;

		const searchResults = searchWithIndex(
			categorySearchIndex,
			rightSearchText,
			{
				limit: categoryGamesList.length,
			},
		);

		return searchResults.map((result) => result.item);
	}, [categoryGamesList, categorySearchIndex, rightSearchText]);

	// 左栏分页数据
	const paginatedAvailableGames = useMemo(() => {
		const startIndex = (leftPage - 1) * GAMES_PER_PAGE;
		const endIndex = startIndex + GAMES_PER_PAGE;
		return filteredAvailableGames.slice(startIndex, endIndex);
	}, [filteredAvailableGames, leftPage]);

	// 右栏分页数据
	const paginatedCategoryGames = useMemo(() => {
		const startIndex = (rightPage - 1) * GAMES_PER_PAGE;
		const endIndex = startIndex + GAMES_PER_PAGE;
		return filteredCategoryGames.slice(startIndex, endIndex);
	}, [filteredCategoryGames, rightPage]);

	// 计算总页数
	const leftTotalPages = Math.ceil(
		filteredAvailableGames.length / GAMES_PER_PAGE,
	);
	const rightTotalPages = Math.ceil(
		filteredCategoryGames.length / GAMES_PER_PAGE,
	);

	/**
	 * 游戏列表项组件 - 使用 React.memo 优化
	 */
	const GameListItem = React.memo<{
		game: GameData;
		checked: boolean;
		onClick: (gameId: number) => void;
	}>(({ game, checked, onClick }) => {
		const gameId = game.id;

		return (
			<ListItem disablePadding>
				<ListItemButton onClick={() => onClick(gameId)} dense>
					<Checkbox
						checked={checked}
						tabIndex={-1}
						disableRipple
						size="small"
					/>
					<ListItemText
						primary={getGameDisplayName(game)}
						primaryTypographyProps={{ variant: "body2" }}
					/>
				</ListItemButton>
			</ListItem>
		);
	});

	GameListItem.displayName = "GameListItem";

	/**
	 * 添加游戏到分类（左栏点击 → 移到右栏）
	 */
	const handleAddGameToCategory = useCallback((gameId: number) => {
		setGamesInCategory((prev) => {
			const newSet = new Set(prev);
			newSet.add(gameId);
			return newSet;
		});
	}, []);

	/**
	 * 从分类移除游戏（右栏点击 → 移到左栏）
	 */
	const handleRemoveGameFromCategory = useCallback((gameId: number) => {
		setGamesInCategory((prev) => {
			const newSet = new Set(prev);
			newSet.delete(gameId);
			return newSet;
		});
	}, []);

	/**
	 * 保存游戏变更
	 */
	const handleSaveGamesChanges = async () => {
		if (categoryId < 0) {
			console.warn("无法修改虚拟分类");
			snackbar.warning(
				t(
					"components.Collection.errors.cannotModifyVirtualCategory",
					"无法修改虚拟分类",
				),
			);
			return;
		}

		setIsProcessing(true);
		// 保存原始状态以便回滚
		const originalGamesInCategory = new Set(gamesInCategory);

		try {
			// 将当前分类中的游戏列表完全替换为 gamesInCategory
			const gameIdsArray = Array.from(gamesInCategory);
			await updateCategoryGamesMutation.mutateAsync({
				categoryId,
				gameIds: gameIdsArray,
			});

			// 成功提示
			snackbar.success(
				t("components.Collection.success.categoryGamesUpdated", {
					count: gameIdsArray.length,
					defaultValue: `已更新分类游戏：${gameIdsArray.length} 个`,
				}),
			);

			// 关闭对话框
			onClose();
		} catch (error) {
			console.error("修改分类游戏失败:", error);

			// 回滚到原始状态
			setGamesInCategory(originalGamesInCategory);

			// 错误提示
			snackbar.error(
				t("components.Collection.errors.updateCategoryGamesFailed", {
					defaultValue: "更新分类游戏失败，请重试",
				}),
			);
		} finally {
			setIsProcessing(false);
		}
	};

	return (
		<Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
			<DialogTitle>
				<Box display="flex" alignItems="center" justifyContent="space-between">
					<Typography variant="h6">
						{categoryName
							? `${t("components.Toolbar.Category.manageGamesTitle", "管理分类游戏")} - ${categoryName}`
							: t(
									"components.Toolbar.Category.manageGamesTitle",
									"管理分类游戏",
								)}
					</Typography>
					<Box display="flex" alignItems="center" gap={1}>
						<FilterListIcon fontSize="small" color="action" />
						<Select
							size="small"
							value={filterMode}
							onChange={(e) => setFilterMode(e.target.value as FilterMode)}
							sx={{ minWidth: 160, height: 32, fontSize: "0.875rem" }}
						>
							<MenuItem value="none">
								{t("components.Toolbar.Category.filterNone", "显示全部可用")}
							</MenuItem>
							<MenuItem value="group">
								{t("components.Toolbar.Category.filterGroup", "排除当前分组")}
							</MenuItem>
							<MenuItem value="all">
								{t("components.Toolbar.Category.filterAll", "排除全部分类")}
							</MenuItem>
						</Select>
						<IconButton onClick={onClose} size="small" sx={{ ml: 1 }}>
							<FilterListIcon sx={{ display: "none" }} /> {/* 仅占位 */}
							<span style={{ fontSize: "1.25rem", lineHeight: 1 }}>×</span>
						</IconButton>
					</Box>
				</Box>
			</DialogTitle>
			<DialogContent>
				{/* 双栏穿梭框布局 */}
				<Box display="flex" gap={3} alignItems="stretch" minHeight={500}>
					{/* 左栏：可用游戏 */}
					<Paper
						elevation={2}
						sx={{ flex: 1, display: "flex", flexDirection: "column", p: 2 }}
					>
						<Typography variant="subtitle1" gutterBottom fontWeight="bold">
							{t("components.Toolbar.Category.availableGames", "可用游戏")} (
							{availableGames.length})
						</Typography>

						{/* 左栏搜索框 */}
						<TextField
							autoFocus
							fullWidth
							size="small"
							placeholder={t(
								"components.Toolbar.Category.searchPlaceholder",
								"搜索游戏...",
							)}
							value={leftSearchInput}
							onChange={(e) => {
								setLeftSearchInput(e.target.value);
								setLeftPage(1); // 搜索时重置到第一页
							}}
							InputProps={{
								startAdornment: (
									<SearchIcon sx={{ mr: 1, color: "action.active" }} />
								),
							}}
							sx={{ mb: 2 }}
						/>

						{/* 左栏游戏列表 */}
						<Box
							sx={{
								flex: 1,
								overflow: "auto",
								border: "1px solid",
								borderColor: "divider",
								borderRadius: 1,
								minHeight: 0, // 防止 flex 子元素撑开父容器
							}}
						>
							{filteredAvailableGames.length === 0 ? (
								<Typography
									variant="body2"
									color="text.secondary"
									textAlign="center"
									py={3}
								>
									{leftSearchText
										? t(
												"components.Toolbar.Category.noSearchResults",
												"未找到匹配的游戏",
											)
										: t("components.Toolbar.Category.noGames", "暂无游戏")}
								</Typography>
							) : (
								<List dense>
									{paginatedAvailableGames.map((game) => (
										<GameListItem
											key={game.id}
											game={game}
											checked={false}
											onClick={handleAddGameToCategory}
										/>
									))}
								</List>
							)}
						</Box>

						{/* 左栏分页 */}
						{leftTotalPages > 1 && (
							<Box display="flex" justifyContent="center" mt={2}>
								<Pagination
									count={leftTotalPages}
									page={leftPage}
									onChange={(_, page) => setLeftPage(page)}
									size="small"
									color="primary"
								/>
							</Box>
						)}

						{/* 左栏统计 */}
						<Typography variant="caption" color="text.secondary" mt={1}>
							共 {filteredAvailableGames.length} 个游戏
						</Typography>
					</Paper>

					{/* 右栏：分类中的游戏 */}
					<Paper
						elevation={2}
						sx={{ flex: 1, display: "flex", flexDirection: "column", p: 2 }}
					>
						<Typography variant="subtitle1" gutterBottom fontWeight="bold">
							{t("components.Toolbar.Category.gamesInCategory", "分类中的游戏")}{" "}
							({categoryGamesList.length})
						</Typography>

						{/* 右栏搜索框 */}
						<TextField
							fullWidth
							size="small"
							placeholder={t(
								"components.Toolbar.Category.searchPlaceholder",
								"搜索游戏...",
							)}
							value={rightSearchInput}
							onChange={(e) => {
								setRightSearchInput(e.target.value);
								setRightPage(1); // 搜索时重置到第一页
							}}
							InputProps={{
								startAdornment: (
									<SearchIcon sx={{ mr: 1, color: "action.active" }} />
								),
							}}
							sx={{ mb: 2 }}
						/>

						{/* 右栏游戏列表 */}
						<Box
							sx={{
								flex: 1,
								overflow: "auto",
								border: "1px solid",
								borderColor: "divider",
								borderRadius: 1,
								minHeight: 0, // 防止 flex 子元素撑开父容器
							}}
						>
							{filteredCategoryGames.length === 0 ? (
								<Typography
									variant="body2"
									color="text.secondary"
									textAlign="center"
									py={3}
								>
									{rightSearchText
										? t(
												"components.Toolbar.Category.noSearchResults",
												"未找到匹配的游戏",
											)
										: t(
												"components.Toolbar.Category.noGamesInCategory",
												"该分类暂无游戏",
											)}
								</Typography>
							) : (
								<List dense>
									{paginatedCategoryGames.map((game) => (
										<GameListItem
											key={game.id}
											game={game}
											checked={true}
											onClick={handleRemoveGameFromCategory}
										/>
									))}
								</List>
							)}
						</Box>

						{/* 右栏分页 */}
						{rightTotalPages > 1 && (
							<Box display="flex" justifyContent="center" mt={2}>
								<Pagination
									count={rightTotalPages}
									page={rightPage}
									onChange={(_, page) => setRightPage(page)}
									size="small"
									color="primary"
								/>
							</Box>
						)}

						{/* 右栏统计 */}
						<Typography variant="caption" color="text.secondary" mt={1}>
							共 {filteredCategoryGames.length} 个游戏
						</Typography>
					</Paper>
				</Box>
			</DialogContent>

			{/* 底部按钮 */}
			<DialogActions sx={{ px: 3, pb: 2 }}>
				<Button onClick={onClose} disabled={isProcessing}>
					{t("common.cancel", "取消")}
				</Button>
				<Button
					variant="contained"
					onClick={handleSaveGamesChanges}
					disabled={isProcessing}
				>
					{isProcessing
						? t("common.saving", "保存中...")
						: t("components.Toolbar.Category.save", "保存更改")}
				</Button>
			</DialogActions>
		</Dialog>
	);
};
