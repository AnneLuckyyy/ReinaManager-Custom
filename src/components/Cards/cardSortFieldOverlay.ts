import type { SortOption } from "@/services/invoke/types";
import type { ModSortOption } from "@/store/modStore";
import type { GameData } from "@/types";
import type { CardSortFieldOverlay } from "./types";

function formatScore(value: number | null | undefined) {
	return typeof value === "number" && value > 0 ? value.toFixed(1) : null;
}

export function getCardSortFieldOverlay(
	game: GameData,
	sortOption: ModSortOption,
	lastPlayed?: number | null,
): CardSortFieldOverlay | undefined {
	let value: string | null = null;
	switch (sortOption as SortOption | "bgmscore" | "custom") {
		case "addtime":
			value = game.created_at
				? new Date(game.created_at * 1000).toLocaleDateString()
				: null;
			break;
		case "datetime":
			value = game.date || null;
			break;
		case "lastplayed":
			value = lastPlayed
				? new Date(lastPlayed * 1000).toLocaleString()
				: null;
			break;
		case "bgmrank":
		case "vndbrank":
			value = game.rank && game.rank > 0 ? `#${game.rank}` : null;
			break;
		case "bgmscore":
			value = formatScore(game.score);
			break;
	}
	return value ? { value } : undefined;
}
