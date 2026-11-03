import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DriveFileMoveRoundedIcon from "@mui/icons-material/DriveFileMoveRounded";
import FilterAltRoundedIcon from "@mui/icons-material/FilterAltRounded";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import LibraryAddCheckRoundedIcon from "@mui/icons-material/LibraryAddCheckRounded";
import SearchIcon from "@mui/icons-material/Search";
import {
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Box,
	InputAdornment,
	Menu,
	MenuItem,
	Stack,
	TextField,
	Typography,
} from "@mui/material";
import type { MouseEvent } from "react";
import { open as chooseDirectory } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { ToolbarIconAction } from "./ToolbarIconAction";
import {
	MAIN_SEARCH_BOX_WIDTH,
	MAIN_SEARCH_FIELD_SX,
} from "@/components/SearchBox";
import { snackbar } from "@/providers/snackBar/snackBar";
import {
	appLauncherService,
	type AppLauncherCandidate,
} from "@/services/invoke/appLauncherService";
import { useAppLauncherStore } from "@/store/appLauncherStore";

export function ApplicationsToolbar() {
	const categories = useAppLauncherStore((state) => state.categories);
	const sortMode = useAppLauncherStore((state) => state.sortMode);
	const setSortMode = useAppLauncherStore((state) => state.setSortMode);
	const selectionMode = useAppLauncherStore((state) => state.selectionMode);
	const selectedIds = useAppLauncherStore((state) => state.selectedIds);
	const startSelecting = useAppLauncherStore((state) => state.startSelecting);
	const stopSelecting = useAppLauncherStore((state) => state.stopSelecting);
	const updateCategories = useAppLauncherStore((state) => state.updateCategories);
	const removeItems = useAppLauncherStore((state) => state.removeItems);
	const importCandidates = useAppLauncherStore((state) => state.importCandidates);
	const sourceFolders = useAppLauncherStore((state) => state.sourceFolders);
	const addCategory = useAppLauncherStore((state) => state.addCategory);
	const [pending, setPending] = useState<AppLauncherCandidate[]>([]);
	const [importOpen, setImportOpen] = useState(false);
	const [importCategoryId, setImportCategoryId] = useState("uncategorized");
	const [batchCategoryId, setBatchCategoryId] = useState("uncategorized");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [newCategoryOpen, setNewCategoryOpen] = useState(false);
	const [categoryName, setCategoryName] = useState("");
	const [sortMenuAnchor, setSortMenuAnchor] = useState<HTMLElement | null>(null);
	const [importSourceId, setImportSourceId] = useState("");
	const [isSavingImportedItems, setIsSavingImportedItems] = useState(false);
	const importSources = useMemo(
		() => sourceFolders.filter((source) => source.categoryId === importCategoryId),
		[sourceFolders, importCategoryId],
	);

	useEffect(() => {
		setImportSourceId((current) => importSources.some((source) => source.id === current) ? current : (importSources[0]?.id ?? ""));
	}, [importSources]);

	const chooseAndPreview = async () => {
		const folder = await chooseDirectory({ directory: true, multiple: false, title: "选择应用快捷方式目录" });
		if (!folder || Array.isArray(folder)) return;
		try {
			const candidates = await appLauncherService.scanFolder(folder);
			if (!candidates.length) {
				snackbar.info("此目录没有可导入的 .lnk、.url 或 .exe 文件");
				return;
			}
			setPending(candidates);
			setImportCategoryId("uncategorized");
			setImportOpen(true);
		} catch (error) {
			snackbar.error(error instanceof Error ? error.message : "读取应用目录失败");
		}
	};

	const confirmImport = async () => {
		if (isSavingImportedItems) return;
		setIsSavingImportedItems(true);
		try {
			const source = sourceFolders.find((item) => item.id === importSourceId);
			const results = await Promise.allSettled(pending.map((candidate) => {
				if (!source) return Promise.resolve(candidate);
				return candidate.kind === "executable"
					? appLauncherService.createShortcut(candidate.path, source.path)
					: appLauncherService.copyItemToSource(candidate.path, source.path);
			}));
			const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
			const count = importCandidates(successful, importCategoryId);
			const failed = results.length - successful.length;
			setImportOpen(false);
			if (failed) snackbar.info(`已加入 ${count} 个应用；${failed} 项未写入，未覆盖原文件`);
			else snackbar.success(source ? `已写入来源目录并加入 ${count} 个应用` : `已引用并加入 ${count} 个应用`);
		} finally {
			setIsSavingImportedItems(false);
		}
	};

	const applyBatchCategory = () => {
		updateCategories(selectedIds, batchCategoryId);
		snackbar.success(`已移动 ${selectedIds.length} 个应用`);
		stopSelecting();
	};
	const createCategory = () => {
		if (!categoryName.trim()) return;
		addCategory(categoryName);
		setCategoryName("");
		setNewCategoryOpen(false);
	};

	return (
		<>
			{selectionMode ? (
				<Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
					<Typography variant="body2" color="text.secondary">已选 {selectedIds.length} 项</Typography>
					<TextField select size="small" value={batchCategoryId} onChange={(event) => setBatchCategoryId(event.target.value)} sx={{ minWidth: 120 }}>
						{categories.map((category) => <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>)}
					</TextField>
					<ToolbarIconAction label="移动已选应用" disabled={!selectedIds.length} onClick={applyBatchCategory}><DriveFileMoveRoundedIcon /></ToolbarIconAction>
					<ToolbarIconAction label="移除已选应用" color="error" disabled={!selectedIds.length} onClick={() => setDeleteOpen(true)}><DeleteOutlineRoundedIcon /></ToolbarIconAction>
					<ToolbarIconAction label="退出批量操作" onClick={stopSelecting}><CloseRoundedIcon /></ToolbarIconAction>
				</Stack>
			) : (
				<Stack direction="row" spacing={0.5} alignItems="center" sx={{ "& > *": { flex: "0 0 36px" } }}>
					<ToolbarIconAction label="新建分类" onClick={() => setNewCategoryOpen(true)}><FolderOutlinedIcon /></ToolbarIconAction>
					<ToolbarIconAction label="导入目录" onClick={() => void chooseAndPreview()}><AddRoundedIcon /></ToolbarIconAction>
					<ToolbarIconAction label={`排序：${sortMode === "custom" ? "自定义" : "默认"}`} active={sortMode === "custom"} onClick={(event: MouseEvent<HTMLButtonElement>) => setSortMenuAnchor(event.currentTarget)}><FilterAltRoundedIcon /></ToolbarIconAction>
					<ToolbarIconAction label="批量操作" onClick={startSelecting}><LibraryAddCheckRoundedIcon /></ToolbarIconAction>
				</Stack>
			)}
			<Menu anchorEl={sortMenuAnchor} open={Boolean(sortMenuAnchor)} onClose={() => setSortMenuAnchor(null)}>
				<MenuItem selected={sortMode === "default"} onClick={() => { setSortMode("default"); setSortMenuAnchor(null); }}>默认排序</MenuItem>
				<MenuItem selected={sortMode === "custom"} onClick={() => { setSortMode("custom"); setSortMenuAnchor(null); }}>自定义排序</MenuItem>
			</Menu>

			<Dialog open={importOpen} onClose={() => setImportOpen(false)} maxWidth="md" fullWidth>
				<DialogTitle>导入应用</DialogTitle>
				<DialogContent dividers>
					<Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} spacing={1} mb={1.25}>
						<Typography variant="body2" color="text.secondary">找到 {pending.length} 个可用项。配置来源目录后会复制 .lnk/.url 或为 .exe 创建不覆盖的快捷方式；否则只引用原文件。</Typography>
						<TextField select size="small" label="导入到分类" value={importCategoryId} onChange={(event) => setImportCategoryId(event.target.value)} sx={{ minWidth: 145 }}>
							{categories.map((category) => <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>)}
						</TextField>
						{importSources.length > 0 && <TextField select size="small" label="写入来源目录" value={importSourceId} onChange={(event) => setImportSourceId(event.target.value)} sx={{ minWidth: 180 }}>
							{importSources.map((source) => <MenuItem key={source.id} value={source.id}>{source.path}</MenuItem>)}
						</TextField>}
					</Stack>
					<Stack spacing={0.5} sx={{ maxHeight: 360, overflowY: "auto", pr: 0.5 }}>
						{pending.map((candidate) => <Typography key={candidate.path} variant="body2" noWrap title={candidate.path}>{candidate.name}</Typography>)}
					</Stack>
				</DialogContent>
				<DialogActions><Button disabled={isSavingImportedItems} onClick={() => setImportOpen(false)}>取消</Button><Button variant="contained" disabled={isSavingImportedItems} onClick={() => void confirmImport()}>{isSavingImportedItems ? "导入中…" : "确认导入"}</Button></DialogActions>
			</Dialog>

			<Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} maxWidth="xs" fullWidth>
				<DialogTitle>从应用页移除</DialogTitle>
				<DialogContent><Typography variant="body2">将移除已选 {selectedIds.length} 个应用的本地记录，不会删除真实文件或快捷方式。</Typography></DialogContent>
				<DialogActions><Button onClick={() => setDeleteOpen(false)}>取消</Button><Button color="error" variant="contained" onClick={() => { removeItems(selectedIds); setDeleteOpen(false); stopSelecting(); snackbar.success("已从应用页移除"); }}>确认移除</Button></DialogActions>
			</Dialog>

			<Dialog open={newCategoryOpen} onClose={() => setNewCategoryOpen(false)} maxWidth="xs" fullWidth>
				<DialogTitle>新建分类</DialogTitle>
				<DialogContent><TextField autoFocus fullWidth size="small" label="分类名称" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") createCategory(); }} /></DialogContent>
				<DialogActions><Button onClick={() => setNewCategoryOpen(false)}>取消</Button><Button variant="contained" onClick={createCategory}>创建</Button></DialogActions>
			</Dialog>
		</>
	);
}

export function ApplicationsSearchBox() {
	const query = useAppLauncherStore((state) => state.query);
	const setQuery = useAppLauncherStore((state) => state.setQuery);
	return (
		<Box sx={{ width: MAIN_SEARCH_BOX_WIDTH }}>
			<TextField
				fullWidth
				size="small"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder="搜索"
				sx={[
					MAIN_SEARCH_FIELD_SX,
					{
						"& .MuiInputAdornment-positionStart": {
							marginRight: "14px",
						},
						"& .MuiOutlinedInput-root": {
							paddingLeft: "6px",
						},
					},
				]}
				slotProps={{
					input: {
						startAdornment: (
							<InputAdornment position="start">
								<SearchIcon fontSize="small" />
							</InputAdornment>
						),
					},
				}}
			/>
		</Box>
	);
}
