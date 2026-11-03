/**
 * @file 多数据源混合获取 API 封装
 * @description 同时从 Bangumi、VNDB、YMGal、Kungal 和 DLsite 获取游戏信息，返回各源原始数据
 * @module src/api/mixed
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * 逻辑说明：
 * 1. 根据传入的参数智能获取：
 *    - 只有单个数据源ID：获取该数据，用其名称搜索其他数据源
 *    - 多个数据源ID：并行获取所有指定的数据源
 *    - 只有名称：同时搜索所有数据源
 * 2. 使用安全模式避免单个数据源失败导致整体失败
 * 3. 返回三份原始数据 { bgm_data, vndb_data, ymgal_data }
 *
 * 主要导出：
 * - fetchMixedData：通用混合数据获取，返回 { bgm_data, vndb_data, ymgal_data }
 * - fetchMultiSourceData：多数据源搜索和获取的统一接口
 */

import { AppError, isHttpStatus, toError } from "@/utils/errors";
import type { GameCandidateData, SourceType } from "../types";
import { fetchBgmById, fetchBgmByName } from "./bgm";
import { fetchDlsiteById, fetchDlsiteByName } from "./dlsite";
import { fetchGalgameById, searchGalgame } from "./kun";
import { fetchVndbById, fetchVndbByName } from "./vndb";
import { fetchYmById, fetchYmByName } from "./ymgal";

interface SafeFetchResult {
	data: GameCandidateData[];
	failed: boolean;
}

function isSourceEnabled(
	enabledSources: readonly SourceType[] | undefined,
	source: SourceType,
): boolean {
	return !enabledSources || enabledSources.includes(source);
}

// 辅助函数：安全获取 BGM 数据
async function getBangumiDataSafely(
	name: string,
	bgmToken: string,
	bgm_id?: string,
): Promise<SafeFetchResult> {
	try {
		if (bgm_id) {
			return {
				data: [await fetchBgmById(bgm_id, bgmToken)],
				failed: false,
			};
		}
		const result = await fetchBgmByName(name, bgmToken);
		return { data: result, failed: false };
	} catch (error) {
		if (isHttpStatus(error, 401)) throw error;
		return { data: [], failed: true };
	}
}

// 辅助函数：安全获取 VNDB 数据
async function getVNDBDataSafely(
	searchName: string,
	vndb_id?: string,
): Promise<SafeFetchResult> {
	try {
		if (vndb_id) {
			return { data: [await fetchVndbById(vndb_id)], failed: false };
		}
		const result = await fetchVndbByName(searchName);
		return { data: result, failed: false };
	} catch {
		return { data: [], failed: true };
	}
}

// 辅助函数：安全获取 YMGal 数据
async function getYmgalDataSafely(
	searchName: string,
	ymgal_id?: string,
): Promise<SafeFetchResult> {
	try {
		if (ymgal_id) {
			return { data: [await fetchYmById(ymgal_id)], failed: false };
		}
		const result = await fetchYmByName(searchName);
		return { data: result, failed: false };
	} catch {
		return { data: [], failed: true };
	}
}

// 辅助函数：安全获取 Kungal 数据
async function getKungalDataSafely(
	searchName: string,
	kun_id?: string,
): Promise<SafeFetchResult> {
	try {
		if (kun_id) {
			return {
				data: [await fetchGalgameById(kun_id, { enrichVndb: false })],
				failed: false,
			};
		}
		const result = await searchGalgame(searchName, 1, 12, false, {
			enrichVndb: false,
		});
		return { data: result, failed: false };
	} catch {
		return { data: [], failed: true };
	}
}

async function getDlsiteDataSafely(
	searchName: string,
	dlsite_id?: string,
): Promise<SafeFetchResult> {
	try {
		if (dlsite_id) {
			return { data: [await fetchDlsiteById(dlsite_id)], failed: false };
		}
		const result = await fetchDlsiteByName(searchName);
		return { data: result, failed: false };
	} catch {
		return { data: [], failed: true };
	}
}

function extractNameFromApi(
	apiData: GameCandidateData | undefined,
): string | undefined {
	if (!apiData) return undefined;

	const bgmName = apiData.bgm_data?.name;
	if (bgmName) return bgmName;
	const vndbName = apiData.vndb_data?.name;
	if (vndbName) return vndbName;
	const ymgalName = apiData.ymgal_data?.name;
	if (ymgalName) return ymgalName;
	const kunName = apiData.kun_data?.name;
	if (kunName) return kunName;
	const dlsiteName = apiData.dlsite_data?.name;
	if (dlsiteName) return dlsiteName;
}

/**
 * 多数据源混合数据获取函数
 * 根据新的设计思路：添加游戏只能输入单id、游戏名称两种
 * - 单id：对应源返回单元素列表，并用其名称搜索其他源候选列表
 * - 游戏名称：所有源都返回候选列表
 *
 * @param options 配置选项
 * @param options.bgm_id Bangumi 条目 ID（可选）
 * @param options.vndb_id VNDB 游戏 ID（可选）
 * @param options.ymgal_id YMGal 游戏 ID（可选）
	* @param options.kun_id Kungal 游戏 ID（可选，仅用于更新等非 mixed ID 输入场景）
	* @param options.dlsite_id DLsite 游戏 ID（可选，仅用于更新等非 mixed ID 输入场景）
 * @param options.name 游戏名称（可选）
 * @param options.bgmToken Bangumi API 访问令牌（可选）
 * @returns 返回 { bgm_data, vndb_data, ymgal_data, kun_data } 列表对象
 */
export async function fetchMixedData(options: {
	bgm_id?: string;
	vndb_id?: string;
	ymgal_id?: string;
	kun_id?: string;
	dlsite_id?: string;
	name?: string;
	bgmToken?: string;
	enabledSources?: readonly SourceType[];
}) {
	const {
		bgm_id,
		vndb_id,
		ymgal_id,
		kun_id,
		dlsite_id,
		name,
		bgmToken,
		enabledSources,
	} =
		options;
	const enableBgm = isSourceEnabled(enabledSources, "bgm");
	const enableVndb = isSourceEnabled(enabledSources, "vndb");
	const enableYmgal = isSourceEnabled(enabledSources, "ymgal");
	const enableKun = isSourceEnabled(enabledSources, "kun");
	const enableDlsite = isSourceEnabled(enabledSources, "dlsite");
	const providedIds = [
		enableBgm ? bgm_id : undefined,
		enableVndb ? vndb_id : undefined,
		enableYmgal ? ymgal_id : undefined,
		enableKun ? kun_id : undefined,
		enableDlsite ? dlsite_id : undefined,
	].filter(Boolean).length;

	// 场景1: 单个ID提供 - 获取该数据源，然后用名称搜索其他数据源（取第一个结果）
	if (providedIds === 1) {
		let searchName: string | undefined;
		let bgmResult: SafeFetchResult = { data: [], failed: false };
		let vndbResult: SafeFetchResult = { data: [], failed: false };
		let ymgalResult: SafeFetchResult = { data: [], failed: false };
		let kunResult: SafeFetchResult = { data: [], failed: false };
		let dlsiteResult: SafeFetchResult = { data: [], failed: false };

		if (enableBgm && bgm_id && bgmToken) {
			bgmResult = await getBangumiDataSafely("", bgmToken, bgm_id);
			searchName = extractNameFromApi(bgmResult.data[0]);
		} else if (enableVndb && vndb_id) {
			vndbResult = await getVNDBDataSafely("", vndb_id);
			searchName = extractNameFromApi(vndbResult.data[0]);
		} else if (enableYmgal && ymgal_id) {
			ymgalResult = await getYmgalDataSafely("", ymgal_id);
			searchName = extractNameFromApi(ymgalResult.data[0]);
		} else if (enableKun && kun_id) {
			kunResult = await getKungalDataSafely("", kun_id);
			searchName = extractNameFromApi(kunResult.data[0]);
		} else if (enableDlsite && dlsite_id) {
			dlsiteResult = await getDlsiteDataSafely("", dlsite_id);
			searchName = extractNameFromApi(dlsiteResult.data[0]);
		}

		if (searchName) {
			const [
				nextBgmResult,
				nextVndbResult,
				nextYmgalResult,
				nextKunResult,
				nextDlsiteResult,
			] =
				await Promise.all([
					enableBgm && bgmResult.data.length === 0 && bgmToken
						? getBangumiDataSafely(searchName, bgmToken)
						: Promise.resolve(bgmResult),
					enableVndb && vndbResult.data.length === 0
						? getVNDBDataSafely(searchName)
						: Promise.resolve(vndbResult),
					enableYmgal && ymgalResult.data.length === 0
						? getYmgalDataSafely(searchName)
						: Promise.resolve(ymgalResult),
					enableKun && kunResult.data.length === 0
						? getKungalDataSafely(searchName)
						: Promise.resolve(kunResult),
					enableDlsite && dlsiteResult.data.length === 0
						? getDlsiteDataSafely(searchName)
						: Promise.resolve(dlsiteResult),
				]);
			bgmResult = nextBgmResult;
			vndbResult = nextVndbResult;
			ymgalResult = nextYmgalResult;
			kunResult = nextKunResult;
			dlsiteResult = nextDlsiteResult;
		}

		if (
			bgmResult.failed &&
			vndbResult.failed &&
			ymgalResult.failed &&
			kunResult.failed
			&& dlsiteResult.failed
		) {
			throw new AppError({
				code: "mixed_sources_failed",
				message: "All mixed source requests failed for single-id lookup",
			});
		}

		return {
			bgm_data: bgmResult.data,
			vndb_data: vndbResult.data,
			ymgal_data: ymgalResult.data,
			kun_data: kunResult.data,
			dlsite_data: dlsiteResult.data,
		};
	}

	// 场景2: 只有名称（用于搜索）- 同时搜索所有数据源候选列表
	if (name?.trim()) {
		const searchName = name.trim();
		const [bgmResult, vndbResult, ymgalResult, kunResult, dlsiteResult] =
			await Promise.all([
			enableBgm && bgmToken
				? getBangumiDataSafely(searchName, bgmToken)
				: Promise.resolve({ data: [], failed: false }),
			enableVndb
				? getVNDBDataSafely(searchName)
				: Promise.resolve({ data: [], failed: false }),
			enableYmgal
				? getYmgalDataSafely(searchName)
				: Promise.resolve({ data: [], failed: false }),
			enableKun
				? getKungalDataSafely(searchName)
				: Promise.resolve({ data: [], failed: false }),
			enableDlsite
				? getDlsiteDataSafely(searchName)
				: Promise.resolve({ data: [], failed: false }),
		]);

		if (
			bgmResult.failed &&
			vndbResult.failed &&
			ymgalResult.failed &&
			kunResult.failed
			&& dlsiteResult.failed
		) {
			throw new AppError({
				code: "mixed_sources_failed",
				message: `All mixed source requests failed for search: ${searchName}`,
				cause: toError(undefined, "Mixed search failed"),
			});
		}

		return {
			bgm_data: bgmResult.data,
			vndb_data: vndbResult.data,
			ymgal_data: ymgalResult.data,
			kun_data: kunResult.data,
			dlsite_data: dlsiteResult.data,
		};
	}

	throw new AppError({
		code: "invalid_game_id",
		message: "Mixed fetch requires a single source id or a name query",
	});
}
