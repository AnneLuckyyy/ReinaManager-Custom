import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
	useAddGame,
	useAllGames,
	useBatchAddGames,
	useUpdateGame,
} from "@/hooks/queries/useGames";
import type {
	BatchOperationResult,
	FullGameData,
	GameCandidateData,
	InsertGameParams,
	SourceIdType,
} from "@/types";
import { getUserErrorMessage } from "@/utils/errors";
import i18n from "@/utils/i18n";
import {
	type BatchImportGameCandidate,
	buildBulkImportGameData,
	buildInsertGameData,
	getGameIdentityKeys,
} from "@/utils/metadata";

export interface BulkImportActionInput extends BatchImportGameCandidate {
	status?: string;
}

export type BulkImportMode = "metadata" | "custom";

export interface BulkImportPreparationError {
	itemIndex: number;
	message: string;
}

export interface BulkImportPendingPayload {
	itemIndex: number;
	payloadIndex: number;
}

export interface BulkImportDuplicate {
	itemIndex: number;
	kind: "library" | "batch";
	duplicateOfItemIndex?: number;
	groupItemIndices?: readonly number[];
}

export interface BulkImportActionResult {
	pendingPayloads: BulkImportPendingPayload[];
	duplicates: BulkImportDuplicate[];
	preparationErrors: BulkImportPreparationError[];
	restoredItemIndices: number[];
	restorationErrors: BulkImportPreparationError[];
	completedGames: Array<{ itemIndex: number; gameId: number }>;
	batchResult?: BatchOperationResult;
	mutationError?: string;
}

export function useGameDuplicateChecker() {
	const { data: allGames = [] } = useAllGames();

	const findMatchingGame = useCallback(
		(gameData: Pick<InsertGameParams, SourceIdType>) => {
			return allGames.find(
				(game) =>
					(gameData.bgm_id && game.bgm_id === gameData.bgm_id) ||
					(gameData.vndb_id && game.vndb_id === gameData.vndb_id) ||
					(gameData.ymgal_id && game.ymgal_id === gameData.ymgal_id) ||
					(gameData.kun_id && game.kun_id === gameData.kun_id) ||
					(gameData.dlsite_id && game.dlsite_id === gameData.dlsite_id),
			);
		},
		[allGames],
	);
	const checkGameExists = useCallback(
		(gameData: Pick<InsertGameParams, SourceIdType>) => Boolean(findMatchingGame(gameData)),
		[findMatchingGame],
	);

	return {
		checkGameExists,
		findMatchingGame,
	};
}

function isPathlessGame(game: FullGameData): boolean {
	return !game.localpath?.trim() && !game.custom_data?.extraLocalPaths?.some((path) => path.trim());
}

function buildPathRestoreUpdate(game: FullGameData, localpath: string) {
	return {
		localpath,
		custom_data: {
			...game.custom_data,
			extraLocalPaths: [localpath],
		},
	};
}

export function useSingleGameAddActions() {
	const addGameMutation = useAddGame();
	const updateGameMutation = useUpdateGame();
	const { checkGameExists, findMatchingGame } = useGameDuplicateChecker();
	const metadataAddActionMutation = useMutation({
		mutationFn: async ({
			gameData,
		}: {
			gameData: GameCandidateData;
			options?: {
				localpath?: string;
				fallbackIdType?: string;
				fallbackDate?: string;
			};
		}) => {
			const insertData = await buildInsertGameData(gameData);

			const existingGame = findMatchingGame(insertData);
			if (existingGame && isPathlessGame(existingGame) && insertData.localpath?.trim()) {
				return updateGameMutation.mutateAsync({
					gameId: existingGame.id,
					updates: buildPathRestoreUpdate(existingGame, insertData.localpath),
				});
			}
			if (checkGameExists(insertData)) {
				throw new Error(i18n.t("components.AddModal.gameExists", "游戏已存在"));
			}

			return addGameMutation.mutateAsync(insertData);
		},
	});

	const addGameFromMetadata = useCallback(
		async (gameData: GameCandidateData) => {
			return metadataAddActionMutation.mutateAsync({
				gameData,
			});
		},
		[metadataAddActionMutation],
	);

	return {
		addGameFromMetadata,
		isAddingGame: metadataAddActionMutation.isPending,
	};
}

export function useBulkGameAddActions() {
	const batchAddGamesMutation = useBatchAddGames();
	const updateGameMutation = useUpdateGame();
	const { findMatchingGame } = useGameDuplicateChecker();
	const [isPreparingGames, setIsPreparingGames] = useState(false);

	const findBulkImportDuplicates = useCallback(
		(items: BulkImportActionInput[]): BulkImportDuplicate[] => {
			const identitiesByItem = new Map<number, string[]>();
			const membersByIdentity = new Map<string, number[]>();
			const libraryDuplicateItems = new Set<number>();
			const pathlessLibraryItems = new Set<number>();

			for (let index = 0; index < items.length; index++) {
				const matchedData = items[index].matchedData;
				if (!matchedData) continue;

				const identities = getGameIdentityKeys(matchedData);
				identitiesByItem.set(index, identities);
				const existing = findMatchingGame(matchedData);
				if (existing && isPathlessGame(existing)) pathlessLibraryItems.add(index);
				else if (existing) libraryDuplicateItems.add(index);
				for (const identity of identities) {
					const members = membersByIdentity.get(identity) ?? [];
					members.push(index);
					membersByIdentity.set(identity, members);
				}
			}

			const groupByItem = new Map<number, number[]>();
			const visited = new Set<number>();
			for (const startIndex of identitiesByItem.keys()) {
				if (visited.has(startIndex)) continue;
				const group = new Set<number>();
				const pending = [startIndex];
				visited.add(startIndex);
				while (pending.length > 0) {
					const itemIndex = pending.pop();
					if (itemIndex === undefined) continue;
					group.add(itemIndex);
					for (const identity of identitiesByItem.get(itemIndex) ?? []) {
						for (const memberIndex of membersByIdentity.get(identity) ?? []) {
							if (!visited.has(memberIndex)) {
								visited.add(memberIndex);
								pending.push(memberIndex);
							}
						}
					}
				}
				if (group.size > 1) {
					const groupItemIndices = [...group].sort((left, right) => left - right);
					for (const itemIndex of groupItemIndices) {
						groupByItem.set(itemIndex, groupItemIndices);
					}
				}
			}

			return [...identitiesByItem.keys()].flatMap((itemIndex) => {
				const groupItemIndices = groupByItem.get(itemIndex);
				const inLibrary = libraryDuplicateItems.has(itemIndex);
				const restoresPathlessLibrary = pathlessLibraryItems.has(itemIndex);
				if (restoresPathlessLibrary) {
					const first = groupItemIndices?.[0] ?? itemIndex;
					if (itemIndex === first) return [];
					return [{ itemIndex, kind: "batch" as const, duplicateOfItemIndex: first, groupItemIndices }];
				}
				if (!inLibrary && !groupItemIndices) return [];
				return [{
					itemIndex,
					kind: inLibrary ? "library" : "batch",
					duplicateOfItemIndex: groupItemIndices?.[0],
					groupItemIndices,
				}];
			});
		},
		[findMatchingGame],
	);

	const addGamesFromBulkImport = useCallback(
		async (
			items: BulkImportActionInput[],
			{ skipDuplicateCheck = false }: { skipDuplicateCheck?: boolean } = {},
		): Promise<BulkImportActionResult> => {
			setIsPreparingGames(true);
			try {
				const payloads: InsertGameParams[] = [];
				const queuedIdOwners = new Map<string, number>();
				const duplicates: BulkImportDuplicate[] = [];
				const preparationErrors: BulkImportPreparationError[] = [];
				const restoredItemIndices: number[] = [];
				const restorationErrors: BulkImportPreparationError[] = [];
				const completedGames: Array<{ itemIndex: number; gameId: number }> = [];
				const pendingPayloads: BulkImportPendingPayload[] = [];

				for (let index = 0; index < items.length; index++) {
					if (items[index].status === "imported") {
						continue;
					}

					let payload: InsertGameParams;
					try {
						payload = await buildBulkImportGameData(items[index]);
					} catch (error) {
						const message = getUserErrorMessage(
							error,
							i18n.t.bind(i18n),
							i18n.t("errors.unknownError", "未知错误"),
						);
						preparationErrors.push({
							itemIndex: index,
							message,
						});
						continue;
					}

					if (!skipDuplicateCheck) {
						const identityKeys = getGameIdentityKeys(payload);
						const existingGame = findMatchingGame(payload);
						const existsInLibrary = Boolean(existingGame);
						const duplicateOfItemIndex = identityKeys
							.map((key) => queuedIdOwners.get(key))
							.find((itemIndex) => itemIndex !== undefined);

						if (duplicateOfItemIndex !== undefined) {
							duplicates.push({
								itemIndex: index,
								kind: "batch",
								duplicateOfItemIndex,
							});
							continue;
						}
						if (existingGame && isPathlessGame(existingGame) && payload.localpath?.trim()) {
							try {
								await updateGameMutation.mutateAsync({
									gameId: existingGame.id,
									updates: buildPathRestoreUpdate(existingGame, payload.localpath),
								});
								restoredItemIndices.push(index);
								completedGames.push({ itemIndex: index, gameId: existingGame.id });
								for (const key of identityKeys) queuedIdOwners.set(key, index);
							} catch (error) {
								restorationErrors.push({
									itemIndex: index,
									message: getUserErrorMessage(error, i18n.t.bind(i18n), i18n.t("errors.unknownError", "未知错误")),
								});
							}
							continue;
						}
						if (existsInLibrary) {
							duplicates.push({ itemIndex: index, kind: "library" });
							continue;
						}

						for (const key of identityKeys) {
							queuedIdOwners.set(key, index);
						}
					}

					pendingPayloads.push({
						itemIndex: index,
						payloadIndex: payloads.length,
					});
					payloads.push(payload);
				}

				if (payloads.length === 0) {
					return {
						pendingPayloads,
						duplicates,
						preparationErrors,
						restoredItemIndices,
						restorationErrors,
						completedGames,
					};
				}

				try {
					const batchResult = await batchAddGamesMutation.mutateAsync(payloads);
					const failedPayloadIndexes = new Set(batchResult.errors.map((error) => error.index));
					let successfulGameIndex = 0;
					for (const pending of pendingPayloads) {
						if (failedPayloadIndexes.has(pending.payloadIndex)) continue;
						const gameId = batchResult.ids?.[successfulGameIndex++];
						if (gameId !== undefined) completedGames.push({ itemIndex: pending.itemIndex, gameId });
					}
					return {
						pendingPayloads,
						duplicates,
						preparationErrors,
						restoredItemIndices,
						restorationErrors,
						completedGames,
						batchResult,
					};
				} catch (error) {
					const mutationError = getUserErrorMessage(
						error,
						i18n.t.bind(i18n),
						i18n.t("errors.unknownError", "未知错误"),
					);
					return {
						pendingPayloads,
						duplicates,
						preparationErrors,
						restoredItemIndices,
						restorationErrors,
						completedGames,
						mutationError,
					};
				}
			} finally {
				setIsPreparingGames(false);
			}
		},
		[batchAddGamesMutation, findMatchingGame, updateGameMutation],
	);

	return {
		addGamesFromBulkImport,
		findBulkImportDuplicates,
		isAddingGames: isPreparingGames,
	};
}
