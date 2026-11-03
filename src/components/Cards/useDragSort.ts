import {
	type DragEndEvent,
	type DragStartEvent,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateCategoryGames } from "@/hooks/queries/useCollections";
import { snackbar } from "@/providers/snackBar";
import type { SortOrder } from "@/services/invoke/types";
import { type ModSortOption, useModStore } from "@/store/modStore";

/**
 * 拖拽排序 Hook - 管理拖拽相关状态和逻辑
 *
 * 操作纯 ID 数组，不再依赖完整 GameData 对象。
 */
export function useDragSort(options: {
	gameIds: number[];
	allGameIds?: number[];
	categoryId?: number;
	enabled: boolean;
	sortOption: ModSortOption;
	sortOrder: SortOrder;
	customOrderInitialized: boolean;
}) {
	const {
		gameIds,
		allGameIds = gameIds,
		categoryId,
		enabled,
		sortOption,
		sortOrder,
		customOrderInitialized,
	} = options;
	const { t } = useTranslation();
	const updateCategoryGamesMutation = useUpdateCategoryGames();
	const updateCollectionViewPref = useModStore(
		(state) => state.updateCollectionViewPref,
	);

	const [sortableIds, setSortableIds] = useState(gameIds);
	const [activeId, setActiveId] = useState<number | null>(null);
	const isDraggingRef = useRef(false);

	const ids = enabled ? sortableIds : gameIds;

	// 排序模式保留本地顺序，非排序模式直接使用外部数据，避免删除后慢一帧
	useEffect(() => {
		if (enabled && !isDraggingRef.current) {
			setSortableIds(gameIds);
		}
	}, [enabled, gameIds]);

	// 传感器配置
	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: { distance: 10 },
		}),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 250, tolerance: 5 },
		}),
	);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			if (!enabled || updateCategoryGamesMutation.isPending) return;
			isDraggingRef.current = true;
			setActiveId(event.active.id as number);
		},
		[enabled, updateCategoryGamesMutation.isPending],
	);

	const handleDragCancel = useCallback(() => {
		isDraggingRef.current = false;
		setActiveId(null);
	}, []);

	const handleDragEnd = useCallback(
		async (event: DragEndEvent) => {
			const { active, over } = event;
			setActiveId(null);

			if (!over || active.id === over.id || !categoryId) {
				isDraggingRef.current = false;
				return;
			}

			const oldIndex = ids.indexOf(active.id as number);
			const newIndex = ids.indexOf(over.id as number);

			if (oldIndex !== -1 && newIndex !== -1) {
				const newIds = arrayMove(ids, oldIndex, newIndex);
				setSortableIds(newIds);
				// 筛选状态下只替换可见游戏占用的位置，隐藏游戏保持在完整分类中。
				const visibleIdSet = new Set(ids);
				let visibleIndex = 0;
				const persistedDisplayIds = allGameIds.map((id) => {
					if (!visibleIdSet.has(id)) return id;
					const nextId = newIds[visibleIndex];
					visibleIndex += 1;
					return nextId;
				});
				const preserveCustomDescending =
					sortOption === "custom" &&
					customOrderInitialized &&
					sortOrder === "desc";
				const persistedIds = preserveCustomDescending
					? [...persistedDisplayIds].reverse()
					: persistedDisplayIds;

				try {
					await updateCategoryGamesMutation.mutateAsync({
						categoryId,
						gameIds: persistedIds,
					});
					if (sortOption !== "custom" || !customOrderInitialized) {
						updateCollectionViewPref(categoryId, {
							sortOption: "custom",
							sortOrder: "asc",
							customOrderInitialized: true,
						});
					}
				} catch (error) {
					console.error("排序更新失败:", error);
					setSortableIds(ids); // 回滚
					snackbar.error(
						t(
							"components.Collection.errors.updateCategoryGamesFailed",
							"更新分类游戏失败，请重试",
						),
					);
				} finally {
					isDraggingRef.current = false;
				}
			}
		},
		[
			ids,
			allGameIds,
			categoryId,
			sortOption,
			sortOrder,
			customOrderInitialized,
			updateCategoryGamesMutation,
			updateCollectionViewPref,
			t,
		],
	);

	return {
		ids,
		activeId,
		sensors,
		handleDragStart,
		handleDragCancel,
		handleDragEnd,
		isSaving: updateCategoryGamesMutation.isPending,
	};
}
