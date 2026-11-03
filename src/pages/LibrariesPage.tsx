import Box from "@mui/material/Box";
import { useTranslation } from "react-i18next";
import { VirtualCardsGrid } from "@/components/Cards";
import { GameListStateView } from "@/components/GameListStateView";
import { useGameListFacade } from "@/hooks/features/games/useGameListFacade";

export const Libraries: React.FC = () => {
	const { t } = useTranslation();
	const { gameIds, displayById, isLoading, isError, error } =
		useGameListFacade();

	return (
		<Box sx={{ p: 3, pt: 1.5 }}>
			<GameListStateView
				loading={isLoading}
				error={isError ? error : null}
				empty={gameIds.length === 0}
				emptyMessage={t("pages.Libraries.empty", "没有找到符合条件的游戏")}
			>
				<VirtualCardsGrid gameIds={gameIds} displayById={displayById} />
			</GameListStateView>
		</Box>
	);
};
