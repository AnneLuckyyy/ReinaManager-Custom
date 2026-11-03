import AppsRoundedIcon from "@mui/icons-material/AppsRounded";
import CheckBoxOutlineBlankRoundedIcon from "@mui/icons-material/CheckBoxOutlineBlankRounded";
import CheckBoxRoundedIcon from "@mui/icons-material/CheckBoxRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import LaunchRoundedIcon from "@mui/icons-material/LaunchRounded";
import PushPinRoundedIcon from "@mui/icons-material/PushPinRounded";
import RemoveCircleOutlineRoundedIcon from "@mui/icons-material/RemoveCircleOutlineRounded";
import { closestCorners, DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	Box,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Divider,
	Menu,
	MenuItem,
	Stack,
	TextField,
	Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTauriDragDrop } from "@/hooks/common/useTauriDragDrop";
import { snackbar } from "@/providers/snackBar/snackBar";
import { appLauncherService, type AppLauncherCandidate } from "@/services/invoke/appLauncherService";
import { type AppCategory, type AppLauncherItem, useAppLauncherStore } from "@/store/appLauncherStore";
import { useStore } from "@/store/appStore";

type AppIconTarget = Pick<AppLauncherCandidate, "kind" | "name" | "path">;

function AppIcon({ item, icons, size = 30 }: { item: AppIconTarget; icons: Record<string, string>; size?: number }) {
	const icon = icons[item.path];
	if (icon) return <Box aria-hidden component="img" src={icon} alt="" sx={{ width: size, height: size, flex: "0 0 auto", display: "block", objectFit: "contain", borderRadius: 1 }} />;
	return <Box aria-hidden sx={{ width: size, height: size, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: 1, bgcolor: "action.hover" }}><AppsRoundedIcon color="action" sx={{ fontSize: Math.max(18, size * 0.7) }} /></Box>;
}

type DragPlacement = { itemId: string; categoryId: string; beforeId?: string };

export function ApplicationsPage() {
	const categories = useAppLauncherStore((state) => state.categories);
	const items = useAppLauncherStore((state) => state.items);
	const sourceFolders = useAppLauncherStore((state) => state.sourceFolders);
	const query = useAppLauncherStore((state) => state.query);
	const sortMode = useAppLauncherStore((state) => state.sortMode);
	const customOrderByCategory = useAppLauncherStore((state) => state.customOrderByCategory);
	const selectionMode = useAppLauncherStore((state) => state.selectionMode);
	const selectedIds = useAppLauncherStore((state) => state.selectedIds);
	const toggleSelected = useAppLauncherStore((state) => state.toggleSelected);
	const moveItemToPosition = useAppLauncherStore((state) => state.moveItemToPosition);
	const renameItemRecord = useAppLauncherStore((state) => state.renameItem);
	const togglePinned = useAppLauncherStore((state) => state.togglePinned);
	const removeItem = useAppLauncherStore((state) => state.removeItem);
	const renameCategoryRecord = useAppLauncherStore((state) => state.renameCategory);
	const moveCategory = useAppLauncherStore((state) => state.moveCategory);
	const removeCategory = useAppLauncherStore((state) => state.removeCategory);
	const importCandidates = useAppLauncherStore((state) => state.importCandidates);
	const longPressLaunch = useStore((state) => state.longPressLaunch);
	const [selected, setSelected] = useState<AppLauncherItem | null>(null);
	const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
	const [selectedCategory, setSelectedCategory] = useState<AppCategory | null>(null);
	const [categoryMenuPosition, setCategoryMenuPosition] = useState<{ left: number; top: number } | null>(null);
	const [icons, setIcons] = useState<Record<string, string>>({});
	const [deleteCategory, setDeleteCategory] = useState<AppCategory | null>(null);
	const [renameItem, setRenameItem] = useState<AppLauncherItem | null>(null);
	const [itemName, setItemName] = useState("");
	const [renameCategory, setRenameCategory] = useState<AppCategory | null>(null);
	const [categoryName, setCategoryName] = useState("");
	const [activeDragId, setActiveDragId] = useState<string | null>(null);
	const [dragPreview, setDragPreview] = useState<DragPlacement | null>(null);
	const [droppedCandidates, setDroppedCandidates] = useState<AppLauncherCandidate[]>([]);
	const [dropCategoryId, setDropCategoryId] = useState("uncategorized");
	const [dropSourceId, setDropSourceId] = useState("");
	const [isImportingDrop, setIsImportingDrop] = useState(false);

	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visibleItems = useMemo(() => items.filter((item) => !normalizedQuery || item.name.toLocaleLowerCase().includes(normalizedQuery)), [items, normalizedQuery]);
	const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
	const iconPaths = useMemo(() => [...new Set(items.map((item) => item.path))], [items]);
	const pinned = visibleItems.filter((item) => item.pinned).slice(0, 12);
	const activeDragItem = activeDragId ? items.find((item) => item.id === activeDragId) ?? null : null;
	const isCustomSorting = sortMode === "custom" && !selectionMode && !longPressLaunch;
	const dropSources = useMemo(
		() => sourceFolders.filter((source) => source.categoryId === dropCategoryId),
		[sourceFolders, dropCategoryId],
	);
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
	);

	useEffect(() => {
		if (!iconPaths.length) return;
		let active = true;
		void appLauncherService.getIcons(iconPaths).then(
			(result) => active && setIcons((current) => ({ ...current, ...result })),
			() => active && snackbar.info("部分应用图标无法读取，已使用默认图标"),
		);
		return () => { active = false; };
	}, [iconPaths]);

	useEffect(() => {
		setDropSourceId((current) => dropSources.some((source) => source.id === current) ? current : (dropSources[0]?.id ?? ""));
	}, [dropSources]);

	const handleDroppedPaths = useCallback((paths: string[]) => {
		void appLauncherService.resolvePaths(paths).then(
			(candidates) => {
				if (!candidates.length) {
					snackbar.info("未找到可导入的 .lnk、.url 或 .exe 文件");
					return;
				}
				setDroppedCandidates(candidates);
				setDropCategoryId("uncategorized");
			},
			() => snackbar.error("读取拖入的应用项失败"),
		);
	}, []);
	const { isDragging: isDroppingApps } = useTauriDragDrop({ onPathsDropped: handleDroppedPaths });
	const importDroppedCandidates = async () => {
		if (!droppedCandidates.length || isImportingDrop) return;
		setIsImportingDrop(true);
		try {
			const source = sourceFolders.find((item) => item.id === dropSourceId);
			const results = await Promise.allSettled(droppedCandidates.map((candidate) => {
				if (!source) return Promise.resolve(candidate);
				return candidate.kind === "executable"
					? appLauncherService.createShortcut(candidate.path, source.path)
					: appLauncherService.copyItemToSource(candidate.path, source.path);
			}));
			const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
			const count = importCandidates(successful, dropCategoryId);
			const failed = results.length - successful.length;
			if (failed) snackbar.info(`已加入 ${count} 个应用；${failed} 项未写入，原文件未被覆盖`);
			else snackbar.success(source ? `已写入来源目录并加入 ${count} 个应用` : `已引用并加入 ${count} 个应用`);
			setDroppedCandidates([]);
		} finally {
			setIsImportingDrop(false);
		}
	};

	const launch = async (item: AppLauncherItem) => {
		try { await appLauncherService.launch(item.path); }
		catch (error) { snackbar.error(error instanceof Error ? error.message : "启动应用失败"); }
	};
	const openMenu = (event: React.MouseEvent<HTMLElement>, item: AppLauncherItem) => {
		event.preventDefault();
		setSelected(item);
		setMenuPosition({ left: event.clientX, top: event.clientY });
	};
	const openCategoryMenu = (event: React.MouseEvent<HTMLElement>, category: AppCategory) => {
		event.preventDefault();
		setSelectedCategory(category);
		setCategoryMenuPosition({ left: event.clientX, top: event.clientY });
	};
	const selectedCategoryIndex = selectedCategory ? categories.findIndex((category) => category.id === selectedCategory.id) : -1;
	const sortCategoryItems = (categoryId: string) => {
		const categoryItems = visibleItems.filter((item) => item.categoryId === categoryId);
		if (sortMode !== "custom") return categoryItems.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
		const order = customOrderByCategory[categoryId] ?? [];
		const orderIndex = new Map(order.map((id, index) => [id, index]));
		return categoryItems.sort((left, right) => (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.name.localeCompare(right.name, "zh-CN"));
	};
	const getDragPlacement = ({ active, over }: Pick<DragEndEvent, "active" | "over">): DragPlacement | null => {
		if (!over || !isCustomSorting) return null;
		const itemId = String(active.id).replace(/^app:/, "");
		const item = items.find((current) => current.id === itemId);
		if (!item) return null;
		const overId = String(over.id);
		if (overId.startsWith("category:")) return { itemId, categoryId: overId.slice(9) };
		if (!overId.startsWith("app:")) return null;
		const overItem = items.find((current) => current.id === overId.slice(4));
		if (!overItem) return null;
		if (overItem.id === itemId) return dragPreview;
		if (overItem.categoryId === item.categoryId) {
			const sourceItems = sortCategoryItems(item.categoryId);
			const activeIndex = sourceItems.findIndex((current) => current.id === itemId);
			const overIndex = sourceItems.findIndex((current) => current.id === overItem.id);
			if (activeIndex < 0 || overIndex < 0) return null;
			const reordered = arrayMove(sourceItems, activeIndex, overIndex);
			return { itemId, categoryId: item.categoryId, beforeId: reordered[overIndex + 1]?.id };
		}
		const targetItems = sortCategoryItems(overItem.categoryId).filter((current) => current.id !== itemId);
		const overIndex = targetItems.findIndex((current) => current.id === overItem.id);
		if (overIndex < 0) return null;
		const activeRect = active.rect.current.translated;
		const activeCenter = activeRect ? activeRect.top + activeRect.height / 2 : over.rect.top;
		const overCenter = over.rect.top + over.rect.height / 2;
		const insertAfter = activeCenter > overCenter;
		return { itemId, categoryId: overItem.categoryId, beforeId: insertAfter ? targetItems[overIndex + 1]?.id : overItem.id };
	};
	const getDisplayCategoryItems = (categoryId: string) => {
		const categoryItems = sortCategoryItems(categoryId);
		if (!dragPreview || !activeDragItem) return categoryItems;
		const withoutActive = categoryItems.filter((item) => item.id !== dragPreview.itemId);
		if (dragPreview.categoryId !== categoryId) return withoutActive;
		const insertionIndex = dragPreview.beforeId ? withoutActive.findIndex((item) => item.id === dragPreview.beforeId) : -1;
		const next = [...withoutActive];
		next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, activeDragItem);
		return next;
	};
	const handleDragStart = ({ active }: DragStartEvent) => {
		setActiveDragId(String(active.id).replace(/^app:/, ""));
	};
	const updateDragPreview = (event: DragOverEvent | DragMoveEvent) => {
		const next = getDragPlacement(event);
		setDragPreview((current) => current?.itemId === next?.itemId && current?.categoryId === next?.categoryId && current?.beforeId === next?.beforeId ? current : next);
	};
	const handleDragOver = (event: DragOverEvent) => updateDragPreview(event);
	const handleDragMove = (event: DragMoveEvent) => updateDragPreview(event);
	const clearDrag = () => { setActiveDragId(null); setDragPreview(null); };
	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		const placement = getDragPlacement({ active, over });
		if (placement) moveItemToPosition(placement.itemId, placement.categoryId, placement.beforeId);
		clearDrag();
	};

	return <Box sx={{ px: { xs: 2, md: 3 }, py: { xs: 0.7, md: 0.85 }, width: "100%", position: "relative" }}>
		{isDroppingApps && <Box sx={{ position: "absolute", inset: 8, zIndex: 3, display: "grid", placeItems: "center", border: "2px dashed", borderColor: "primary.main", borderRadius: 2, bgcolor: "background.paper", opacity: 0.92 }}><Typography color="primary" fontWeight={700}>松开以导入应用</Typography></Box>}
		{items.length === 0 ? <EmptyAppsState /> : <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragMove={handleDragMove} onDragCancel={clearDrag} onDragEnd={handleDragEnd}><Box sx={{ overflowX: "auto", overflowY: "hidden", pb: 0.5 }}><Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.75, width: "max-content", minWidth: "100%" }}>
			{pinned.length > 0 && <CategoryColumn name="常用" count={pinned.length} color="primary.main" width={categoryColumnWidth(pinned)}>
				{pinned.map((item) => <CompactAppItem key={`pinned-${item.id}`} item={item} icons={icons} selectionMode={selectionMode} checked={selectedIdSet.has(item.id)} onSelect={toggleSelected} onLaunch={launch} onMenu={openMenu} longPressLaunch={longPressLaunch} pinned />)}
			</CategoryColumn>}
			{categories.map((category) => {
				const categoryItems = getDisplayCategoryItems(category.id);
				if (!categoryItems.length) return null;
				return <CategoryColumn key={category.id} name={category.name} count={categoryItems.length} color={category.color} width={categoryColumnWidth(categoryItems)} onContextMenu={(event) => openCategoryMenu(event, category)} dropId={`category:${category.id}`} sortable={isCustomSorting} previewTarget={dragPreview?.categoryId === category.id}>
					<SortableContext items={categoryItems.map((item) => `app:${item.id}`)} strategy={verticalListSortingStrategy}>{categoryItems.map((item) => <SortableAppItem key={item.id} item={item} icons={icons} selectionMode={selectionMode} checked={selectedIdSet.has(item.id)} onSelect={toggleSelected} onLaunch={launch} onMenu={openMenu} longPressLaunch={isCustomSorting ? false : longPressLaunch} sortable={isCustomSorting} />)}</SortableContext>
				</CategoryColumn>;
			})}
		</Box></Box><DragOverlay dropAnimation={null}>{activeDragItem && <DragPreviewItem item={activeDragItem} icons={icons} />}</DragOverlay></DndContext>}

		<Menu anchorReference="anchorPosition" anchorPosition={menuPosition ?? undefined} open={Boolean(menuPosition)} onClose={() => setMenuPosition(null)}>{selected && <>
			<MenuItem onClick={() => { void launch(selected); setMenuPosition(null); }}><LaunchRoundedIcon fontSize="small" sx={{ mr: 1 }} />启动</MenuItem>
			<MenuItem onClick={() => { togglePinned(selected.id); setMenuPosition(null); }}><PushPinRoundedIcon fontSize="small" sx={{ mr: 1 }} />{selected.pinned ? "取消常用" : "设为常用"}</MenuItem>
			<MenuItem onClick={() => { setRenameItem(selected); setItemName(selected.name); setMenuPosition(null); }}><EditRoundedIcon fontSize="small" sx={{ mr: 1 }} />重命名</MenuItem>
			<MenuItem onClick={() => { void appLauncherService.openLocation(selected.path).catch(() => snackbar.error("打开所在位置失败")); setMenuPosition(null); }}><FolderOpenRoundedIcon fontSize="small" sx={{ mr: 1 }} />打开所在位置</MenuItem>
			<Divider />
			<MenuItem sx={{ color: "error.main" }} onClick={() => { removeItem(selected.id); setMenuPosition(null); }}><RemoveCircleOutlineRoundedIcon fontSize="small" sx={{ mr: 1 }} />移除</MenuItem>
		</>}</Menu>

		<Menu anchorReference="anchorPosition" anchorPosition={categoryMenuPosition ?? undefined} open={Boolean(categoryMenuPosition)} onClose={() => setCategoryMenuPosition(null)}>{selectedCategory && <>
			<MenuItem onClick={() => { setRenameCategory(selectedCategory); setCategoryName(selectedCategory.name); setCategoryMenuPosition(null); }}>重命名</MenuItem>
			<MenuItem disabled={selectedCategoryIndex <= 0} onClick={() => { moveCategory(selectedCategory.id, "left"); setCategoryMenuPosition(null); }}>向左移动</MenuItem>
			<MenuItem disabled={selectedCategoryIndex < 0 || selectedCategoryIndex >= categories.length - 1} onClick={() => { moveCategory(selectedCategory.id, "right"); setCategoryMenuPosition(null); }}>向右移动</MenuItem>
			<Divider />
			<MenuItem disabled={selectedCategory.id === "uncategorized"} sx={{ color: selectedCategory.id === "uncategorized" ? "text.disabled" : "error.main" }} onClick={() => { if (selectedCategory.id !== "uncategorized") setDeleteCategory(selectedCategory); setCategoryMenuPosition(null); }}>删除分类</MenuItem>
		</>}</Menu>

		<Dialog open={Boolean(renameItem)} onClose={() => setRenameItem(null)} maxWidth="xs" fullWidth>
			<DialogTitle>重命名应用</DialogTitle>
			<DialogContent><TextField autoFocus fullWidth label="仅修改 ReinaManager 内的显示名" value={itemName} onChange={(event) => setItemName(event.target.value)} inputProps={{ maxLength: 80 }} sx={{ mt: 0.5 }} /></DialogContent>
			<DialogActions><Button onClick={() => setRenameItem(null)}>取消</Button><Button variant="contained" onClick={() => { if (!renameItem || !renameItemRecord(renameItem.id, itemName)) { snackbar.error("名称不能为空"); return; } setRenameItem(null); snackbar.success("应用显示名已更新"); }}>保存</Button></DialogActions>
		</Dialog>

		<Dialog open={Boolean(renameCategory)} onClose={() => setRenameCategory(null)} maxWidth="xs" fullWidth>
			<DialogTitle>重命名分类</DialogTitle>
			<DialogContent><TextField autoFocus fullWidth label="分类名称" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} inputProps={{ maxLength: 40 }} sx={{ mt: 0.5 }} /></DialogContent>
			<DialogActions><Button onClick={() => setRenameCategory(null)}>取消</Button><Button variant="contained" onClick={() => { if (!renameCategory || !renameCategoryRecord(renameCategory.id, categoryName)) { snackbar.error("名称不能为空或与现有分类重复"); return; } setRenameCategory(null); snackbar.success("分类已重命名"); }}>保存</Button></DialogActions>
		</Dialog>

		<Dialog open={Boolean(deleteCategory)} onClose={() => setDeleteCategory(null)} maxWidth="xs" fullWidth>
			<DialogTitle>删除分类</DialogTitle>
			<DialogContent><Typography variant="body2">“{deleteCategory?.name}”中的应用会转入“待整理”。不会删除真实文件、快捷方式或应用记录。</Typography></DialogContent>
			<DialogActions><Button onClick={() => setDeleteCategory(null)}>取消</Button><Button color="error" variant="contained" onClick={() => { if (deleteCategory) removeCategory(deleteCategory.id); setDeleteCategory(null); snackbar.success("分类已删除，应用已转入待整理"); }}>删除分类</Button></DialogActions>
		</Dialog>

		<Dialog open={droppedCandidates.length > 0} onClose={() => !isImportingDrop && setDroppedCandidates([])} maxWidth="sm" fullWidth>
			<DialogTitle>导入拖入的应用</DialogTitle>
			<DialogContent dividers>
				<Stack spacing={1.25}>
					<Typography variant="body2" color="text.secondary">选择分类后导入。配置了对应来源目录时，.lnk/.url 会复制到该目录，.exe 会创建一个不覆盖的快捷方式；没有来源目录时只引用原文件。</Typography>
					<Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
						<TextField select fullWidth size="small" label="加入分类" value={dropCategoryId} onChange={(event) => setDropCategoryId(event.target.value)}>{categories.map((category) => <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>)}</TextField>
						{dropSources.length > 0 && <TextField select fullWidth size="small" label="写入来源目录" value={dropSourceId} onChange={(event) => setDropSourceId(event.target.value)}>{dropSources.map((source) => <MenuItem key={source.id} value={source.id}>{source.path}</MenuItem>)}</TextField>}
					</Stack>
					<Stack spacing={0.35} sx={{ maxHeight: 230, overflowY: "auto" }}>{droppedCandidates.map((candidate) => <Typography key={candidate.path} variant="body2" noWrap title={candidate.path}>{candidate.name}</Typography>)}</Stack>
				</Stack>
			</DialogContent>
			<DialogActions><Button disabled={isImportingDrop} onClick={() => setDroppedCandidates([])}>取消</Button><Button variant="contained" disabled={isImportingDrop} onClick={() => void importDroppedCandidates()}>{isImportingDrop ? "导入中…" : "确认导入"}</Button></DialogActions>
		</Dialog>
	</Box>;
}

function EmptyAppsState() {
	return <Box sx={{ minHeight: 300, display: "grid", placeItems: "center", border: "1px dashed", borderColor: "divider", borderRadius: 3, textAlign: "center", px: 3 }}>
		<Box><AppsRoundedIcon color="primary" sx={{ fontSize: 42, mb: 0.75 }} /><Typography variant="h6" fontWeight={700}>导入应用目录</Typography><Typography variant="body2" color="text.secondary" mt={0.5}>请从顶栏选择“导入目录”。导入不会移动、删除或改写文件。</Typography></Box>
	</Box>;
}

function categoryColumnWidth(items: AppLauncherItem[]) {
	const longestName = Math.max(0, ...items.map((item) => Array.from(item.name).length));
	return Math.min(240, Math.max(168, 58 + longestName * 8.5));
}

function CategoryColumn({ name, count, color, width, children, onContextMenu, dropId, sortable = false, previewTarget = false }: { name: string; count: number; color: string; width: number; children: React.ReactNode; onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void; dropId?: string; sortable?: boolean; previewTarget?: boolean }) {
	const { setNodeRef, isOver } = useDroppable({ id: dropId ?? `static:${name}`, disabled: !sortable });
	return <Box sx={{ flex: `0 0 ${width}px`, width, minWidth: 0, border: "1px solid", borderColor: isOver || previewTarget ? "primary.main" : "divider", borderRadius: 2, overflow: "hidden", bgcolor: isOver || previewTarget ? "primary.50" : "background.paper", transition: "background-color 120ms ease, border-color 120ms ease" }}>
		<Stack direction="row" spacing={0.8} alignItems="center" onContextMenu={onContextMenu} sx={{ px: 0.7, py: 0.35, borderBottom: "1px solid", borderColor: "divider", cursor: onContextMenu ? "context-menu" : "default" }}>
			<Box sx={{ width: 7, height: 7, borderRadius: 99, bgcolor: color }} /><Typography variant="caption" fontWeight={800} sx={{ flex: 1 }}>{name}</Typography><Typography variant="caption" color="text.secondary">{count}</Typography>
		</Stack>
		<Stack ref={setNodeRef} spacing={0.15} sx={{ p: 0.3, minHeight: sortable ? 38 : undefined }}>{children}</Stack>
	</Box>;
}

type CompactAppItemProps = { item: AppLauncherItem; icons: Record<string, string>; selectionMode: boolean; checked: boolean; onSelect: (id: string) => void; onLaunch: (item: AppLauncherItem) => Promise<void>; onMenu: (event: React.MouseEvent<HTMLElement>, item: AppLauncherItem) => void; longPressLaunch: boolean; pinned?: boolean };

function SortableAppItem({ sortable, ...props }: CompactAppItemProps & { sortable: boolean }) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `app:${props.item.id}`, disabled: !sortable });
	return <Box ref={setNodeRef} {...(sortable ? attributes : {})} {...(sortable ? listeners : {})} sx={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1, touchAction: sortable ? "none" : "auto" }}><CompactAppItem {...props} /></Box>;
}

function CompactAppItem({ item, icons, selectionMode, checked, onSelect, onLaunch, onMenu, longPressLaunch, pinned = false }: CompactAppItemProps) {
	const longPressTimer = useRef<number | null>(null);
	const clearLongPress = () => {
		if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
		longPressTimer.current = null;
	};
	const startLongPress = () => {
		if (!longPressLaunch || selectionMode) return;
		clearLongPress();
		longPressTimer.current = window.setTimeout(() => { longPressTimer.current = null; void onLaunch(item); }, 800);
	};
	return <Box onClick={() => selectionMode && onSelect(item.id)} onDoubleClick={(event) => { event.preventDefault(); if (!selectionMode) void onLaunch(item); }} onPointerDown={startLongPress} onPointerUp={clearLongPress} onPointerLeave={clearLongPress} onPointerCancel={clearLongPress} onContextMenu={(event) => !selectionMode && onMenu(event, item)} sx={{ display: "flex", alignItems: "center", gap: 0.55, minWidth: 0, minHeight: 31, px: 0.4, py: 0.1, borderRadius: 1.15, cursor: "pointer", userSelect: "none", WebkitUserSelect: "none", border: "1px solid", borderColor: checked ? "primary.main" : pinned ? "primary.light" : "transparent", bgcolor: checked || pinned ? "primary.50" : "transparent", "&:hover": { bgcolor: "action.hover", borderColor: "primary.light" } }}>
		{selectionMode && (checked ? <CheckBoxRoundedIcon color="primary" fontSize="small" /> : <CheckBoxOutlineBlankRoundedIcon color="action" fontSize="small" />)}
		<AppIcon item={item} icons={icons} size={22} />
		<Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontWeight: 500, fontSize: "0.8rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "clip", maskImage: "linear-gradient(to right, #000 calc(100% - 14px), transparent)", WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 14px), transparent)" }}>{item.name}</Typography>
	</Box>;
}

function DragPreviewItem({ item, icons }: { item: AppLauncherItem; icons: Record<string, string> }) {
	return <Box sx={{ display: "flex", alignItems: "center", gap: 0.55, minWidth: 168, minHeight: 31, px: 0.4, py: 0.1, borderRadius: 1.15, cursor: "grabbing", border: "1px solid", borderColor: "primary.main", bgcolor: "background.paper", boxShadow: 4, opacity: 0.96 }}>
		<AppIcon item={item} icons={icons} size={22} />
		<Typography variant="body2" sx={{ minWidth: 0, fontWeight: 500, fontSize: "0.8rem", whiteSpace: "nowrap" }}>{item.name}</Typography>
	</Box>;
}
