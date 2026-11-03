/**
 * @file 改版功能状态管理 (Infrastructure)
 * @description 独立于原版 appStore，用于管理收藏夹排序、筛选、快速访问等改版功能。
 * @module src/store/modStore
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { durableWebStorage } from "@/utils/durableWebStorage";
import type { GameType, SortOption, SortOrder } from "@/services/invoke/types";
import type { DiskHealthSnapshot } from "@/types/diskHealth";
import {
	normalizePlayStatusFilter,
	type BackupStatusFilter,
	type PlayStatusFilter,
} from "@/types/collection";
import { normalizeTagFilters } from "@/utils/tagFilter";

const MIN_UI_ZOOM_PERCENT = 80;
const MAX_UI_ZOOM_PERCENT = 150;

/**
 * 扩展排序选项，增加改版的 BGM 评分
 */
export type ModSortOption = SortOption | "bgmscore" | "custom";

export type StartupPage = "last" | "home" | "libraries" | "collection";

/**
 * 收藏夹视图偏好
 */
export interface CollectionViewPref {
	gameFilterType: GameType;
	sortOption: ModSortOption;
	sortOrder: SortOrder;
	playStatusFilter: PlayStatusFilter;
	backupStatusFilter: BackupStatusFilter;
	tagFilters: string[];
	showCardSortFieldOverlay: boolean;
	customOrderInitialized: boolean;
}

/**
 * 快速访问固定项
 */
export interface PinnedFolderItem {
	type: "group" | "category";
	groupId: string;
	categoryId?: number;
}

export interface MonthlyDatabaseBackupState {
	enabled: boolean;
	day: number;
	includeCovers: boolean;
	maxAutoBackups: number;
	backupOnExit: boolean;
	exitMinIntervalHours: number;
	enabledAt: string | null;
	lastAttemptAt: string | null;
	lastAttemptPeriod: string | null;
	lastSuccessAt: string | null;
	lastSuccessPeriod: string | null;
	lastSuccessPath: string | null;
	lastError: string | null;
	lastAutoBackupAt: string | null;
	lastAutoBackupPath: string | null;
	lastWarning: string | null;
}

export interface DiskHealthState {
	enabled: boolean;
	refreshIntervalHours: number;
	executablePath: string;
	testedPath: string | null;
	authorizedPath: string | null;
	authorizationFingerprint: string | null;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	lastError: string | null;
	snapshot: DiskHealthSnapshot | null;
}

/** 本机游戏归档偏好。密码不持久化，始终在每次归档时临时输入。 */
export interface GameArchiveSettingsState {
	format: "7z" | "zip";
	compressionLevel: number;
	requirePassword: boolean;
	encryptHeaders: boolean;
	deleteBehavior: "permanent" | "recycle";
}

export interface DownloadTaskAutomationDefaults {
	autoImport: boolean;
	autoDelete: boolean;
}

export interface GameScanRoot {
	id: string;
	path: string;
}

/** 游戏分类来源目录仅保存为本机偏好，不写入游戏数据库。 */
export interface GameCategorySourceFolder {
	id: string;
	path: string;
	categoryId: number;
}

/**
 * ModState 改版状态类型定义
 */
export interface ModState {
	// 1. 收藏夹视图偏好 (categoryId -> Pref)
	collectionViewPrefs: Record<number, CollectionViewPref>;
	updateCollectionViewPref: (
		categoryId: number,
		pref: Partial<CollectionViewPref>,
	) => void;
	clearCollectionViewPref: (categoryId: number) => void;

	// 2. 快速访问固定项
	pinnedFolders: PinnedFolderItem[];
	togglePinnedFolder: (item: PinnedFolderItem) => void;
	clearPinnedFolder: (type: "group" | "category", id: string | number) => void;

	// 3. 文件夹拖拽开关
	folderDragEnabled: boolean;
	setFolderDragEnabled: (enabled: boolean) => void;

	// 4. 游戏启动增强
	autoDriveFallbackEnabled: boolean;
	autoDriveStart: string;
	autoDriveEnd: string;
	magpieHotkey: string;
	setAutoDriveFallbackEnabled: (enabled: boolean) => void;
	setAutoDriveStart: (drive: string) => void;
	setAutoDriveEnd: (drive: string) => void;
	setMagpieHotkey: (hotkey: string) => void;

	// 5. 每月数据库自动备份
	monthlyDatabaseBackup: MonthlyDatabaseBackupState;
	setMonthlyDatabaseBackupEnabled: (enabled: boolean) => void;
	updateMonthlyDatabaseBackupSchedule: (schedule: {
		day?: number;
	}) => void;
	updateMonthlyDatabaseBackupOptions: (options: {
		includeCovers?: boolean;
		maxAutoBackups?: number;
		backupOnExit?: boolean;
		exitMinIntervalHours?: number;
	}) => void;
	recordMonthlyDatabaseBackupAttempt: (period: string, at: string) => void;
	recordMonthlyDatabaseBackupSuccess: (
		period: string,
		at: string,
		path: string | null,
	) => void;
	recordMonthlyDatabaseBackupError: (at: string, error: string) => void;
	recordAutoDatabaseBackupSuccess: (
		at: string,
		path: string | null,
		warning: string | null,
	) => void;
	recordAutoDatabaseBackupError: (error: string) => void;

	// 6. 外部工具统一目录
	toolWorkspacePath: string;
	setToolWorkspacePath: (path: string) => void;

	// 7. 磁盘健康
	diskHealth: DiskHealthState;
	setDiskHealthEnabled: (enabled: boolean) => void;
	setDiskHealthRefreshIntervalHours: (hours: number) => void;
	setDiskHealthExecutablePath: (path: string) => void;
	recordDiskHealthAuthorization: (path: string, fingerprint: string) => void;
	clearDiskHealthAuthorization: () => void;
	recordDiskHealthAttempt: (at: string) => void;
	recordDiskHealthSuccess: (
		path: string,
		at: string,
		snapshot: DiskHealthSnapshot,
	) => void;
	recordDiskHealthError: (at: string, error: string) => void;

	// 8. 界面缩放
	uiZoomPercent: number;
	setUiZoomPercent: (percent: number) => void;

	// 9. 启动默认页面
	startupPage: StartupPage;
	setStartupPage: (page: StartupPage) => void;

	// 10. 游戏批量导入默认根目录（仅本机偏好，不写入游戏数据库）
	gameScanRoots: GameScanRoot[];
	addGameScanRoot: (path: string) => boolean;
	removeGameScanRoot: (id: string) => void;

	// 11. 游戏导入后的收藏夹分类来源目录（仅本机偏好）
	gameCategorySourceFolders: GameCategorySourceFolder[];
	addGameCategorySourceFolder: (path: string, categoryId: number) => boolean;
	removeGameCategorySourceFolder: (id: string) => void;

	// 12. 游戏目录归档设置（会随设置快照备份与恢复）
	gameArchiveSettings: GameArchiveSettingsState;
	updateGameArchiveSettings: (settings: Partial<GameArchiveSettingsState>) => void;
	downloadTaskAutomationDefaults: DownloadTaskAutomationDefaults;
	updateDownloadTaskAutomationDefaults: (settings: Partial<DownloadTaskAutomationDefaults>) => void;
}

/**
 * 默认视图偏好
 */
const DEFAULT_VIEW_PREF: CollectionViewPref = {
	gameFilterType: "all",
	sortOption: "addtime",
	sortOrder: "asc",
	playStatusFilter: [],
	backupStatusFilter: "all",
	tagFilters: [],
	showCardSortFieldOverlay: false,
	// 旧分类已可能保存过手动顺序，缺少标记时必须优先保留。
	customOrderInitialized: true,
};

const DEFAULT_MONTHLY_DATABASE_BACKUP: MonthlyDatabaseBackupState = {
	enabled: false,
	day: 1,
	includeCovers: false,
	maxAutoBackups: 7,
	backupOnExit: false,
	exitMinIntervalHours: 12,
	enabledAt: null,
	lastAttemptAt: null,
	lastAttemptPeriod: null,
	lastSuccessAt: null,
	lastSuccessPeriod: null,
	lastSuccessPath: null,
	lastError: null,
	lastAutoBackupAt: null,
	lastAutoBackupPath: null,
	lastWarning: null,
};

// External tools are optional. New installations must never assume a private path.
const DEFAULT_TOOL_WORKSPACE_PATH = "";

const DEFAULT_DISK_HEALTH: DiskHealthState = {
	enabled: false,
	refreshIntervalHours: 1,
	executablePath: "",
	testedPath: null,
	authorizedPath: null,
	authorizationFingerprint: null,
	lastAttemptAt: null,
	lastSuccessAt: null,
	lastError: null,
	snapshot: null,
};

const DEFAULT_GAME_ARCHIVE_SETTINGS: GameArchiveSettingsState = {
	format: "7z",
	compressionLevel: 5,
	requirePassword: false,
	encryptHeaders: true,
	deleteBehavior: "recycle",
};

const DEFAULT_DOWNLOAD_TASK_AUTOMATION: DownloadTaskAutomationDefaults = {
	autoImport: false,
	autoDelete: false,
};

function cleanStoredPath(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().replace(/^["']+|["']+$/g, "").trim();
}

function normalizeWindowsPath(value: string): string {
	return cleanStoredPath(value).replace(/[\\/]+$/, "").toLocaleLowerCase();
}

function validateGameScanRoots(value: unknown): GameScanRoot[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const candidate = entry as Partial<GameScanRoot>;
		const path = cleanStoredPath(candidate.path);
		const normalized = normalizeWindowsPath(path);
		if (!path || !normalized || seen.has(normalized)) return [];
		seen.add(normalized);
		return [{ id: typeof candidate.id === "string" && candidate.id ? candidate.id : `game-scan-root-${Date.now()}-${seen.size}`, path }];
	});
}

function validateGameCategorySourceFolders(value: unknown): GameCategorySourceFolder[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const candidate = entry as Partial<GameCategorySourceFolder>;
		const path = cleanStoredPath(candidate.path);
		const normalized = normalizeWindowsPath(path);
		const categoryId = Number(candidate.categoryId);
		if (!path || !normalized || !Number.isInteger(categoryId) || categoryId <= 0 || seen.has(normalized)) return [];
		seen.add(normalized);
		return [{
			id: typeof candidate.id === "string" && candidate.id ? candidate.id : `game-category-source-${Date.now()}-${seen.size}`,
			path,
			categoryId,
		}];
	});
}

function validateGameArchiveSettings(value: unknown): GameArchiveSettingsState {
	if (!value || typeof value !== "object") return DEFAULT_GAME_ARCHIVE_SETTINGS;
	const candidate = value as Partial<GameArchiveSettingsState>;
	const format = candidate.format === "zip" ? "zip" : "7z";
	const compressionLevel = Number.isInteger(candidate.compressionLevel)
		? Math.max(0, Math.min(9, Number(candidate.compressionLevel)))
		: DEFAULT_GAME_ARCHIVE_SETTINGS.compressionLevel;
	return {
		format,
		compressionLevel,
		requirePassword: candidate.requirePassword === true,
		encryptHeaders: format === "7z" && candidate.encryptHeaders !== false,
		deleteBehavior: candidate.deleteBehavior === "permanent" ? "permanent" : "recycle",
	};
}

function validateDownloadTaskAutomation(value: unknown): DownloadTaskAutomationDefaults {
	if (!value || typeof value !== "object") return DEFAULT_DOWNLOAD_TASK_AUTOMATION;
	const candidate = value as Partial<DownloadTaskAutomationDefaults>;
	const autoImport = candidate.autoImport === true;
	return { autoImport, autoDelete: autoImport && candidate.autoDelete === true };
}

function validateUiZoomPercent(value: unknown): number {
	const percent = Number(value);
	if (!Number.isFinite(percent)) return 100;
	return Math.min(
		MAX_UI_ZOOM_PERCENT,
		Math.max(MIN_UI_ZOOM_PERCENT, Math.round(percent)),
	);
}

function validateStartupPage(value: unknown): StartupPage {
	return ["last", "home", "libraries", "collection"].includes(
		value as StartupPage,
	)
		? (value as StartupPage)
		: "last";
}

function sameWindowsPath(left: string | null, right: string): boolean {
	if (!left) return false;
	return left.replaceAll("/", "\\").toLocaleLowerCase() ===
		right.replaceAll("/", "\\").toLocaleLowerCase();
}

function isValidDiskHealthSnapshot(value: unknown): value is DiskHealthSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Partial<DiskHealthSnapshot>;
	return (
		isValidDateString(snapshot.checkedAt) &&
		Array.isArray(snapshot.drives) &&
		snapshot.drives.every(
			(drive) =>
				drive &&
				typeof drive === "object" &&
				typeof drive.id === "string" &&
				typeof drive.model === "string" &&
				["normal", "attention", "critical", "unknown"].includes(
					drive.health,
				),
		)
	);
}

function validateDiskHealth(state: unknown): DiskHealthState {
	const candidate =
		state && typeof state === "object"
			? (state as Partial<DiskHealthState>)
			: {};
	const executablePath =
		cleanStoredPath(candidate.executablePath) ||
		DEFAULT_DISK_HEALTH.executablePath;
	const snapshot = isValidDiskHealthSnapshot(candidate.snapshot)
		? candidate.snapshot
		: null;
	const testedPath = cleanStoredPath(candidate.testedPath) || null;
	const authorizedPath = cleanStoredPath(candidate.authorizedPath) || null;
	const authorizationFingerprint =
		typeof candidate.authorizationFingerprint === "string" &&
		/^[0-9A-F]{64}$/i.test(candidate.authorizationFingerprint)
			? candidate.authorizationFingerprint.toUpperCase()
			: null;
	const ready =
		snapshot !== null && sameWindowsPath(testedPath, executablePath);

	return {
		enabled: candidate.enabled === true && ready,
		refreshIntervalHours: Number.isInteger(Number(candidate.refreshIntervalHours))
			? Math.min(24, Math.max(1, Number(candidate.refreshIntervalHours)))
			: DEFAULT_DISK_HEALTH.refreshIntervalHours,
		executablePath,
		testedPath: ready ? testedPath : null,
		authorizedPath:
			authorizationFingerprint &&
			sameWindowsPath(authorizedPath, executablePath)
				? authorizedPath
				: null,
		authorizationFingerprint:
			authorizationFingerprint &&
			sameWindowsPath(authorizedPath, executablePath)
				? authorizationFingerprint
				: null,
		lastAttemptAt: isValidDateString(candidate.lastAttemptAt)
			? candidate.lastAttemptAt
			: null,
		lastSuccessAt: isValidDateString(candidate.lastSuccessAt)
			? candidate.lastSuccessAt
			: null,
		lastError:
			typeof candidate.lastError === "string" ? candidate.lastError : null,
		snapshot,
	};
}

function isValidDateString(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateMonthlyDatabaseBackup(
	state: unknown,
): MonthlyDatabaseBackupState {
	const candidate =
		state && typeof state === "object"
			? (state as Partial<MonthlyDatabaseBackupState>)
			: {};
	const day = Number(candidate.day);
	const enabled = candidate.enabled === true;

	return {
		enabled,
		day: Number.isInteger(day)
			? Math.min(31, Math.max(1, day))
			: DEFAULT_MONTHLY_DATABASE_BACKUP.day,
		includeCovers: candidate.includeCovers === true,
		maxAutoBackups: Number.isInteger(Number(candidate.maxAutoBackups))
			? Math.min(30, Math.max(1, Number(candidate.maxAutoBackups)))
			: DEFAULT_MONTHLY_DATABASE_BACKUP.maxAutoBackups,
		backupOnExit: candidate.backupOnExit === true,
		exitMinIntervalHours: Number.isInteger(
			Number(candidate.exitMinIntervalHours),
		)
			? Math.min(168, Math.max(0, Number(candidate.exitMinIntervalHours)))
			: DEFAULT_MONTHLY_DATABASE_BACKUP.exitMinIntervalHours,
		enabledAt: isValidDateString(candidate.enabledAt)
			? candidate.enabledAt
			: enabled
				? new Date().toISOString()
				: null,
		lastAttemptAt: isValidDateString(candidate.lastAttemptAt)
			? candidate.lastAttemptAt
			: null,
		lastAttemptPeriod:
			typeof candidate.lastAttemptPeriod === "string" &&
			/^\d{4}-\d{2}$/.test(candidate.lastAttemptPeriod)
				? candidate.lastAttemptPeriod
				: null,
		lastSuccessAt: isValidDateString(candidate.lastSuccessAt)
			? candidate.lastSuccessAt
			: null,
		lastSuccessPeriod:
			typeof candidate.lastSuccessPeriod === "string" &&
			/^\d{4}-\d{2}$/.test(candidate.lastSuccessPeriod)
				? candidate.lastSuccessPeriod
				: null,
		lastSuccessPath:
			typeof candidate.lastSuccessPath === "string"
				? candidate.lastSuccessPath
				: null,
		lastError:
			typeof candidate.lastError === "string" ? candidate.lastError : null,
		lastAutoBackupAt: isValidDateString(candidate.lastAutoBackupAt)
			? candidate.lastAutoBackupAt
			: null,
		lastAutoBackupPath:
			typeof candidate.lastAutoBackupPath === "string"
				? candidate.lastAutoBackupPath
				: null,
		lastWarning:
			typeof candidate.lastWarning === "string" ? candidate.lastWarning : null,
	};
}

/**
 * 合法性检查：确保加载的持久化数据符合当前版本的枚举定义
 */
function validateCollectionViewPref(pref: any): CollectionViewPref {
	const validGameFilterTypes: GameType[] = ["all", "local", "online", "iscustom"];
	const validSortOptions: ModSortOption[] = [
		"addtime",
		"datetime",
		"lastplayed",
		"bgmrank",
		"bgmscore",
		"custom",
		"vndbrank",
		"namesort",
	];
	const validSortOrders: SortOrder[] = ["asc", "desc"];
	const validBackupStatuses: BackupStatusFilter[] = [
		"all",
		"has",
		"multiple",
		"none",
	];

	return {
		gameFilterType: validGameFilterTypes.includes(pref?.gameFilterType)
			? pref.gameFilterType
			: DEFAULT_VIEW_PREF.gameFilterType,
		sortOption: validSortOptions.includes(pref?.sortOption)
			? pref.sortOption
			: DEFAULT_VIEW_PREF.sortOption,
		sortOrder: validSortOrders.includes(pref?.sortOrder)
			? pref.sortOrder
			: DEFAULT_VIEW_PREF.sortOrder,
		playStatusFilter: normalizePlayStatusFilter(pref?.playStatusFilter),
		backupStatusFilter: validBackupStatuses.includes(pref?.backupStatusFilter)
			? pref.backupStatusFilter
			: DEFAULT_VIEW_PREF.backupStatusFilter,
		tagFilters: normalizeTagFilters(
			Array.isArray(pref?.tagFilters)
				? pref.tagFilters.filter(
						(tag: unknown): tag is string => typeof tag === "string",
					)
				: [],
		),
		showCardSortFieldOverlay: pref?.showCardSortFieldOverlay === true,
		customOrderInitialized:
			typeof pref?.customOrderInitialized === "boolean"
				? pref.customOrderInitialized
				: DEFAULT_VIEW_PREF.customOrderInitialized,
	};
}

function validateCollectionViewPrefs(
	prefs: unknown,
): Record<number, CollectionViewPref> {
	if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return {};

	return Object.fromEntries(
		Object.entries(prefs)
			.filter(([categoryId]) => Number.isInteger(Number(categoryId)))
			.map(([categoryId, pref]) => [
				categoryId,
				validateCollectionViewPref(pref),
			]),
	) as Record<number, CollectionViewPref>;
}

export const useModStore = create<ModState>()(
	persist(
		(set, get) => ({
			// 1. 收藏夹视图偏好
			collectionViewPrefs: {},
			updateCollectionViewPref: (categoryId, pref) => {
				const currentPrefs = get().collectionViewPrefs;
				const currentPref = currentPrefs[categoryId] || DEFAULT_VIEW_PREF;
				
				set({
					collectionViewPrefs: {
						...currentPrefs,
						[categoryId]: validateCollectionViewPref({
							...currentPref,
							...pref,
						}),
					},
				});
			},
			clearCollectionViewPref: (categoryId) => {
				const currentPrefs = get().collectionViewPrefs;
				if (!(categoryId in currentPrefs)) return;
				const nextPrefs = { ...currentPrefs };
				delete nextPrefs[categoryId];
				set({ collectionViewPrefs: nextPrefs });
			},

			// 2. 快速访问固定项
			pinnedFolders: [],
			togglePinnedFolder: (item) => {
				const { pinnedFolders } = get();
				const exists = pinnedFolders.find(
					(f) =>
						f.type === item.type &&
						f.groupId === item.groupId &&
						(item.type !== "category" || f.categoryId === item.categoryId),
				);

				if (exists) {
					set({
						pinnedFolders: pinnedFolders.filter((f) => f !== exists),
					});
				} else {
					set({
						pinnedFolders: [...pinnedFolders, item],
					});
				}
			},
			clearPinnedFolder: (type, id) => {
				const { pinnedFolders } = get();
				set({
					pinnedFolders: pinnedFolders.filter((f) => {
						if (type === "group") {
							// 级联清理：删除分组时，清理该分组下所有的固定项
							return f.groupId !== id;
						}
						// 精确清理：删除分类时，仅清理匹配的分类项
						return f.type !== "category" || f.categoryId !== id;
					}),
				});
			},

			// 3. 文件夹拖拽开关
			folderDragEnabled: false,
			setFolderDragEnabled: (enabled) => set({ folderDragEnabled: enabled }),

			// 4. 游戏启动增强
			autoDriveFallbackEnabled: false,
			autoDriveStart: "C",
			autoDriveEnd: "F",
			magpieHotkey: "Shift+O",
			setAutoDriveFallbackEnabled: (enabled) =>
				set({ autoDriveFallbackEnabled: enabled }),
			setAutoDriveStart: (drive) =>
				set({ autoDriveStart: drive.toUpperCase() }),
			setAutoDriveEnd: (drive) =>
				set({ autoDriveEnd: drive.toUpperCase() }),
			setMagpieHotkey: (hotkey) => set({ magpieHotkey: hotkey }),

			// 5. 每月数据库自动备份
			monthlyDatabaseBackup: DEFAULT_MONTHLY_DATABASE_BACKUP,
			setMonthlyDatabaseBackupEnabled: (enabled) =>
				set((state) => ({
					monthlyDatabaseBackup: {
						...state.monthlyDatabaseBackup,
						enabled,
						enabledAt:
							enabled && !state.monthlyDatabaseBackup.enabled
								? new Date().toISOString()
								: state.monthlyDatabaseBackup.enabledAt,
					},
				})),
			updateMonthlyDatabaseBackupSchedule: (schedule) =>
				set((state) => ({
					monthlyDatabaseBackup: validateMonthlyDatabaseBackup({
						...state.monthlyDatabaseBackup,
						...schedule,
					}),
				})),
			updateMonthlyDatabaseBackupOptions: (options) =>
				set((state) => ({
					monthlyDatabaseBackup: validateMonthlyDatabaseBackup({
						...state.monthlyDatabaseBackup,
						...options,
					}),
				})),
			recordMonthlyDatabaseBackupAttempt: (period, at) =>
				set((state) => ({
					monthlyDatabaseBackup: {
						...state.monthlyDatabaseBackup,
						lastAttemptAt: at,
						lastAttemptPeriod: period,
						lastError: null,
					},
				})),
			recordMonthlyDatabaseBackupSuccess: (period, at, path) =>
				set((state) => ({
					monthlyDatabaseBackup: {
						...state.monthlyDatabaseBackup,
						lastSuccessAt: at,
						lastSuccessPeriod: period,
						lastSuccessPath: path,
						lastError: null,
					},
				})),
			recordMonthlyDatabaseBackupError: (at, error) =>
				set((state) => ({
					monthlyDatabaseBackup: {
						...state.monthlyDatabaseBackup,
						lastAttemptAt: at,
						lastError: error,
					},
				})),
			recordAutoDatabaseBackupSuccess: (at, path, warning) =>
				set((state) => ({
					monthlyDatabaseBackup: {
						...state.monthlyDatabaseBackup,
						lastAutoBackupAt: at,
						lastAutoBackupPath: path,
						lastWarning: warning,
						lastError: null,
					},
				})),
			recordAutoDatabaseBackupError: (error) =>
				set((state) => ({
					monthlyDatabaseBackup: {
						...state.monthlyDatabaseBackup,
						lastWarning: null,
						lastError: error,
					},
				})),

			// 6. 外部工具统一目录
			toolWorkspacePath: DEFAULT_TOOL_WORKSPACE_PATH,
			setToolWorkspacePath: (path) =>
				set({ toolWorkspacePath: cleanStoredPath(path) }),

			// 7. 磁盘健康
			diskHealth: DEFAULT_DISK_HEALTH,
			setDiskHealthEnabled: (enabled) =>
				set((state) => ({
					diskHealth: {
						...state.diskHealth,
						enabled:
							enabled &&
							state.diskHealth.snapshot !== null &&
							sameWindowsPath(
								state.diskHealth.testedPath,
								state.diskHealth.executablePath,
							),
					},
				})),
			setDiskHealthRefreshIntervalHours: (hours) =>
				set((state) => ({
					diskHealth: {
						...state.diskHealth,
						refreshIntervalHours: Math.min(24, Math.max(1, Math.round(hours))),
					},
				})),
			setDiskHealthExecutablePath: (path) =>
				set((state) => {
					const executablePath = cleanStoredPath(path);
					if (
						sameWindowsPath(state.diskHealth.executablePath, executablePath)
					) {
						return {
							diskHealth: { ...state.diskHealth, executablePath },
						};
					}
					return {
						diskHealth: {
							...state.diskHealth,
							enabled: false,
							executablePath,
							testedPath: null,
							authorizedPath: null,
							authorizationFingerprint: null,
							lastError: null,
							snapshot: null,
						},
					};
				}),
			recordDiskHealthAuthorization: (path, fingerprint) =>
				set((state) => ({
					diskHealth: {
						...state.diskHealth,
						authorizedPath: path,
						authorizationFingerprint: fingerprint.toUpperCase(),
						lastError: null,
					},
				})),
			clearDiskHealthAuthorization: () =>
				set((state) => ({
					diskHealth: {
						...state.diskHealth,
						enabled: false,
						testedPath: null,
						authorizedPath: null,
						authorizationFingerprint: null,
						lastSuccessAt: null,
						lastError: null,
						snapshot: null,
					},
				})),
			recordDiskHealthAttempt: (at) =>
				set((state) => ({
					diskHealth: {
						...state.diskHealth,
						lastAttemptAt: at,
					},
				})),
			recordDiskHealthSuccess: (path, at, snapshot) =>
				set((state) => ({
					diskHealth: {
						...state.diskHealth,
						testedPath: path,
						lastAttemptAt: at,
						lastSuccessAt: at,
						lastError: null,
						snapshot,
					},
				})),
			recordDiskHealthError: (at, error) =>
				set((state) => ({
					diskHealth: {
						...state.diskHealth,
						lastAttemptAt: at,
						lastError: error,
					},
				})),

			// 8. 界面缩放
			uiZoomPercent: 100,
			setUiZoomPercent: (percent) =>
				set({ uiZoomPercent: validateUiZoomPercent(percent) }),

			// 9. 启动默认页面
			startupPage: "last",
			setStartupPage: (page) =>
				set({ startupPage: validateStartupPage(page) }),

			// 10. 游戏批量导入默认根目录
			gameScanRoots: [],
			addGameScanRoot: (value) => {
				const path = cleanStoredPath(value);
				const normalized = normalizeWindowsPath(path);
				if (!path || !normalized || get().gameScanRoots.some((root) => normalizeWindowsPath(root.path) === normalized)) return false;
				set((state) => ({
					gameScanRoots: [...state.gameScanRoots, { id: `game-scan-root-${Date.now()}`, path }],
				}));
				return true;
			},
			removeGameScanRoot: (id) => set((state) => ({
				gameScanRoots: state.gameScanRoots.filter((root) => root.id !== id),
			})),

			// 11. 游戏分类来源目录
			gameCategorySourceFolders: [],
			addGameCategorySourceFolder: (value, categoryId) => {
				const path = cleanStoredPath(value);
				const normalized = normalizeWindowsPath(path);
				if (!path || !normalized || !Number.isInteger(categoryId) || categoryId <= 0) return false;
				if (get().gameCategorySourceFolders.some((source) => normalizeWindowsPath(source.path) === normalized)) return false;
				set((state) => ({
					gameCategorySourceFolders: [
						...state.gameCategorySourceFolders,
						{ id: `game-category-source-${Date.now()}-${state.gameCategorySourceFolders.length}`, path, categoryId },
					],
				}));
				return true;
			},
			removeGameCategorySourceFolder: (id) => set((state) => ({
				gameCategorySourceFolders: state.gameCategorySourceFolders.filter((source) => source.id !== id),
			})),

			// 12. 游戏目录归档设置
			gameArchiveSettings: DEFAULT_GAME_ARCHIVE_SETTINGS,
			updateGameArchiveSettings: (settings) => set((state) => ({
				gameArchiveSettings: validateGameArchiveSettings({
					...state.gameArchiveSettings,
					...settings,
				}),
			})),
			downloadTaskAutomationDefaults: DEFAULT_DOWNLOAD_TASK_AUTOMATION,
			updateDownloadTaskAutomationDefaults: (settings) => set((state) => ({
				downloadTaskAutomationDefaults: validateDownloadTaskAutomation({
					...state.downloadTaskAutomationDefaults,
					...settings,
				}),
			})),
		}),
		{
			name: "reina-manager-mod-store",
			storage: createJSONStorage(() => durableWebStorage),
			merge: (persistedState, currentState) => {
				const persisted = (persistedState ?? {}) as Partial<ModState>;
				return {
					...currentState,
					...persisted,
					collectionViewPrefs: validateCollectionViewPrefs(
						persisted.collectionViewPrefs,
					),
					monthlyDatabaseBackup: validateMonthlyDatabaseBackup(
						persisted.monthlyDatabaseBackup,
					),
					toolWorkspacePath: cleanStoredPath(persisted.toolWorkspacePath),
					diskHealth: validateDiskHealth(persisted.diskHealth),
					uiZoomPercent: validateUiZoomPercent(persisted.uiZoomPercent),
				startupPage: validateStartupPage(persisted.startupPage),
				gameScanRoots: validateGameScanRoots(persisted.gameScanRoots),
				gameCategorySourceFolders: validateGameCategorySourceFolders(persisted.gameCategorySourceFolders),
				gameArchiveSettings: validateGameArchiveSettings(persisted.gameArchiveSettings),
				downloadTaskAutomationDefaults: validateDownloadTaskAutomation(persisted.downloadTaskAutomationDefaults),
				};
			},
			// 持久化所有改版配置
			partialize: (state) => ({
				collectionViewPrefs: state.collectionViewPrefs,
				pinnedFolders: state.pinnedFolders,
				folderDragEnabled: state.folderDragEnabled,
				autoDriveFallbackEnabled: state.autoDriveFallbackEnabled,
				autoDriveStart: state.autoDriveStart,
				autoDriveEnd: state.autoDriveEnd,
				magpieHotkey: state.magpieHotkey,
				monthlyDatabaseBackup: state.monthlyDatabaseBackup,
				toolWorkspacePath: state.toolWorkspacePath,
				diskHealth: state.diskHealth,
				uiZoomPercent: state.uiZoomPercent,
				startupPage: state.startupPage,
				gameScanRoots: state.gameScanRoots,
				gameCategorySourceFolders: state.gameCategorySourceFolders,
				gameArchiveSettings: state.gameArchiveSettings,
				downloadTaskAutomationDefaults: state.downloadTaskAutomationDefaults,
			}),
		},
	),
);

/**
 * Selectors
 */
export const useCollectionViewPref = (categoryId: number | null) =>
	useModStore((state) => 
		categoryId !== null 
			? (state.collectionViewPrefs[categoryId] || DEFAULT_VIEW_PREF) 
			: DEFAULT_VIEW_PREF
	);

export const usePinnedFolders = () => useModStore((state) => state.pinnedFolders);
export const useFolderDragEnabled = () => useModStore((state) => state.folderDragEnabled);
