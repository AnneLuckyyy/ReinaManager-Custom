import type {
	CustomData,
	GameCandidateData,
	GameData,
	InsertGameParams,
	MixedSourceType,
	SourceIdType,
	SourceType,
	UpdateGameParams,
} from "@/types";
import {
	isSourceType,
	SOURCE_FIELD_KEYS,
} from "@/types";
import {
	getArrayDiff,
	getBoolDiff,
	getDiff,
	getGameDisplayName,
	getGameNsfwStatus,
} from "@/utils/appUtils";
import { resolveCloudPlayStatus } from "@/utils/cloudCollectionSync";
import i18n from "@/utils/i18n";

export interface GameInfoUpdateDraft {
	newLocalPath: string;
	newLaunchType?: "local" | "steam";
	newSteamLaunchId?: string;
	newSteamMonitorPath?: string;
	newName: string;
	newImageExt?: string | null;
	newAliases?: string[];
	newSummary?: string;
	newTags?: string[];
	newDeveloper?: string;
	newNsfw?: boolean;
	newDate?: string;
	/** 备用启动路径 */
	newExtraLocalPaths?: string[];
}

export interface BatchImportGameCandidate {
	name: string;
	path: string;
	selectedExe?: string;
	matchedData?: GameCandidateData;
	launch_type?: "steam";
	steam_launch_id?: string;
	steam_monitor_path?: string;
}

interface SourceUpdateParams {
	selectedGame: GameData | null;
	idType: string;
	bgmId?: string;
	vndbId?: string;
	ymgalId?: string;
	kunId?: string;
	dlsiteId?: string;
	bgmToken?: string;
}

export interface MixedSourceResult {
	bgm_data?: GameCandidateData | null;
	vndb_data?: GameCandidateData | null;
	ymgal_data?: GameCandidateData | null;
	kun_data?: GameCandidateData | null;
	dlsite_data?: GameCandidateData | null;
}

export interface MixedSourceListResult {
	bgm_data?: GameCandidateData[];
	vndb_data?: GameCandidateData[];
	ymgal_data?: GameCandidateData[];
	kun_data?: GameCandidateData[];
	dlsite_data?: GameCandidateData[];
}

interface MixedSourceMergeRule {
	source: MixedSourceType;
	resultKey: keyof MixedSourceResult;
	getDate: (game: GameCandidateData) => string | undefined;
}

export type MixedSourceCandidates = Record<
	MixedSourceType,
	GameCandidateData[]
>;
export type MixedSourceSelection = Partial<
	Record<MixedSourceType, GameCandidateData | null>
>;
export type MixedSourceEnabled = Partial<Record<MixedSourceType, boolean>>;

const mixedSourceMergeRules: readonly MixedSourceMergeRule[] = [
	{
		source: "bgm",
		resultKey: "bgm_data",
		getDate: (game) => game.bgm_data?.date,
	},
	{
		source: "vndb",
		resultKey: "vndb_data",
		getDate: (game) => game.vndb_data?.date,
	},
	{
		source: "ymgal",
		resultKey: "ymgal_data",
		getDate: (game) => game.ymgal_data?.date,
	},
	{
		source: "kun",
		resultKey: "kun_data",
		getDate: (game) => game.date,
	},
	{
		source: "dlsite",
		resultKey: "dlsite_data",
		getDate: (game) => game.dlsite_data?.date,
	},
];

function assertNever(value: never): never {
	throw new Error(`Unhandled source: ${String(value)}`);
}

function assignGameField<Key extends keyof GameCandidateData>(
	target: GameCandidateData,
	source: GameCandidateData,
	key: Key,
): void {
	target[key] = source[key];
}

function mergeSourceIntoGame(
	target: GameCandidateData,
	source: GameCandidateData,
	sourceType: SourceType,
): void {
	const { id: idKey, data: dataKey } = SOURCE_FIELD_KEYS[sourceType];
	assignGameField(target, source, idKey);
	assignGameField(target, source, dataKey);
}

/**
 * 从多个数据源的结果中合并日期信息
 * 优先级：BGM > VNDB > YMGal
 */
function mergeDateFromMixedResult(
	result: MixedSourceResult,
): string | undefined {
	// 合并日期信息，优先级由规则数组的顺序决定
	for (const rule of mixedSourceMergeRules) {
		const sourceGame = result[rule.resultKey];
		const date = sourceGame ? rule.getDate(sourceGame) : undefined;
		if (date) {
			return date;
		}
	}

	return undefined;
}

export function mergeMixedResult(
	result: MixedSourceResult,
): GameCandidateData | null {
	const mergedGame: GameCandidateData = {
		id_type: "mixed",
	};
	let hasMergedSource = false;

	for (const rule of mixedSourceMergeRules) {
		const sourceGame = result[rule.resultKey];
		if (!sourceGame) {
			continue;
		}
		hasMergedSource = true;
		mergeSourceIntoGame(mergedGame, sourceGame, rule.source);
	}

	const mergedDate = mergeDateFromMixedResult(result);
	if (mergedDate) {
		mergedGame.date = mergedDate;
	}

	if (!hasMergedSource) {
		return null;
	}

	return mergedGame;
}

export function pickFirstMixedResult(
	result: MixedSourceListResult,
): MixedSourceResult {
	return {
		bgm_data: result.bgm_data?.[0] ?? null,
		vndb_data: result.vndb_data?.[0] ?? null,
		ymgal_data: result.ymgal_data?.[0] ?? null,
		kun_data: result.kun_data?.[0] ?? null,
		dlsite_data: result.dlsite_data?.[0] ?? null,
	};
}

export function buildGameFromMixedSelection(params: {
	selection: MixedSourceSelection;
	enabled: MixedSourceEnabled;
	defaults?: Partial<GameCandidateData>;
}): GameCandidateData {
	const { selection, enabled, defaults } = params;
	const selectedEntries = mixedSourceMergeRules
		.map(({ source }) => ({
			source,
			game: enabled[source] ? selection[source] : null,
		}))
		.filter((entry): entry is { source: MixedSourceType; game: GameCandidateData } =>
			Boolean(entry.game),
		);

	if (selectedEntries.length === 0) {
		throw new Error("At least one mixed source must be selected");
	}

	if (selectedEntries.length === 1) {
		const [{ source, game }] = selectedEntries;
		const result: GameCandidateData = {
			...defaults,
			id_type: source,
		};
		mergeSourceIntoGame(result, game, source);

		const date =
			mixedSourceMergeRules
				.find((rule) => rule.source === source)
				?.getDate(game) ?? game.date;
		if (date) {
			result.date = date;
		}

		return result;
	}

	const mixedResult = mergeMixedResult({
		bgm_data: enabled.bgm ? selection.bgm : null,
		vndb_data: enabled.vndb ? selection.vndb : null,
		ymgal_data: enabled.ymgal ? selection.ymgal : null,
		kun_data: enabled.kun ? selection.kun : null,
		dlsite_data: enabled.dlsite ? selection.dlsite : null,
	});

	if (!mixedResult) {
		throw new Error("At least one mixed source must be selected");
	}

	return defaults ? { ...defaults, ...mixedResult } : mixedResult;
}

function getSourceUpdateId(
	params: Pick<
		SourceUpdateParams,
		"bgmId" | "vndbId" | "ymgalId" | "kunId" | "dlsiteId"
	>,
	source: SourceType,
): string | undefined {
	switch (source) {
		case "bgm":
			return params.bgmId;
		case "vndb":
			return params.vndbId;
		case "ymgal":
			return params.ymgalId;
		case "kun":
			return params.kunId;
		case "dlsite":
			return params.dlsiteId;
		default:
			return assertNever(source);
	}
}

// ---------------------- 核心业务逻辑区 ----------------------

export async function fetchMetadataForUpdate({
	selectedGame,
	idType,
	bgmId,
	vndbId,
	ymgalId,
	kunId,
	dlsiteId,
	bgmToken,
}: SourceUpdateParams): Promise<GameCandidateData> {
	if (!selectedGame) {
		throw new Error(
			i18n.t("pages.Detail.DataSourceUpdate.noGameSelected", "未选择游戏"),
		);
	}

	if (idType === "custom") {
		throw new Error(
			i18n.t(
				"pages.Detail.DataSourceUpdate.customModeWarning",
				"自定义模式无法从数据源更新。",
			),
		);
	}

	let apiData: GameCandidateData;

	if (idType === "mixed") {
		const { gameMetadataService } = await import("@/api/gameMetadataService");
		apiData = await gameMetadataService.getGameByIds({
			bgmId,
			vndbId,
			ymgalId,
			kunId,
			dlsiteId,
			bgmToken,
		});
	} else if (isSourceType(idType)) {
		const sourceId = getSourceUpdateId(
			{ bgmId, vndbId, ymgalId, kunId, dlsiteId },
			idType,
		);
		if (!sourceId) {
			throw new Error(
				i18n.t("pages.Detail.DataSourceUpdate.invalidIdType", "无效的ID类型"),
			);
		}

		const { gameMetadataService } = await import("@/api/gameMetadataService");
		apiData = await gameMetadataService.getGameById(sourceId, idType, bgmToken);
	} else {
		throw new Error(
			i18n.t("pages.Detail.DataSourceUpdate.invalidIdType", "无效的ID类型"),
		);
	}

	if (!apiData) {
		throw new Error(
			i18n.t(
				"pages.Detail.DataSourceUpdate.noDataFetched",
				"未获取到数据或数据源无效。",
			),
		);
	}

	return apiData;
}

export async function buildInsertGameData(
	gameData: GameCandidateData,
): Promise<InsertGameParams> {
	const insertData: InsertGameParams = {
		bgm_id: gameData.bgm_id,
		vndb_id: gameData.vndb_id,
		ymgal_id: gameData.ymgal_id,
		kun_id: gameData.kun_id,
		dlsite_id: gameData.dlsite_id,
		id_type: gameData.id_type || "mixed",
		date: gameData.date,
		localpath: gameData.localpath ?? undefined,
		bgm_data: gameData.bgm_data ?? undefined,
		vndb_data: gameData.vndb_data ?? undefined,
		ymgal_data: gameData.ymgal_data ?? undefined,
		kun_data: gameData.kun_data ?? undefined,
		dlsite_data: gameData.dlsite_data ?? undefined,
		custom_data: gameData.custom_data ?? undefined,
	};
	const cloudStatus = await resolveCloudPlayStatus(insertData);

	if (cloudStatus === undefined) {
		return insertData;
	}

	return {
		...insertData,
		clear: cloudStatus,
	};
}

function getBatchImportLocalPath(
	item: BatchImportGameCandidate,
): string | undefined {
	if (item.launch_type === "steam") return undefined;
	return item.selectedExe ? `${item.path}\\${item.selectedExe}` : item.path;
}

export function buildMetadataUpdatePayload(
	gameData: GameCandidateData,
): UpdateGameParams {
	return { ...gameData };
}

export function buildGameInfoUpdatePayload(
	originalGame: GameData,
	draft: GameInfoUpdateDraft,
): UpdateGameParams {
	const payload: UpdateGameParams = {};
	const localPathDiff = getDiff(draft.newLocalPath, originalGame.localpath);
	if (localPathDiff !== undefined) {
		payload.localpath = localPathDiff;
	}

	const launchType = draft.newLaunchType ?? "local";
	if (launchType !== (originalGame.launch_type ?? "local")) {
		payload.launch_type = launchType;
	}
	if (launchType === "steam") {
		const steamLaunchIdDiff = getDiff(
			draft.newSteamLaunchId ?? "",
			originalGame.steam_launch_id ?? "",
		);
		if (steamLaunchIdDiff !== undefined) {
			payload.steam_launch_id = steamLaunchIdDiff;
		}
		const steamMonitorPathDiff = getDiff(
			draft.newSteamMonitorPath ?? "",
			originalGame.steam_monitor_path ?? "",
		);
		if (steamMonitorPathDiff !== undefined) {
			payload.steam_monitor_path = steamMonitorPathDiff;
		}
	}

	const currentCustomData = originalGame.custom_data || {};
	const displayName = getGameDisplayName(originalGame);
	const currentCustomName = currentCustomData.name || displayName;
	const originalSummary = originalGame.summary ?? "";
	const originalDeveloper = originalGame.developer ?? "";
	const originalNsfw = getGameNsfwStatus(originalGame) ?? false;
	const originalDate = originalGame.date ?? "";
	const nextCustomData: CustomData = { ...currentCustomData };
	let customDataChanged = false;

	const nameDiff = getDiff(draft.newName, currentCustomName);
	if (nameDiff !== undefined) {
		nextCustomData.name = nameDiff;
		customDataChanged = true;
	}

	if (draft.newImageExt !== undefined) {
		nextCustomData.image = draft.newImageExt;
		customDataChanged = true;
	}

	if (draft.newAliases !== undefined) {
		const aliasesDiff = getArrayDiff(
			draft.newAliases,
			currentCustomData.aliases,
		);
		if (aliasesDiff !== undefined) {
			nextCustomData.aliases = aliasesDiff;
			customDataChanged = true;
		}
	}

	if (draft.newSummary !== undefined) {
		const summaryDiff = getDiff(draft.newSummary, originalSummary);
		if (summaryDiff !== undefined) {
			nextCustomData.summary = summaryDiff;
			customDataChanged = true;
		}
	}

	if (draft.newTags !== undefined) {
		const tagsDiff = getArrayDiff(draft.newTags, currentCustomData.tags);
		if (tagsDiff !== undefined) {
			nextCustomData.tags = tagsDiff;
			customDataChanged = true;
		}
	}

	if (draft.newDeveloper !== undefined) {
		const developerDiff = getDiff(draft.newDeveloper, originalDeveloper);
		if (developerDiff !== undefined) {
			nextCustomData.developer = developerDiff;
			customDataChanged = true;
		}
	}

	if (draft.newNsfw !== undefined) {
		const nsfwDiff = getBoolDiff(draft.newNsfw, originalNsfw);
		if (nsfwDiff !== undefined) {
			nextCustomData.nsfw = nsfwDiff;
			customDataChanged = true;
		}
	}

	if (draft.newDate !== undefined) {
		const dateDiff = getDiff(draft.newDate, originalDate);
		if (dateDiff !== undefined) {
			nextCustomData.date = dateDiff;
			customDataChanged = true;
		}
	}

	if (draft.newExtraLocalPaths !== undefined) {
		const pathsDiff = getArrayDiff(
			draft.newExtraLocalPaths,
			currentCustomData.extraLocalPaths,
		);
		if (pathsDiff !== undefined) {
			// null 或 [] 时清空
			nextCustomData.extraLocalPaths = pathsDiff === null
				? null
				: pathsDiff.length === 0
					? null
					: pathsDiff;
			customDataChanged = true;
		}
	}

	if (customDataChanged) {
		payload.custom_data = nextCustomData;
	}

	return payload;
}

export async function buildBulkImportGameData(
	item: BatchImportGameCandidate,
): Promise<InsertGameParams> {
	if (item.matchedData) {
		const insertData = await buildInsertGameData(item.matchedData);
		return {
			...insertData,
			localpath: getBatchImportLocalPath(item),
			launch_type: item.launch_type,
			steam_launch_id: item.steam_launch_id,
			steam_monitor_path: item.steam_monitor_path,
		};
	}

	return {
		id_type: "custom",
		custom_data: {
			name: item.name,
		},
		localpath: getBatchImportLocalPath(item),
		launch_type: item.launch_type,
		steam_launch_id: item.steam_launch_id,
		steam_monitor_path: item.steam_monitor_path,
	};
}

export function getGameIdentityKeys(
	payload: Pick<InsertGameParams, SourceIdType>,
): string[] {
	return [
		payload.bgm_id ? `bgm:${payload.bgm_id}` : null,
		payload.vndb_id ? `vndb:${payload.vndb_id}` : null,
		payload.ymgal_id ? `ymgal:${payload.ymgal_id}` : null,
		payload.kun_id ? `kun:${payload.kun_id}` : null,
		payload.dlsite_id ? `dlsite:${payload.dlsite_id}` : null,
	].filter((value): value is string => Boolean(value));
}
