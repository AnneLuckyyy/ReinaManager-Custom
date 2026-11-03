import { closestCenter, DndContext, DragOverlay } from "@dnd-kit/core";
import {
	SortableContext,
	type SortingStrategy,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { type GridStateSnapshot, VirtuosoGrid } from "react-virtuoso";
import type { SortOrder } from "@/services/invoke/types";
import type { ModSortOption } from "@/store/modStore";
import type { GameData } from "@/types";
import { CardItem } from "./CardItem";
import type { CardItemProps } from "./types";
import { useCardsController } from "./useCardsController";
import { useDragSort } from "./useDragSort";

interface SortableCardsGridProps {
	gameIds: number[];
	allGameIds?: number[];
	displayById: Map<number, GameData>;
	categoryId: number;
	sortOption: ModSortOption;
	sortOrder: SortOrder;
	customOrderInitialized: boolean;
}

interface GridLayout extends GridStateSnapshot {
	columns: number;
}

interface SortableCardItemProps {
	game: GameData;
	index: number;
	getCardProps: (game: GameData) => CardItemProps;
	disabledSortable: boolean;
}

const BREAKPOINTS = [
	{ min: 2560, cols: 10 },
	{ min: 1920, cols: 9 },
	{ min: 1536, cols: 8 },
	{ min: 1280, cols: 7 },
	{ min: 1024, cols: 6 },
] as const;

// 虚拟网格的滚动容器是应用主页面。虚拟窗口滚动时会增减已挂载卡片，
// 因此不能让 dnd-kit 再按普通列表的布局变化补偿滚动位置，否则可能跳边。
const autoScroll = {
	canScroll: (element: Element) => element.tagName === "MAIN",
	interval: 16,
	acceleration: 4,
	threshold: { x: 0.1, y: 0.1 },
	layoutShiftCompensation: { x: false, y: false },
};

function getColumnCount(): number {
	for (const breakpoint of BREAKPOINTS) {
		if (window.innerWidth >= breakpoint.min) return breakpoint.cols;
	}
	return 1;
}

// 与 arrayMove 的插入语义一致；拖动中每张卡片只按下标计算位置，
// 不复制整组游戏 ID，离屏卡片也不必持续挂载。
function getMovedIndex(index: number, activeIndex: number, overIndex: number) {
	if (activeIndex < 0 || overIndex < 0) return index;
	if (index === activeIndex) return overIndex;
	if (activeIndex < overIndex && index > activeIndex && index <= overIndex) {
		return index - 1;
	}
	if (activeIndex > overIndex && index >= overIndex && index < activeIndex) {
		return index + 1;
	}
	return index;
}

const SortableCardItem = memo(
	({ game, index, getCardProps, disabledSortable }: SortableCardItemProps) => {
		const getNewIndex = useCallback(
			({ activeIndex, overIndex }: { activeIndex: number; overIndex: number }) =>
				getMovedIndex(index, activeIndex, overIndex),
			[index],
		);
		const {
			attributes,
			listeners,
			setNodeRef,
			transform,
			transition,
			isDragging,
		} = useSortable({ id: game.id, disabled: disabledSortable, getNewIndex });
		const style = useMemo(
			() => ({
				transform: CSS.Transform.toString(transform),
				transition,
				zIndex: isDragging ? 1000 : ("auto" as const),
			}),
			[transform, transition, isDragging],
		);

		return (
			<div
				ref={setNodeRef}
				style={style}
				className={`relative min-w-0 ${isDragging ? "opacity-0" : ""}`}
				{...(!disabledSortable ? attributes : {})}
				{...(!disabledSortable ? listeners : {})}
			>
				<CardItem {...getCardProps(game)} />
			</div>
		);
	},
);

SortableCardItem.displayName = "SortableCardItem";

/**
 * 收藏夹可拖拽卡片网格。
 *
 * 基于上游虚拟化拖拽实现适配当前改版的 ID 列表与筛选子集排序契约：
 * 屏幕外卡片不会在拖动中参与 React 渲染，完整顺序仍由 useDragSort 合并后保存。
 */
export const SortableCardsGrid = memo(
	({
		gameIds,
		allGameIds,
		displayById,
		categoryId,
		sortOption,
		sortOrder,
		customOrderInitialized,
	}: SortableCardsGridProps) => {
		const layoutRef = useRef<GridLayout | null>(null);
		const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
		const [columns, setColumns] = useState(getColumnCount);
		const {
			ids,
			activeId,
			sensors,
			handleDragStart,
			handleDragCancel,
			handleDragEnd,
			isSaving,
		} = useDragSort({
			gameIds,
			allGameIds,
			categoryId,
			enabled: true,
			sortOption,
			sortOrder,
			customOrderInitialized,
		});
		const { controls, getCardProps, longPressLaunch, showBatchControls } =
			useCardsController({ gameIds: ids, categoryId });
		const isDragSortEnabled =
			!longPressLaunch && !showBatchControls && !isSaving;

		useEffect(() => {
			setScrollParent(document.querySelector<HTMLElement>("main"));
			const handleResize = () => setColumns(getColumnCount());
			window.addEventListener("resize", handleResize);
			return () => window.removeEventListener("resize", handleResize);
		}, []);

		const handleGridStateChanged = useCallback(
			(state: GridStateSnapshot) => {
				layoutRef.current = { ...state, columns };
			},
			[columns],
		);
		const sortingStrategy = useCallback<SortingStrategy>(
			({ index, activeIndex, overIndex }) => {
				const layout = layoutRef.current;
				if (!layout || layout.item.width === 0 || layout.item.height === 0) {
					return null;
				}
				const nextIndex = getMovedIndex(index, activeIndex, overIndex);
				const { item, gap } = layout;
				return {
					x:
						((nextIndex % layout.columns) - (index % layout.columns)) *
						(item.width + gap.column),
					y:
						(Math.floor(nextIndex / layout.columns) -
							Math.floor(index / layout.columns)) *
						(item.height + gap.row),
					scaleX: 1,
					scaleY: 1,
				};
			},
			[],
		);
		const renderCard = useCallback(
			(index: number, gameId: number) => {
				const game = displayById.get(gameId);
				if (!game) return null;
				return (
					<SortableCardItem
						game={game}
						index={index}
						getCardProps={getCardProps}
						disabledSortable={!isDragSortEnabled}
					/>
				);
			},
			[displayById, getCardProps, isDragSortEnabled],
		);
		const activeGame =
			activeId === null ? undefined : displayById.get(activeId);

		return (
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				autoScroll={autoScroll}
				onDragStart={isDragSortEnabled ? handleDragStart : undefined}
				onDragCancel={handleDragCancel}
				onDragEnd={isDragSortEnabled ? handleDragEnd : undefined}
			>
				<SortableContext items={ids} strategy={sortingStrategy}>
					{controls}
					<div className="flex-1 min-h-0 min-w-0 [overflow-anchor:none]">
						{scrollParent && (
							<VirtuosoGrid
								customScrollParent={scrollParent}
								data={ids}
								computeItemKey={(_, gameId) => `game-${gameId}`}
								listClassName="text-center grid lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 3xl:grid-cols-9 4xl:grid-cols-10 gap-4 pb-4 [overflow-anchor:none]"
								itemClassName="min-w-0"
							// 上下保留若干行，快速滚动时拖动源与目标不会立刻被卸载。
							increaseViewportBy={{ top: 1100, bottom: 1100 }}
								stateChanged={handleGridStateChanged}
								itemContent={renderCard}
							/>
						)}
					</div>
				</SortableContext>
				{createPortal(
					<DragOverlay dropAnimation={null} className="pointer-events-none">
						{activeGame && <CardItem {...getCardProps(activeGame)} isOverlay />}
					</DragOverlay>,
					document.body,
				)}
			</DndContext>
		);
	},
);

SortableCardsGrid.displayName = "SortableCardsGrid";
