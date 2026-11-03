import Fuse from "fuse.js";
import type {
	BackupArchiveRecord,
	BackupAutoMatchAssignment,
	BackupMatchNameFill,
} from "@/services/invoke";
import type { FullGameData, GameData } from "@/types";
import { getDisplayGameData } from "@/utils/dataTransform";
import { deriveBackupMatchName } from "@/utils/backupMatchName";
import { getGameDisplayName } from "@/utils/appUtils";

export interface BackupMatchingGame {
	full: FullGameData;
	display: GameData;
	displayName: string;
	matchName: string;
	matchNameSuggested: boolean;
	searchText: string;
}

export interface BackupMatchingAnalysis {
	games: BackupMatchingGame[];
	nameFills: BackupMatchNameFill[];
	autoMatches: BackupAutoMatchAssignment[];
	confirmedAutoMatches: BackupAutoMatchAssignment[];
	doubtfulAutoMatches: BackupAutoMatchAssignment[];
	suggestedGameByArchive: Map<number, number>;
}

export function normalizeBackupMatchName(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function withoutTerminalDuplicateSuffix(value: string): string {
	return value.replace(/\s*[（(]\d+[）)]\s*$/u, "").trim();
}

function numberSignature(value: string): string {
	return normalizeBackupMatchName(value).match(/\d+/g)?.join("|") ?? "";
}

export function prepareBackupMatchingGames(
	fullGames: FullGameData[],
): BackupMatchingGame[] {
	return fullGames.map((full) => {
		const display = getDisplayGameData(full);
		const storedName = full.custom_data?.backupMatchName?.trim() ?? "";
		const derivedName =
			!storedName && full.custom_data?.backupMatchNameManual !== true
				? deriveBackupMatchName(
						full.localpath,
						full.custom_data?.extraLocalPaths,
					)
				: "";
		const matchName = storedName || derivedName;
		const displayName = getGameDisplayName(display) || `#${full.id}`;
		return {
			full,
			display,
			displayName,
			matchName,
			matchNameSuggested: Boolean(derivedName),
			searchText: [
				displayName,
				display.name,
				display.name_cn,
				matchName,
				full.localpath,
				...(full.custom_data?.extraLocalPaths ?? []),
			]
				.filter(Boolean)
				.join(" "),
		};
	});
}

export function analyzeBackupMatching(
	archives: BackupArchiveRecord[],
	fullGames: FullGameData[],
): BackupMatchingAnalysis {
	const games = prepareBackupMatchingGames(fullGames);
	const nameFills = games
		.filter((game) => game.matchNameSuggested)
		.map((game) => ({ gameId: game.full.id, matchName: game.matchName }));
	const gamesByName = new Map<string, BackupMatchingGame[]>();
	for (const game of games) {
		const key = normalizeBackupMatchName(game.matchName);
		if (!key) continue;
		const group = gamesByName.get(key) ?? [];
		group.push(game);
		gamesByName.set(key, group);
	}

	const fuse = new Fuse(games, {
		keys: [
			{ name: "matchName", weight: 0.55 },
			{ name: "displayName", weight: 0.3 },
			{ name: "searchText", weight: 0.15 },
		],
		includeScore: true,
		ignoreLocation: true,
		threshold: 0.42,
		minMatchCharLength: 2,
	});
	const confirmedAutoMatches: BackupAutoMatchAssignment[] = [];
	const doubtfulAutoMatches: BackupAutoMatchAssignment[] = [];
	const suggestedGameByArchive = new Map<number, number>();

	for (const archive of archives) {
		if (!archive.isPresent || archive.matchStatus) continue;
		const primaryKey = normalizeBackupMatchName(archive.baseName);
		const primaryCandidates = gamesByName.get(primaryKey) ?? [];
		let exactCandidates = primaryCandidates;
		let comparisonName = archive.baseName;
		if (exactCandidates.length === 0) {
			const strippedName = withoutTerminalDuplicateSuffix(archive.baseName);
			if (strippedName !== archive.baseName) {
				comparisonName = strippedName;
				exactCandidates =
					gamesByName.get(normalizeBackupMatchName(strippedName)) ?? [];
			}
		}

		if (exactCandidates.length === 1) {
			const gameId = exactCandidates[0].full.id;
			confirmedAutoMatches.push({
				archiveId: archive.id,
				gameId,
				score: 1,
				confirmed: true,
			});
			suggestedGameByArchive.set(archive.id, gameId);
			continue;
		}
		if (exactCandidates.length > 1) {
			continue;
		}

		const archivePathHint = archive.relativeDirectory
			.split(/[\\/]/u)
			.map((part) => part.trim())
			.filter((part) => normalizeBackupMatchName(part).length >= 4)
			.at(-1);
		const fuzzyCandidates = fuse.search(comparisonName, { limit: 3 });
		const pathCandidates = archivePathHint
			? fuse.search(archivePathHint, { limit: 3 })
			: [];
		const rankedCandidates = [...fuzzyCandidates, ...pathCandidates]
			.reduce<typeof fuzzyCandidates>((unique, candidate) => {
				const existingIndex = unique.findIndex(
					(item) => item.item.full.id === candidate.item.full.id,
				);
				if (existingIndex === -1) unique.push(candidate);
				else if ((candidate.score ?? 1) < (unique[existingIndex].score ?? 1)) {
					unique[existingIndex] = candidate;
				}
				return unique;
			}, [])
			.toSorted((left, right) => (left.score ?? 1) - (right.score ?? 1));
		const best = rankedCandidates[0];
		const second = rankedCandidates[1];
		const bestScore = best?.score ?? 1;
		const secondScore = second?.score ?? 1;
		if (
			best &&
			bestScore <= 0.42 &&
			secondScore - bestScore >= 0.06 &&
			numberSignature(comparisonName) ===
				numberSignature(best.item.matchName || best.item.displayName)
		) {
			const match = {
				archiveId: archive.id,
				gameId: best.item.full.id,
				score: Math.max(0, 1 - bestScore),
				confirmed: false,
			};
			doubtfulAutoMatches.push(match);
			suggestedGameByArchive.set(archive.id, match.gameId);
		}
	}
	const autoMatches = [...confirmedAutoMatches, ...doubtfulAutoMatches];

	return {
		games,
		nameFills,
		autoMatches,
		confirmedAutoMatches,
		doubtfulAutoMatches,
		suggestedGameByArchive,
	};
}

export function searchBackupMatchingGames(
	games: BackupMatchingGame[],
	query: string,
	limit = 30,
): BackupMatchingGame[] {
	const trimmed = query.trim();
	if (!trimmed) {
		return games
			.toSorted((left, right) =>
				left.displayName.localeCompare(right.displayName, undefined, {
					numeric: true,
				}),
			)
			.slice(0, limit);
	}
	return new Fuse(games, {
		keys: ["matchName", "displayName", "searchText"],
		ignoreLocation: true,
		threshold: 0.48,
	}).search(trimmed, { limit }).map((result) => result.item);
}
