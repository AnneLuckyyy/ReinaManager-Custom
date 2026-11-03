import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useRemoveGamesFromCategory } from "@/hooks/queries/useCollections";
import { snackbar } from "@/providers/snackBar";
import { useStore } from "@/store/appStore";
import { useModStore } from "@/store/modStore";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData } from "@/types";
import { getGameDisplayName, saveScrollPosition } from "@/utils/appUtils";
import { getAllGameStatistics } from "@/utils/gameStats";
import { CardsBatchBar } from "./CardsBatchBar";
import { getCardSortFieldOverlay } from "./cardSortFieldOverlay";
import { RightMenuHost } from "./RightMenuHost";
import type { RightMenuHostHandle, SortableCardItemProps } from "./types";
import { statsKeys } from "@/hooks/queries/useStats";

interface UseCardsControllerOptions {
	gameIds: number[];
	categoryId?: number;
}

export function useCardsController({
	gameIds,
	categoryId,
}: UseCardsControllerOptions) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const path = useLocation().pathname;
	const isLibraries = path === "/libraries";
	const isCollectionCategory = typeof categoryId === "number" && categoryId > 0;
	const canUseBatchMode = isLibraries || isCollectionCategory;
	const rightMenuRef = useRef<RightMenuHostHandle>(null);

	const {
		setSelectedGameId,
		cardClickMode,
		doubleClickLaunch,
		longPressLaunch,
		sortOption: librarySortOption,
		showCardSortFieldOverlay: libraryShowCardSortFieldOverlay,
		setCardsBatchMode,
	} = useStore(
		useShallow((s) => ({
			setSelectedGameId: s.setSelectedGameId,
			cardClickMode: s.cardClickMode,
			doubleClickLaunch: s.doubleClickLaunch,
			longPressLaunch: s.longPressLaunch,
			sortOption: s.sortOption,
			showCardSortFieldOverlay: s.showCardSortFieldOverlay,
			setCardsBatchMode: s.setCardsBatchMode,
		})),
	);
	const collectionViewPref = useModStore((state) =>
		isCollectionCategory ? state.collectionViewPrefs[categoryId] : undefined,
	);
	const sortOption = collectionViewPref?.sortOption ?? librarySortOption;
	const showCardSortFieldOverlay =
		collectionViewPref?.showCardSortFieldOverlay ??
		libraryShowCardSortFieldOverlay;
	const shouldShowCardSortFieldOverlay =
		showCardSortFieldOverlay && sortOption !== "custom";
	const allStatsQuery = useQuery({
		queryKey: statsKeys.all,
		queryFn: getAllGameStatistics,
		enabled:
			shouldShowCardSortFieldOverlay && sortOption === "lastplayed",
	});
	const launchGame = useGamePlayStore((s) => s.launchGame);
	const [batchMode, setBatchMode] = useState(false);
	const [selectedBatchGameIds, setSelectedBatchGameIds] = useState<number[]>(
		[],
	);
	useEffect(() => () => setCardsBatchMode(false), [setCardsBatchMode]);
	const handleBatchModeChange = useCallback(
		(enabled: boolean) => {
			setBatchMode(enabled);
			setCardsBatchMode(enabled);
		},
		[setCardsBatchMode],
	);
	const selectedBatchGameIdSet = useMemo(
		() => new Set(selectedBatchGameIds),
		[selectedBatchGameIds],
	);
	const showBatchControls = canUseBatchMode && batchMode;
	const removeGamesFromCategoryMutation = useRemoveGamesFromCategory();

	const toggleBatchGame = useCallback((gameId: number) => {
		setSelectedBatchGameIds((prev) =>
			prev.includes(gameId)
				? prev.filter((id) => id !== gameId)
				: [...prev, gameId],
		);
	}, []);

	const handleCardClick = useCallback(
		(cardId: number) => {
			if (showBatchControls) {
				toggleBatchGame(cardId);
				return;
			}

			if (cardClickMode === "navigate") {
				setSelectedGameId(cardId);
				saveScrollPosition(window.location.pathname);
				navigate(`/libraries/${cardId}`);
			} else {
				setSelectedGameId(cardId);
			}
		},
		[
			cardClickMode,
			navigate,
			setSelectedGameId,
			showBatchControls,
			toggleBatchGame,
		],
	);

	const handleCardDoubleClick = useCallback(
		async (game: GameData) => {
			if (showBatchControls) return;

			if (doubleClickLaunch) {
				setSelectedGameId(game.id);
				const result = await launchGame(game.id);
				if (!result.success) snackbar.error(result.message);
			}
		},
		[
			doubleClickLaunch,
			launchGame,
			setSelectedGameId,
			showBatchControls,
		],
	);

	const handleCardLongPress = useCallback(
		async (game: GameData) => {
			if (showBatchControls) return;

			if (longPressLaunch) {
				setSelectedGameId(game.id);
				const result = await launchGame(game.id);
				if (!result.success) snackbar.error(result.message);
			}
		},
		[
			longPressLaunch,
			launchGame,
			setSelectedGameId,
			showBatchControls,
		],
	);

	const handleContextMenu = useCallback(
		(event: React.MouseEvent, cardId: number) => {
			if (showBatchControls) {
				event.preventDefault();
				return;
			}

			rightMenuRef.current?.open(cardId, event.clientX, event.clientY);
			setSelectedGameId(cardId);
		},
		[setSelectedGameId, showBatchControls],
	);

	const handleRemoveFromCategory = useCallback(
		async (targetGameIds: number[]) => {
			if (!isCollectionCategory || !categoryId) return;

			const targetGameIdSet = new Set(targetGameIds);
			await removeGamesFromCategoryMutation.mutateAsync({
				categoryId,
				gameIds: targetGameIds,
			});

			setSelectedBatchGameIds((prev) =>
				prev.filter((selectedId) => !targetGameIdSet.has(selectedId)),
			);
		},
		[categoryId, isCollectionCategory, removeGamesFromCategoryMutation],
	);

	const handleRemoveSingleFromCategory = useCallback(
		async (cardId: number) => {
			try {
				await handleRemoveFromCategory([cardId]);
				snackbar.success(
					t("components.Cards.removeFromCategorySuccess", {
						defaultValue: "已从当前分类移除",
					}),
				);
			} catch (error) {
				console.error("移出分类失败:", error);
				snackbar.error(
					t("components.Cards.removeFromCategoryFailed", {
						defaultValue: "移出分类失败",
					}),
				);
			}
		},
		[handleRemoveFromCategory, t],
	);

	const getCardProps = useCallback(
		(game: GameData): SortableCardItemProps => {
			const gameId = game.id;
			return {
				game,
				displayName: getGameDisplayName(game),
				sortFieldOverlay: shouldShowCardSortFieldOverlay
					? getCardSortFieldOverlay(
							game,
							sortOption,
							allStatsQuery.data?.get(gameId)?.last_played,
						)
					: undefined,
				batch: showBatchControls
					? { selected: selectedBatchGameIdSet.has(gameId) }
					: undefined,
				removeAction:
					isCollectionCategory && !showBatchControls
						? {
								title: t("components.Cards.removeFromCategory", "移出当前分类"),
								onRemove: () => handleRemoveSingleFromCategory(gameId),
							}
						: undefined,
				interaction: {
					useDelayedClick:
						!showBatchControls &&
						cardClickMode === "navigate" &&
						doubleClickLaunch,
					onContextMenu: (e: React.MouseEvent) => handleContextMenu(e, gameId),
					onClick: () => handleCardClick(gameId),
					onDoubleClick: () => handleCardDoubleClick(game),
					onLongPress: () => handleCardLongPress(game),
				},
			};
		},
		[
			cardClickMode,
			doubleClickLaunch,
			handleContextMenu,
			handleCardClick,
			handleCardDoubleClick,
			handleCardLongPress,
			handleRemoveSingleFromCategory,
			isCollectionCategory,
			allStatsQuery.data,
			sortOption,
			shouldShowCardSortFieldOverlay,
			selectedBatchGameIdSet,
			showBatchControls,
			t,
		],
	);

	const controls = (
		<>
			{canUseBatchMode && (
				<CardsBatchBar
					batchMode={batchMode}
					selectedBatchGameIds={selectedBatchGameIds}
					gameIds={gameIds}
					categoryId={categoryId}
					onBatchModeChange={handleBatchModeChange}
					onSelectionChange={setSelectedBatchGameIds}
					onSelectionClear={() => setSelectedBatchGameIds([])}
					onDeleteSuccess={() => setSelectedGameId(null)}
					onRemoveFromCategory={handleRemoveFromCategory}
				/>
			)}
			<RightMenuHost ref={rightMenuRef} />
		</>
	);

	return {
		controls,
		getCardProps,
		longPressLaunch,
		showBatchControls,
	};
}
