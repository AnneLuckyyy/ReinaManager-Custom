import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { useStore } from "@/store/appStore";
import type { GameData } from "@/types";
import { CardItem } from "./CardItem";
import { useCardsController } from "./useCardsController";

const BREAKPOINTS = [
	{ min: 2560, cols: 10 },
	{ min: 1920, cols: 9 },
	{ min: 1536, cols: 8 },
	{ min: 1280, cols: 7 },
	{ min: 1024, cols: 6 },
] as const;

function getColumnCount(): number {
	const w = window.innerWidth;
	for (const bp of BREAKPOINTS) {
		if (w >= bp.min) return bp.cols;
	}
	return 3;
}

interface VirtualCardsGridProps {
	gameIds: number[];
	displayById: Map<number, GameData>;
}

/**
 * VirtualCardsGrid - 虚拟化卡片网格（用于 LibrariesPage）
 *
 * 滚动恢复：
 * - 保存：scroll 事件中缓存 main.scrollTop - wrapper 相对偏移（列表内坐标），
 *         unmount 时写入 Zustand（ref 值，避免 react-router 重置 DOM 的时序问题）
 * - 恢复：initialScrollTop 直接传列表内偏移，Virtuoso 初始化时同步生效
 */
export const VirtualCardsGrid = memo(
	({ gameIds, displayById }: VirtualCardsGridProps) => {
		const { controls, getCardProps } = useCardsController({ gameIds });

		const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
		const virtuosoWrapperRef = useRef<HTMLDivElement>(null);

		useEffect(() => {
			setMainEl(document.querySelector("main"));
		}, []);

		// 首次 mount 时读取，仅用于 initialScrollTop（Virtuoso 初始化时同步生效）
		const savedScrollTop = useMemo(
			() => useStore.getState().librariesScrollTop,
			[],
		);

		const [columns, setColumns] = useState(() => getColumnCount());

		useEffect(() => {
			const onResize = () => setColumns(getColumnCount());
			window.addEventListener("resize", onResize);
			return () => window.removeEventListener("resize", onResize);
		}, []);

		const rows = useMemo(() => {
			const result: number[][] = [];
			for (let i = 0; i < gameIds.length; i += columns) {
				result.push(gameIds.slice(i, i + columns));
			}
			return result;
		}, [gameIds, columns]);

		// scroll 事件缓存列表内相对偏移，unmount 时存入 Zustand
		const lastScrollTop = useRef(0);

		useEffect(() => {
			if (!mainEl) return;

			// wrapper 相对 main 内容区的固定偏移（含 margin），算一次
			const wrapperOffsetTop =
				(virtuosoWrapperRef.current?.getBoundingClientRect().top ?? 0) -
				mainEl.getBoundingClientRect().top +
				mainEl.scrollTop;

			const onScroll = () => {
				lastScrollTop.current = Math.max(
					0,
					mainEl.scrollTop - wrapperOffsetTop,
				);
			};

			mainEl.addEventListener("scroll", onScroll, { passive: true });
			return () => {
				mainEl.removeEventListener("scroll", onScroll);
				useStore.getState().setLibrariesScrollTop(lastScrollTop.current);
			};
		}, [mainEl]);

		return (
			<>
				{controls}
				<div ref={virtuosoWrapperRef} className="flex-1 min-h-0">
					{mainEl && (
						<Virtuoso
							customScrollParent={mainEl}
							totalCount={rows.length}
							overscan={400}
							initialScrollTop={savedScrollTop}
							itemContent={(rowIndex) => (
								<div
									className="grid gap-4 pb-4"
									style={{
										gridTemplateColumns: `repeat(${columns}, 1fr)`,
									}}
								>
									{rows[rowIndex].map((gameId) => {
										const game = displayById.get(gameId);
										if (!game) return null;
										const props = getCardProps(game);
										return <CardItem key={gameId} {...props} />;
									})}
								</div>
							)}
						/>
					)}
				</div>
			</>
		);
	},
);

VirtualCardsGrid.displayName = "VirtualCardsGrid";
