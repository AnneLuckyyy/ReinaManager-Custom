/**
 * @file 分组分类相关类型定义
 */

/**
 * 合集分组（一级容器）。
 *
 * 只保留前端当前实际消费的字段。`collections` 表里的 `icon`、
 * `created_at`、`updated_at` 目前没有投入使用，避免在业务类型里扩散。
 */
export interface CollectionGroup {
	id: number;
	name: string;
	sort_order: number;
}

/**
 * 合集分类（二级容器，带游戏数量）。
 */
export interface CollectionCategory {
	id: number;
	name: string;
	sort_order: number;
	game_count: number;
}

export type Group = CollectionGroup;
export type Category = CollectionCategory;

/**
 * 默认分组类型枚举
 */
export enum DefaultGroup {
	DEVELOPER = "default_developer",
}

/**
 * 游戏状态枚举（基于 games.clear 字段）
 * games.clear 已从 0/1 改为 1-5 的枚举值
 */
export enum PlayStatus {
	WISH = 1, // 想玩
	PLAYED = 2, // 玩过
	PLAYING = 3, // 在玩
	ON_HOLD = 4, // 搁置
	DROPPED = 5, // 弃坑
}

/**
 * 空数组表示不限制状态；其余值为允许显示的状态集合。
 *
 * 持久化中曾使用过 "all" 或单个数字，读取时统一通过
 * `normalizePlayStatusFilter` 迁移，避免旧筛选偏好失效。
 */
export type PlayStatusFilter = PlayStatus[];

export type BackupStatusFilter = "all" | "has" | "multiple" | "none";

/**
 * 所有游戏状态列表（用于菜单渲染）
 */
export const ALL_PLAY_STATUSES: PlayStatus[] = [
	PlayStatus.WISH,
	PlayStatus.PLAYING,
	PlayStatus.PLAYED,
	PlayStatus.ON_HOLD,
	PlayStatus.DROPPED,
];

export function normalizePlayStatusFilter(value: unknown): PlayStatusFilter {
	const candidates = Array.isArray(value) ? value : [value];
	const unique = new Set<PlayStatus>();
	for (const candidate of candidates) {
		if (ALL_PLAY_STATUSES.includes(candidate as PlayStatus)) {
			unique.add(candidate as PlayStatus);
		}
	}
	return ALL_PLAY_STATUSES.filter((status) => unique.has(status));
}

/**
 * 游戏状态 i18n key 映射
 */
export const PLAY_STATUS_I18N_KEYS: Record<PlayStatus, string> = {
	[PlayStatus.WISH]: "category.playStatus.wish",
	[PlayStatus.PLAYING]: "category.playStatus.playing",
	[PlayStatus.PLAYED]: "category.playStatus.played",
	[PlayStatus.ON_HOLD]: "category.playStatus.onHold",
	[PlayStatus.DROPPED]: "category.playStatus.dropped",
};

/**
 * 游戏状态图标名称映射
 * - 想玩: 星星 (StarBorder)
 * - 在玩: 播放 (PlayCircle)
 * - 玩过: 打勾 (CheckCircle)
 * - 搁置: 暂停 (PauseCircle)
 * - 弃坑: 打叉 (Cancel)
 */
export type PlayStatusIconType =
	| "StarBorder"
	| "PlayCircle"
	| "CheckCircle"
	| "PauseCircle"
	| "Cancel";

export const PLAY_STATUS_ICONS: Record<PlayStatus, PlayStatusIconType> = {
	[PlayStatus.WISH]: "StarBorder",
	[PlayStatus.PLAYING]: "PlayCircle",
	[PlayStatus.PLAYED]: "CheckCircle",
	[PlayStatus.ON_HOLD]: "PauseCircle",
	[PlayStatus.DROPPED]: "Cancel",
};

/**
 * 获取游戏状态多语言文案
 */
export function getPlayStatusLabel(
	t: (key: string) => string,
	status: PlayStatus,
): string {
	return t(PLAY_STATUS_I18N_KEYS[status]);
}

/**
 * 判断是否为"玩过"状态（显示金奖杯）
 */
export function isPlayedStatus(status: number | undefined | null): boolean {
	return status === PlayStatus.PLAYED;
}
