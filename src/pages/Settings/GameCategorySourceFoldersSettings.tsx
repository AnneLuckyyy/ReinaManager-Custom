import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import { useQueries } from "@tanstack/react-query";
import { Button, IconButton, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { SettingsHelp } from "@/components/SettingsHelp";
import { useGroups, collectionKeys } from "@/hooks/queries/useCollections";
import { snackbar } from "@/providers/snackBar/snackBar";
import { collectionService } from "@/services/invoke";
import { useModStore } from "@/store/modStore";
import { handleGetFolder } from "@/utils/appUtils";

/** 游戏分类来源目录只在成功导入后补充收藏夹归属，不扫描、移动或监听磁盘文件。 */
export function GameCategorySourceFoldersSettings() {
	const sources = useModStore((state) => state.gameCategorySourceFolders);
	const addSource = useModStore((state) => state.addGameCategorySourceFolder);
	const removeSource = useModStore((state) => state.removeGameCategorySourceFolder);
	const { data: groups = [] } = useGroups();
	const categoryQueries = useQueries({
		queries: groups.map((group) => ({
			queryKey: collectionKeys.categories(String(group.id)),
			queryFn: () => collectionService.getCategoriesWithCount(group.id),
		})),
	});
	const categories = useMemo(
		() => categoryQueries.flatMap((query, index) =>
			(query.data ?? []).map((category) => ({
				...category,
				groupName: groups[index]?.name ?? "",
			})),
		),
		[categoryQueries, groups],
	);
	const [categoryId, setCategoryId] = useState("");

	useEffect(() => {
		if (!categoryId && categories[0]) setCategoryId(String(categories[0].id));
	}, [categories, categoryId]);

	const categoryLabels = useMemo(
		() => new Map(categories.map((category) => [category.id, `${category.groupName} / ${category.name}`])),
		[categories],
	);

	const chooseSource = async () => {
		const path = await handleGetFolder();
		if (!path) return;
		if (!addSource(path, Number(categoryId))) {
			snackbar.info("该游戏分类来源目录已存在，或分类不可用");
		}
	};

	return (
		<Stack spacing={1.25}>
			<Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="flex-start" spacing={1.5}>
				<Stack direction="row" alignItems="center" sx={{ width: { sm: 250 }, flexShrink: 0 }}>
					<Typography variant="subtitle1" className="font-semibold">游戏分类来源目录</Typography>
					<SettingsHelp text="导入的游戏启动文件位于这里或其子目录时，成功入库后会加入指定收藏夹分类。重叠目录只采用更深的一项；不会扫描、监听、移动或删除文件。" />
				</Stack>
				<Stack direction="row" spacing={1}>
					<TextField select size="small" label="加入分类" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} sx={{ minWidth: 180 }} disabled={!categories.length}>
						{categories.map((category) => <MenuItem key={category.id} value={String(category.id)}>{category.groupName} / {category.name}</MenuItem>)}
					</TextField>
					<Button variant="outlined" startIcon={<FolderOpenRoundedIcon />} disabled={!categoryId} onClick={() => void chooseSource()}>添加来源目录</Button>
				</Stack>
			</Stack>
			{sources.length === 0 ? (
				<Typography variant="body2" color="text.secondary">未设置游戏分类来源目录；导入行为和原来一致。</Typography>
			) : (
				<Stack spacing={0.5}>
					{sources.map((source) => (
						<Stack key={source.id} direction="row" alignItems="center" spacing={1} sx={{ minHeight: 36, px: 1, borderRadius: 1.5, bgcolor: "action.hover" }}>
							<Typography variant="body2" noWrap title={source.path} sx={{ flex: 1 }}>{source.path}</Typography>
							<Typography variant="caption" color={categoryLabels.has(source.categoryId) ? "text.secondary" : "error.main"}>{categoryLabels.get(source.categoryId) ?? "分类已删除"}</Typography>
							<IconButton size="small" aria-label="移除游戏分类来源目录" onClick={() => removeSource(source.id)}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton>
						</Stack>
					))}
				</Stack>
			)}
		</Stack>
	);
}
