import {
	Box,
	List,
	ListItem,
	ListItemButton,
	ListItemText,
	Tooltip,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { useNavigate } from "react-router-dom";
import { useVirtualCategories } from "@/hooks/common/useVirtualCollections";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import { collectionService } from "@/services/invoke";
import { useStore } from "@/store/appStore";
import { useModStore } from "@/store/modStore";

/**
 * PinnedSidebarList 组件
 * 独立于 Toolpad Navigation 树，渲染在 Sidebar Footer 区域。
 * 纯 Store 驱动，不修改 URL 路径。
 */
export const PinnedSidebarList: React.FC<{ mini?: boolean }> = ({ mini = false }) => {
	const navigate = useNavigate();

	const { setCurrentGroup, setSelectedCategory, currentGroupId, selectedCategoryId } = useStore();
	const pinnedFolders = useModStore((state) => state.pinnedFolders);
	
	const { index: gameIndex } = useGameIndex();
	const virtualCategories = useVirtualCategories(gameIndex);

	// 获取全量分类树状数据（仅在有 Pinned 项时有效，利用缓存）
	const allCategoriesQuery = useQuery({
		queryKey: ["collections", "all_categories_flat"],
		queryFn: async () => {
			const groups = await collectionService.getGroups();
			const allCats = await Promise.all(
				groups.map(async (group) => {
					const categories = await collectionService.getCategoriesWithCount(group.id);
					return categories.map(c => ({ ...c, groupId: group.id.toString() }));
				})
			);
			return allCats.flat();
		},
		enabled: pinnedFolders.length > 0,
		staleTime: 1000 * 60 * 5, // 5分钟缓存
	});

	if (pinnedFolders.length === 0) {
		return null;
	}

	return (
		<Box sx={{ pb: 1 }}>
			<List disablePadding>
				{pinnedFolders.map((item) => {
					// 1. 运行时名称动态解析
					let name = `${item.categoryId}`;
					
					if (item.type === "category" && item.categoryId !== undefined) {
						// 优先从虚拟分类获取
						const virtualName = virtualCategories.getVirtualCategoryName(item.categoryId, null);
						if (virtualName) {
							name = virtualName;
						} else {
							// 其次从真实分类缓存中查找
							const realCat = allCategoriesQuery.data?.find(
								c => c.id === item.categoryId && c.groupId === item.groupId
							);
							if (realCat) {
								name = realCat.name;
							}
						}
					}

					const isSelected = 
						selectedCategoryId === item.categoryId && 
						currentGroupId === item.groupId;

					return (
						<ListItem key={`${item.groupId}-${item.categoryId}`} disablePadding>
							<Tooltip title={mini ? name : ""} placement="right" arrow>
								<ListItemButton
									aria-label={name}
									selected={isSelected}
									onClick={() => {
										setCurrentGroup(item.groupId);
										if (item.categoryId !== undefined) {
											setSelectedCategory(item.categoryId);
										}
										navigate("/collection");
									}}
									sx={{
										position: "relative",
										py: mini ? 0.25 : 0.5,
										px: mini ? 0.75 : 2,
										minHeight: mini ? 30 : 32,
										"&.Mui-selected": {
											bgcolor: "action.selected",
										},
										...(mini && isSelected ? {
											"&::before": {
												content: '""',
												position: "absolute",
												left: 1,
												top: 6,
												bottom: 6,
												width: 2,
												borderRadius: 1,
												bgcolor: "primary.main",
											},
										} : {}),
									}}
								>
									<ListItemText
										primary={name}
										sx={{ m: 0, minWidth: 0 }}
										primaryTypographyProps={{
											variant: "body2",
											noWrap: mini,
											sx: {
												fontSize: mini ? "0.71875rem" : "0.8125rem",
												lineHeight: mini ? 1.2 : 1.25,
												fontWeight: isSelected ? 600 : 400,
												color: isSelected ? "primary.main" : "text.primary",
												textAlign: "left",
												letterSpacing: mini ? "0.01em" : "normal",
												fontVariantNumeric: mini ? "tabular-nums" : "normal",
												textOverflow: mini ? "clip" : "unset",
												overflowWrap: mini ? "normal" : "anywhere",
												WebkitMaskImage: mini
													? "linear-gradient(to right, #000 0%, #000 calc(100% - 5px), transparent 100%)"
													: "none",
												maskImage: mini
													? "linear-gradient(to right, #000 0%, #000 calc(100% - 5px), transparent 100%)"
													: "none",
											},
										}}
									/>
								</ListItemButton>
							</Tooltip>
						</ListItem>
					);
				})}
			</List>
		</Box>
	);
};
