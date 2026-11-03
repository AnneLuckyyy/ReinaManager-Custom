/// <reference types="node" />
import { path } from "@tauri-apps/api";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resourceDir } from "@tauri-apps/api/path";
import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import { readDir, stat } from "@tauri-apps/plugin-fs";
import { type } from "@tauri-apps/plugin-os";
import i18next, { t } from "i18next";
import { extname, join } from "pathe";
import { fetchBgmByIds } from "@/api/bgm";
import { fetchVNDBByIds } from "@/api/vndb";
import { setScrollPosition } from "@/hooks/common/useScrollRestore";
import { patchManyGameCaches } from "@/hooks/queries/gameCachePatch";
import { gameKeys } from "@/hooks/queries/useGames";
import { fetchAllSettings } from "@/hooks/queries/useSettings";
import { queryClient } from "@/providers/queryClient";
import { snackbar } from "@/providers/snackBar";
import {
	fileService,
	gameService,
	savedataService,
	statsService,
} from "@/services/invoke";
import type { SteamLaunchTarget } from "@/services/invoke/fileService";
import type { BgmData, GameData, StopGameResult, VndbData } from "@/types";
import { withBgmAuth } from "@/utils/bgmAuthSession";
import { toError } from "./errors";

// ==================== 路径管理缓存 ====================

// 缓存应用基础数据路径
let cachedAppDataDir: string | null = null;

/**
 * 路径初始化结果类型
 */
interface PathInitResult {
	resourceDir: string; // 资源目录路径
	appDataDir: string; // 应用基础数据根目录（便携或标准）
}

/**
 * 初始化所有路径缓存
 * 应该在应用启动时调用一次
 * @returns 所有路径信息
 */
export const initPathCache = async (): Promise<PathInitResult> => {
	const [resourceDirPath, systemAppDataDir] = await Promise.all([
		resourceDir(),
		path.appDataDir(),
	]);
	const baseResourceDir = join(resourceDirPath, "resources");
	const portableModeResult = await fileService.isPortableMode();

	cachedAppDataDir = portableModeResult.is_portable
		? baseResourceDir
		: systemAppDataDir;

	return {
		resourceDir: baseResourceDir,
		appDataDir: cachedAppDataDir,
	};
};

/**
 * 获取缓存的应用数据目录（同步）
 * 如果未初始化则返回空字符串
 */
export const getAppDataDirPath = (): string => {
	if (!cachedAppDataDir) {
		throw new Error(
			"❌ 严重错误：路径缓存未初始化！请确保在访问文件系统前已完成 initPathCache。",
		);
	}
	return cachedAppDataDir;
};

/**
 * 获取数据库备份路径（异步）
 */
export const getDbBackupPath = async (): Promise<string> => {
	try {
		const settings = await fetchAllSettings(queryClient);
		const backupDir = settings.db_backup_path ?? "";
		const backupFinalDir = join(getAppDataDirPath(), "data", "backups");
		return backupDir ? backupDir : backupFinalDir;
	} catch (error) {
		console.error("获取数据库备份路径失败:", error);
		const backupFinalDir = join(getAppDataDirPath(), "data", "backups");
		return backupFinalDir;
	}
};

export const getLocalDateString = (timestamp?: number): string => {
	const date = timestamp ? new Date(timestamp * 1000) : new Date();
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

interface AbortableRunner {
	controller: AbortController;
	withAbort: <T>(promise: Promise<T>) => Promise<T>;
}

/**
 * 清理路径两边的引号并去除空格
 * @param input 原始输入
 * @returns 清理后的路径
 */
export function cleanPathQuotes(input: string): string {
	const trimmed = input.trim();

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}

	return trimmed;
}

export const createAbortableRunner = (): AbortableRunner => {
	const controller = new AbortController();
	const abortPromise = new Promise<never>((_, reject) => {
		controller.signal.addEventListener(
			"abort",
			() => {
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});

	const withAbort = <T>(promise: Promise<T>) =>
		Promise.race([promise, abortPromise]) as Promise<T>;

	return {
		controller,
		withAbort,
	};
};

export const isAbortError = (error: unknown): boolean => {
	return error instanceof DOMException && error.name === "AbortError";
};

export const handleOpenFolder = async (
	selectedGame: Pick<GameData, "localpath" | "launch_type" | "steam_monitor_path" | "custom_data">,
) => {
	const isSteamLaunch = selectedGame.launch_type === "steam";
	const fallbackPath = [...(selectedGame.custom_data?.extraLocalPaths ?? [])]
		.reverse()
		.find((value) => value?.trim());
	const configuredPath = isSteamLaunch
		? selectedGame.steam_monitor_path
		: selectedGame.localpath?.trim() || fallbackPath;

	if (!configuredPath) {
		snackbar.error(i18next.t("components.Snackbar.failedOpenGameFolder", "打开游戏文件夹失败"));
		return;
	}

	try {
		const folder = isSteamLaunch
			? configuredPath
			: await path.dirname(configuredPath);
		if (!folder) throw new Error("游戏目录为空");
		try {
			await fileService.openDirectory(folder);
			return;
		} catch (error) {
			const parentFolder = await path.dirname(folder);
			if (!parentFolder || parentFolder === folder) throw error;
			snackbar.warning(i18next.t("components.Snackbar.openGameFolderFallback", "未能打开游戏目录，正在尝试上级目录"));
			await fileService.openDirectory(parentFolder);
		}
	} catch (error) {
		snackbar.error(
			i18next.t(
				"components.Snackbar.failedOpenGameFolder",
				"打开游戏文件夹失败",
			),
		);
		console.error("打开文件夹失败:", error);
	}
};

// 启动游戏并开始监控
export async function launchGameWithTracking(
	gameId: number,
	args?: string[],
	launchPath?: string,
	magpieHotkey?: string,
): Promise<{
	success: boolean;
	message: string;
	process_id?: number;
	warning?: string;
}> {
	try {
		const result = await statsService.launchGame(
			gameId,
			args || [],
			launchPath,
			magpieHotkey,
		);

		return result;
	} catch (error) {
		throw toError(error, "Failed to launch game");
	}
}

// 停止游戏
export async function stopGameWithTracking(
	gameId: number,
): Promise<StopGameResult> {
	try {
		const result = await statsService.stopGame(gameId);
		return result;
	} catch (error) {
		throw toError(error, "Failed to stop game");
	}
}

export function formatRelativeTime(time: string | number | Date): string {
	const now = new Date();
	const target =
		time instanceof Date
			? time
			: typeof time === "number"
				? new Date(time * (time.toString().length === 10 ? 1000 : 1))
				: new Date(time);

	const diff = (now.getTime() - target.getTime()) / 1000; // 秒

	if (diff < 60) return i18next.t("utils.relativetime.justNow", "刚刚"); // 刚刚
	if (diff < 3600) {
		const minutes = Math.floor(diff / 60);
		return i18next.t("utils.relativetime.minutesAgo", "{{count}}分钟前", {
			count: minutes,
		});
	}
	if (diff < 86400) {
		const hours = Math.floor(diff / 3600);
		return i18next.t("utils.relativetime.hoursAgo", "{{count}}小时前", {
			count: hours,
		});
	}
	if (diff < 7 * 86400) {
		const days = Math.floor(diff / 86400);
		return i18next.t("utils.relativetime.daysAgo", "{{count}}天前", {
			count: days,
		});
	}

	// 判断是否为上周
	const nowWeek = getWeekNumber(now);
	const targetWeek = getWeekNumber(target);
	if (
		now.getFullYear() === target.getFullYear() &&
		nowWeek - targetWeek === 1
	) {
		return i18next.t("utils.relativetime.lastWeek", "上周");
	}

	// 超过一周，返回日期
	return target.toLocaleDateString();
}

function getWeekNumber(date: Date): number {
	const firstDay = new Date(date.getFullYear(), 0, 1);
	const dayOfYear = (date.getTime() - firstDay.getTime()) / 86400000 + 1;
	return Math.ceil(dayOfYear / 7);
}

// 格式化游戏时间
export function formatPlayTime(minutes: number): string {
	if (!minutes)
		return i18next.t("utils.formatPlayTime.minutes", "{{count}}分钟", {
			count: 0,
		});

	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;

	// 如果总小时数大于或等于 100
	if (hours >= 100) {
		// 将总分钟数换算成带一位小数的小时
		const totalHoursAsFloat = Math.floor((minutes / 60) * 10) / 10;
		// 使用一个新的 i18next key 来格式化这个带小数的小时数
		return i18next.t("utils.formatPlayTime.hours", "{{count}}小时", {
			count: totalHoursAsFloat,
		});
	}

	if (hours === 0) {
		return i18next.t("utils.formatPlayTime.minutes", "{{count}}分钟", {
			count: mins,
		});
	}

	if (mins > 0) {
		return i18next.t(
			"utils.formatPlayTime.hoursAndMinutes",
			"{{hours}}小时{{minutes}}分钟",
			{
				hours,
				minutes: mins,
			},
		);
	}
	return i18next.t("utils.formatPlayTime.hours", "{{count}}小时", {
		count: hours,
	});
}

export const handleFolder = async () => {
	const path = await openDirectory({
		multiple: false,
		directory: true,
		filters: [
			{
				name: t("utils.handleDirectory.folder", "文件夹"),
				extensions: ["*"],
			},
		],
	});
	if (path === null) return null;
	return path;
};

export const handleExeFile = async (defaultPath: string = "") => {
	const path = await openDirectory({
		multiple: false,
		directory: false,
		defaultPath: defaultPath ? cleanPathQuotes(defaultPath) : undefined,
		filters: [
			{
				name: t("utils.handleDirectory.executable", "可执行文件"),
				extensions: ["exe", "bat", "cmd"],
			},
			{
				name: t("utils.handleDirectory.allFiles", "所有文件"),
				extensions: ["*"],
			},
		],
	});
	if (path === null) return null;
	return cleanPathQuotes(path);
};

export type LaunchFileSelection =
	| { launchType: "local"; path: string }
	| { launchType: "steam"; path: string; target: SteamLaunchTarget };

/**
 * 选择本地启动程序或 Steam 快捷方式。解析快捷方式只读取其启动标识，
 * 不会在选择阶段启动 Steam 或修改游戏记录。
 */
export const handleLaunchFile = async (
	defaultPath: string = "",
): Promise<LaunchFileSelection | null> => {
	const selected = await openDirectory({
		multiple: false,
		directory: false,
		defaultPath: defaultPath ? cleanPathQuotes(defaultPath) : undefined,
		filters: [
			{
				name: t("utils.handleDirectory.launchFile", "启动程序或 Steam 快捷方式"),
				extensions: ["exe", "bat", "cmd", "url", "desktop"],
			},
			{
				name: t("utils.handleDirectory.allFiles", "所有文件"),
				extensions: ["*"],
			},
		],
	});
	if (selected === null) return null;

	const path = cleanPathQuotes(selected);
	const extension = extname(path).toLowerCase();
	if (extension === ".url" || extension === ".desktop") {
		const target = await fileService.resolveSteamShortcutFile(path);
		if (!target) {
			snackbar.error(
				t("components.AddModal.invalidSteamShortcut", "未找到有效的 Steam 启动地址"),
			);
			return null;
		}
		return { launchType: "steam", path, target };
	}
	return { launchType: "local", path };
};

const EXECUTABLE_EXTENSIONS = [".exe", ".bat", ".cmd"];

/**
 * 判断文件是否为可执行文件
 * @param filePath 文件路径
 * @returns 是否为可执行文件
 */
const isExecutableFile = (filePath: string): boolean => {
	const ext = extname(filePath).toLowerCase();
	return EXECUTABLE_EXTENSIONS.includes(ext);
};

/**
 * 获取目录下所有可执行文件（非递归）
 * @param dirPath 目录路径
 * @returns 可执行文件路径数组
 */
const getExecutablesInDirectory = async (
	dirPath: string,
): Promise<string[]> => {
	try {
		const entries = await readDir(dirPath);
		const executables: string[] = [];

		for (const entry of entries) {
			// 只处理文件，不递归子目录
			if (!entry.isDirectory && entry.name) {
				const fullPath = join(dirPath, entry.name);
				if (isExecutableFile(entry.name)) {
					executables.push(fullPath);
				}
			}
		}

		return executables;
	} catch (error) {
		console.error("读取目录失败:", error);
		return [];
	}
};

/**
 * 处理拖拽的文件或文件夹路径
 * @param droppedPath 拖拽的路径
 * @returns 选中的可执行文件路径，如果失败返回 null
 */
export const handleDroppedPath = async (
	droppedPathRaw: string,
): Promise<LaunchFileSelection | null> => {
	const droppedPath = cleanPathQuotes(droppedPathRaw);
	try {
		// 检查路径类型
		const fileInfo = await stat(droppedPath);

		if (fileInfo.isDirectory) {
			// 拖入的是文件夹，读取其中的可执行文件
			const executables = await getExecutablesInDirectory(droppedPath);

			if (executables.length === 0) {
				// 没有可执行文件
				snackbar.error(
					t("components.AddModal.emptyFolder", "该文件夹中没有找到可执行文件"),
				);
				return null;
			}

			if (executables.length === 1) {
				// 只有一个可执行文件，直接使用
				return { launchType: "local", path: executables[0] };
			}

			// 多个可执行文件，弹出系统对话框让用户选择
			snackbar.info(
				t(
					"components.AddModal.selectFromFolder",
					"文件夹中有多个可执行文件，请选择一个",
				),
			);
			const selected = await handleExeFile(droppedPath);

			return selected ? { launchType: "local", path: selected } : null;
		}
		// 拖入的是文件
		if (isExecutableFile(droppedPath)) {
			return { launchType: "local", path: droppedPath };
		}
		if ([".url", ".desktop"].includes(extname(droppedPath).toLowerCase())) {
			const target = await fileService.resolveSteamShortcutFile(droppedPath);
			if (target) {
				return { launchType: "steam", path: droppedPath, target };
			}
			snackbar.error(
				t("components.AddModal.invalidSteamShortcut", "未找到有效的 Steam 启动地址"),
			);
			return null;
		}
		// 不是可执行文件
		snackbar.error(
			t(
				"components.AddModal.invalidFile",
				"请拖入有效的可执行文件（.exe/.bat/.cmd）或文件夹",
			),
		);
		return null;
	} catch (error) {
		console.error("处理拖拽路径失败:", error);
		snackbar.error(
			t(
				"components.AddModal.invalidFile",
				"请拖入有效的可执行文件（.exe/.bat/.cmd）或文件夹",
			),
		);
		return null;
	}
};

export const handleGetFolder = async (defaultPath?: string) => {
	const path = await openDirectory({
		multiple: false,
		directory: true,
		defaultPath: defaultPath ? cleanPathQuotes(defaultPath) : undefined,
		filters: [
			{
				name: "存档文件夹",
				extensions: ["*"],
			},
		],
	});
	if (path === null) return null;
	return cleanPathQuotes(path);
};

/** 选择单个存档文件或文件夹；返回值仍统一经路径清洗。 */
export const handleGetSaveDataPath = async (defaultPath?: string) => {
	const path = await openDirectory({
		multiple: false,
		directory: false,
		defaultPath: defaultPath ? cleanPathQuotes(defaultPath) : undefined,
	});
	if (path === null) return null;
	return cleanPathQuotes(path);
};

/**
 * 获取游戏的所有可用路径（主路径 + 备用路径）
 * 返回有序数组：localpath 在前，extraLocalPaths 在后
 */
export function getAllGamePaths(game: { localpath?: string | null; custom_data?: { extraLocalPaths?: string[] | null } | null }): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const addPath = (value?: string | null) => {
		if (!value?.trim()) return;
		const cleaned = cleanPathQuotes(value);
		if (!cleaned) return;
		const comparisonKey = import.meta.env.TAURI_ENV_PLATFORM === "windows"
			? cleaned.replaceAll("/", "\\").toLowerCase()
			: cleaned;
		if (seen.has(comparisonKey)) return;
		seen.add(comparisonKey);
		paths.push(cleaned);
	};

	addPath(game.localpath);
	const extras = game.custom_data?.extraLocalPaths;
	if (extras && Array.isArray(extras)) {
		for (const p of extras) {
			addPath(p);
		}
	}
	return paths;
}

/**
 * 根据现有主路径和备用路径生成指定盘符范围内的候选路径。
 * 仅生成 Windows 盘符绝对路径，不扫描磁盘，并排除已有候选。
 */
export function getDriveSubstitutionPaths(
	game: {
		localpath?: string | null;
		custom_data?: { extraLocalPaths?: string[] | null } | null;
	},
	startDrive: string,
	endDrive: string,
): string[] {
	if (import.meta.env.TAURI_ENV_PLATFORM !== "windows") return [];

	const sources = getAllGamePaths(game);
	const startCode = startDrive.toUpperCase().charCodeAt(0);
	const endCode = endDrive.toUpperCase().charCodeAt(0);
	if (
		startCode < "A".charCodeAt(0) ||
		endCode > "Z".charCodeAt(0) ||
		startCode > endCode
	) {
		return [];
	}

	const comparisonKey = (value: string) =>
		value.replaceAll("/", "\\").toLowerCase();
	const seen = new Set(sources.map(comparisonKey));
	const generated: string[] = [];

	for (let driveCode = startCode; driveCode <= endCode; driveCode++) {
		const drive = String.fromCharCode(driveCode);
		for (const source of sources) {
			const match = source.match(/^[A-Za-z]:[\\/](.+)$/);
			if (!match) continue;
			const candidate = `${drive}:\\${match[1].replaceAll("/", "\\")}`;
			const key = comparisonKey(candidate);
			if (seen.has(key)) continue;
			seen.add(key);
			generated.push(candidate);
		}
	}

	return generated;
}

/**
 * 获取第一个有效的游戏路径（用于启动时的 fallback 尝试）
 * 仅用于启动逻辑，其他功能请直接读取 localpath
 */
export function getFirstValidGamePath(game: { localpath?: string | null; custom_data?: { extraLocalPaths?: string[] | null } | null }): string | null {
	const allPaths = getAllGamePaths(game);
	return allPaths.length > 0 ? allPaths[0] : null;
}

export const getGameDisplayName = (game: GameData): string => {
	if (game.custom_data?.name) {
		return game.custom_data.name;
	}
	// 只有当语言为zh-CN时才使用name_cn，其他语言都使用name
	return i18next.language === "zh-CN" && game.name_cn
		? game.name_cn
		: game.name || "";
};

export const getcustomCoverFolder = (gameID: number): string => {
	const resourceFolder = getAppDataDirPath();
	const customCoverFolder = join(resourceFolder, "covers", `game_${gameID}`);
	return customCoverFolder;
};

export const getGameCover = (game: GameData): string => {
	// 如果有自定义封面扩展名，构造自定义封面路径
	if (game.custom_data?.image) {
		// 获取缓存的资源目录路径
		const customCoverFolder = getcustomCoverFolder(game.id);
		if (customCoverFolder) {
			// 使用数据库的custom_cover字段作为完整文件名（包含版本信息）
			// 例如：custom_cover = "jpg_1703123456789"
			const customCoverPath = join(
				customCoverFolder,
				`cover_${game.id}_${game.custom_data.image}`,
			);

			try {
				return convertFileSrc(customCoverPath);
			} catch (error) {
				console.error("转换自定义封面路径失败:", error);
			}
		}
	}

	// 网络封面统一交给 Rust 自定义协议处理，以支持本地缓存
	if (game.image) {
		const base =
			type() === "windows"
				? "http://reina-cover.localhost"
				: "reina-cover://localhost";
		return `${base}/${game.id}?url=${game.image}`;
	}

	return "/images/default.png";
};

/**
 * 通用的创建游戏存档备份函数
 * @param gameId 游戏ID
 * @param saveDataPath 存档路径
 * @param skipPathCheck 是否跳过路径检查（用于自动备份）
 * @returns 备份信息
 */
export async function createGameSavedataBackup(
	gameId: number,
	saveDataPath: string,
): Promise<{ folder_name: string; backup_time: number; file_size: number }> {
	try {
		// 创建备份（备份路径由后端根据配置自动确定）
		const backupInfo = await savedataService.createBackup(gameId, saveDataPath);

		return backupInfo;
	} catch (error) {
		console.error("创建游戏存档备份失败:", error);
		throw error;
	}
}

/**
 * 打开游戏备份文件夹
 * @param gameId 游戏ID
 */
export async function openGameBackupFolder(gameId: number): Promise<void> {
	await savedataService.openBackupFolder(gameId);
}

/**
 * 打开游戏存档文件夹
 * @param saveDataPath 存档路径
 */
export async function openGameSaveDataFolder(
	saveDataPath: string,
): Promise<void> {
	if (!saveDataPath) {
		throw new Error("存档路径不能为空");
	}
	await fileService.openDirectory(saveDataPath);
}

/**
 * 打开数据库备份文件夹
 */
export async function openDatabaseBackupFolder(): Promise<void> {
	try {
		const backupPath = await getDbBackupPath();
		await fileService.openDirectory(backupPath);
	} catch (error) {
		snackbar.error(
			i18next.t(
				"components.Snackbar.failedOpenDatabaseBackupFolder",
				"打开数据库备份文件夹失败",
			),
		);
		console.error("打开数据库备份文件夹失败:", error);
		throw error;
	}
}

// 纯 ASCII 字符正则，提升为模块级常量避免循环中重复创建
// biome-ignore lint/suspicious/noControlCharactersInRegex: 允许 ASCII 范围检查
const ASCII_ONLY_RE = /^[\x00-\x7F]+$/;

/**
 * 根据tags判断是否为NSFW
 * @param tags
 */
const isNsfwGame = (tags: string[]): boolean => {
	if (tags.length === 0) return false;

	if (tags.some((tag) => tag.includes("R18") || tag === "拔作")) {
		// 1. 显式 R18 或 拔作
		return true;
	}

	// 2. 纯英文标签且无 "No Sexual Content" (沿用你原本的逻辑)
	const isAllEnglish = tags.every((tag) => ASCII_ONLY_RE.test(tag));
	return isAllEnglish && !tags.includes("No Sexual Content");
};

/**
 * 统一判断单个游戏是否为 NSFW
 * 策略：优先读取 game.nsfw 字段，如果为 null/undefined 则回退到标签判断
 */
export const getGameNsfwStatus = (game: GameData): boolean => {
	return game.nsfw ?? isNsfwGame(game.tags || []);
};

/**
 * 应用 NSFW 过滤器
 */
export function applyNsfwFilter(
	data: GameData[],
	enableFilter: boolean,
): GameData[] {
	// 如果没开启过滤，直接返回原数据（这是最快路径）
	if (!enableFilter) return data;

	// 过滤掉判定为 NSFW 的游戏
	return data.filter((game) => !getGameNsfwStatus(game));
}

//主动保存指定路径的滚动条位置
export const saveScrollPosition = (path: string) => {
	const SCROLL_CONTAINER_SELECTOR = "main";
	const container = document.querySelector<HTMLElement>(
		SCROLL_CONTAINER_SELECTOR,
	);

	// 增加一个检查，确保容器是可滚动的，避免无效保存
	if (container && container.scrollHeight > container.clientHeight) {
		const scrollTop = container.scrollTop;
		setScrollPosition(path, scrollTop);
	}
};

/**
 * 批量更新数据的通用函数
 * @param type 数据类型 ('vndb' | 'bgm')
 * @param fetchFunction 批量获取数据的函数
 * @param getAllIdsFunction 获取所有 ID 的函数
 * @param updateKeyName 更新字段的名称 ('vndb_data' | 'bgm_data')
 * @param token BGM Token (仅当 type 为 'bgm' 时需要)
 * @returns 返回更新结果统计
 */
async function batchUpdateCommon(
	type: "vndb" | "bgm",
	fetchFunction: (
		ids: string[],
		token?: string,
	) => Promise<
		Array<{
			bgm_id?: string | null;
			vndb_id?: string | null;
			bgm_data?: BgmData | null;
			vndb_data?: VndbData | null;
		}>
	>,
	getAllIdsFunction: () => Promise<Array<[number, string]>>,
	updateKeyName: "vndb_data" | "bgm_data",
	token?: string,
): Promise<{
	total: number;
	success: number;
	failed: number;
}> {
	try {
		// 1. 获取所有游戏的对应 ID
		const idPairs = await getAllIdsFunction();
		console.log(`Found ${type.toUpperCase()} ID pairs:`, idPairs);

		if (idPairs.length === 0) {
			return {
				total: 0,
				success: 0,
				failed: 0,
			};
		}

		// 2. 提取 ID 列表
		const ids = idPairs.map(([_, id]) => id);

		// 3. 批量获取数据
		const resultsTemp = token
			? await fetchFunction(ids, token)
			: await fetchFunction(ids);
		const resultByApiId = new Map<string, (typeof resultsTemp)[number]>();
		for (const result of resultsTemp) {
			const apiId = type === "bgm" ? result.bgm_id : result.vndb_id;
			if (apiId) {
				resultByApiId.set(apiId, result);
			}
		}

		// 4. 构建更新数据
		const updates: Array<
			[number, Partial<{ bgm_data: BgmData; vndb_data: VndbData }>]
		> = [];

		for (const [gameId, apiId] of idPairs) {
			const data = resultByApiId.get(apiId);

			if (data?.[updateKeyName]) {
				updates.push([gameId, { [updateKeyName]: data[updateKeyName] }]);
			}
		}

		// 5. 批量更新数据库
		if (updates.length > 0) {
			const updatedGames = await gameService.updateBatch(updates);
			patchManyGameCaches(queryClient, gameKeys, updatedGames);
			queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
		}

		return {
			total: idPairs.length,
			success: updates.length,
			failed: idPairs.length - updates.length,
		};
	} catch (error) {
		console.error(`批量更新 ${type.toUpperCase()} 数据失败:`, error);
		throw toError(error, i18next.t("errors.unknownError", "未知错误"));
	}
}

/**
 * 批量更新 VNDB 数据
 * @returns 返回更新结果统计
 */
export async function batchUpdateVndbData(): Promise<{
	total: number;
	success: number;
	failed: number;
}> {
	return batchUpdateCommon(
		"vndb",
		fetchVNDBByIds,
		() => gameService.getAllVndbIds(),
		"vndb_data",
	);
}

/**
 * 批量更新 BGM 数据
 * @returns 返回更新结果统计
 */
export async function batchUpdateBgmData(): Promise<{
	total: number;
	success: number;
	failed: number;
}> {
	return withBgmAuth(
		(token) =>
			batchUpdateCommon(
				"bgm",
				(ids: string[]) => fetchBgmByIds(ids, token),
				() => gameService.getAllBgmIds(),
				"bgm_data",
				token,
			),
		{ required: true },
	);
}

// ==================== 脏检查工具函数 ====================

/**
 * 计算 UI 状态与原始数据的差异 (String)
 *
 * 用于 React 受控组件向后端提交更新时的"三态"比对逻辑：
 * - undefined: 没变，不传（后端跳过此字段）
 * - null: 被清空，传 null（后端更新为 NULL）
 * - T: 被修改，传新值（后端更新为新值）
 *
 * @param current 当前 UI 中的状态 (例如 input 的 value)
 * @param original 原始数据 (可能是 undefined)
 * @returns string | null | undefined
 *
 * @example
 * // 字符串示例
 * getDiff("ABC", "ABC")    // → undefined (没变)
 * getDiff("", "ABC")       // → null (被清空)
 * getDiff("DEF", "ABC")    // → "DEF" (被修改)
 */
export function getDiff(
	current: string,
	original: string | undefined,
): string | null | undefined {
	// --- 字符串处理 ---

	// 归一化：将原始数据的 null/undefined 都视为 "" 与当前状态对比
	const normOriginal = original ?? "";
	const normCurrent = current.trim(); // 去除首尾空格

	// [逻辑1：没变] 归一化后相等 -> 不传 (undefined)
	if (normOriginal === normCurrent) return undefined;

	// [逻辑2：被清空] 当前为空，说明用户删光了 -> 传 null
	if (normCurrent === "") return null;

	// [逻辑3：被修改] 有值且不等 -> 传新值
	return normCurrent;
}

/**
 * 计算数组差异（用于 aliases, tags 等字符串数组）
 *
 * @param current 当前 UI 状态
 * @param original 原始数据
 * @returns undefined | null | T[]
 *
 * @example
 * getArrayDiff([], [])           // → undefined (没变)
 * getArrayDiff(["a"], ["a"])     // → undefined (没变)
 * getArrayDiff([], ["a", "b"])   // → null (被清空)
 * getArrayDiff(["c"], ["a"])     // → ["c"] (被修改)
 */
export function getArrayDiff<T>(
	current: T[],
	original: T[] | null | undefined,
): T[] | null | undefined {
	const normOriginal = original ?? [];

	if (
		current.length === normOriginal.length &&
		current.every((value, index) => Object.is(value, normOriginal[index]))
	) {
		return undefined; // 没变
	}

	// 被清空
	if (current.length === 0) {
		return null;
	}

	// 被修改
	return current;
}

/**
 * 计算布尔值差异
 *
 * @param current 当前 UI 状态
 * @param original 原始数据
 * @returns undefined | boolean
 *
 * @example
 * getBoolDiff(false, undefined)  // → undefined (没变，原本就是 false)
 * getBoolDiff(true, true)        // → undefined (没变)
 * getBoolDiff(true, false)       // → true (被修改)
 */
export function getBoolDiff(
	current: boolean,
	original: boolean | null | undefined,
): boolean | undefined {
	const normOriginal = original ?? false;

	if (current === normOriginal) {
		return undefined; // 没变
	}

	return current; // 被修改
}

/**
 * 从目录名中移除括号内容，提取搜索用的游戏名
 * 例如: "[社团名] 游戏名 (版本)" -> "游戏名"
 */
export function trimDirnameToSearchName(dirName: string): string {
	let result = "";
	let squareDepth = 0;
	let roundDepth = 0;
	let cornerDepth = 0;
	let fullwidthRoundDepth = 0;

	// 遍历每一个字符
	for (const ch of dirName) {
		switch (ch) {
			case "[":
				squareDepth++;
				break;
			case "]":
				squareDepth = Math.max(0, squareDepth - 1);
				break; // 类似 Rust 的 saturating_sub
			case "(":
				roundDepth++;
				break;
			case ")":
				roundDepth = Math.max(0, roundDepth - 1);
				break;
			case "【":
				cornerDepth++;
				break;
			case "】":
				cornerDepth = Math.max(0, cornerDepth - 1);
				break;
			case "（":
				fullwidthRoundDepth++;
				break;
			case "）":
				fullwidthRoundDepth = Math.max(0, fullwidthRoundDepth - 1);
				break;
			default:
				// 只有当所有括号深度都为 0 时，才保留该字符
				if (
					squareDepth === 0 &&
					roundDepth === 0 &&
					cornerDepth === 0 &&
					fullwidthRoundDepth === 0
				) {
					result += ch;
				}
		}
	}

	// 清理多余的连续空格，并去除首尾空格
	const trimmed = result.replace(/\s+/g, " ").trim();

	// 如果全被清空了（比如全都是括号），就返回原始名称的 trim 结果
	return trimmed || dirName.trim();
}
