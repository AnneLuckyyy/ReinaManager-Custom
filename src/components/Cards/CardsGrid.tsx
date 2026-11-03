import { memo } from "react";
import type { GameData } from "@/types";
import { CardItem } from "./CardItem";
import { useCardsController } from "./useCardsController";

interface CardsGridProps {
	gameIds: number[];
	displayById: Map<number, GameData>;
	categoryId?: number;
}

/**
 * CardsGrid - 普通卡片布局。
 *
 * 接收 ID 数组和展示索引，渲染时按 ID 取 GameData。
 */
export const CardsGrid = memo(
	({ gameIds, displayById, categoryId }: CardsGridProps) => {
		const { controls, getCardProps } = useCardsController({
			gameIds,
			categoryId,
		});

		return (
			<>
				{controls}
				<div className="flex-1 min-h-0">
					<div
						className={
							"text-center grid lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 3xl:grid-cols-9 4xl:grid-cols-10 gap-4"
						}
					>
						{gameIds.map((gameId) => {
							const game = displayById.get(gameId);
							if (!game) return null;
							const props = getCardProps(game);
							return <CardItem key={gameId} {...props} />;
						})}
					</div>
				</div>
			</>
		);
	},
);

CardsGrid.displayName = "CardsGrid";
