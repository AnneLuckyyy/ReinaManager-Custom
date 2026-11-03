/**
 * @file Home 页面
 * @description 应用首页，展示游戏统计信息、动态、最近游玩、最近添加等内容，支持国际化。
 * @module src/pages/Home/index
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - Home：主页主组件
 *
 * 依赖：
 * - @mui/material
 * - @mui/icons-material
 * - @/store
 * - @/store/gamePlayStore
 * - @/utils/gameStats
 * - @/utils
 * - @/types
 * - react-i18next
 * - react-router
 */

import {
	EmojiEvents as CompletedIcon,
	SportsEsports as GamesIcon,
	Storage as LocalIcon,
	AccessTime as TimeIcon,
	Today as TodayIcon,
	DateRange as WeekIcon,
} from "@mui/icons-material";
import {
	Box,
	Card,
	CardContent,
	Skeleton,
	ToggleButton,
	ToggleButtonGroup,
	Typography,
} from "@mui/material";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import { useGameStats, usePlayTimeSummary } from "@/hooks/queries/useStats";
import { snackbar } from "@/providers/snackBar";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData } from "@/types";
import { PlayStatus } from "@/types/collection";
import {
	formatPlayTime,
	getGameCover,
	getGameDisplayName,
} from "@/utils/appUtils";
import { getRecentSessionsForAllGames } from "@/utils/gameStats";
import { FocusGamePanel } from "./FocusGamePanel";

/**
 * 最近游玩会话类型
 */
interface RecentSession {
	session_id: number;
	game_id: number;
	end_time: number;
	gameTitle: string;
	imageUrl: string;
}
/**
 * 最近添加游戏类型
 */
interface RecentGame {
	id: number;
	title: string;
	imageUrl: string;
	time: Date;
}
/**
 * 动态项类型
 */
interface ActivityItem {
	id: string;
	type: "add" | "play";
	gameId: number;
	gameTitle: string;
	imageUrl: string;
	time: number;
	duration?: number; // 仅游玩记录有
}

/**
 * 获取最近游玩、最近添加、动态数据 - 优化版本
 * @param games 游戏列表
 * @param language 当前语言
 * @returns 包含 sessions、added、activities 的对象
 */
async function getGameActivities(games: GameData[]): Promise<{
	sessions: RecentSession[];
	added: RecentGame[];
	activities: ActivityItem[];
}> {
	// 处理游玩记录 - 使用批量查询优化
	const playItems: ActivityItem[] = [];
	const sessions: RecentSession[] = [];

	// 提取所有有效的游戏ID
	const validGameIds = games.map((game) => game.id);

	// 一次性获取所有游戏的会话记录，避免循环中的多次数据库查询
	const allSessionsMap = await getRecentSessionsForAllGames(validGameIds, 10);

	// 处理会话数据
	for (const game of games) {
		const gameSessions = allSessionsMap.get(game.id) || [];
		const gameTitle = getGameDisplayName(game);
		const imageUrl = getGameCover(game);

		for (const s of gameSessions.filter(
			(s) => typeof s.end_time === "number",
		)) {
			const item: ActivityItem = {
				id: `play-${s.session_id || game.id}-${s.end_time}`,
				type: "play",
				gameId: game.id,
				gameTitle,
				imageUrl,
				time: s.end_time as number,
				duration: s.duration,
			};
			playItems.push(item);

			// 用于最近游玩区域
			sessions.push({
				session_id: s.session_id as number,
				game_id: game.id,
				end_time: s.end_time as number,
				gameTitle,
				imageUrl,
			});
		}
	}

	// 处理添加记录
	const addItems: ActivityItem[] = [];
	const added: RecentGame[] = [];

	// 过滤有效的游戏数据(有 ID 和创建时间)
	for (const game of games.filter((game) => game.created_at)) {
		// created_at 是秒级时间戳
		const timestamp = game.created_at as number;
		const addedDate = new Date(timestamp * 1000);
		const gameTitle = getGameDisplayName(game);

		const item: ActivityItem = {
			id: `add-${game.id}`,
			type: "add",
			gameId: game.id,
			gameTitle,
			imageUrl: getGameCover(game),
			time: timestamp,
		};
		addItems.push(item);

		added.push({
			id: game.id,
			title: gameTitle,
			imageUrl: getGameCover(game),
			time: addedDate,
		});
	}

	// 合并所有动态，按时间排序
	const allActivities = [...playItems, ...addItems].toSorted(
		(a, b) => b.time - a.time,
	);

	// 排序最近游玩和最近添加
	const sortedSessions = sessions.toSorted((a, b) => b.end_time - a.end_time);
	const sortedAdded = added.toSorted(
		(a, b) => b.time.getTime() - a.time.getTime(),
	);

	return {
		sessions: sortedSessions.slice(0, 10),
		added: sortedAdded.slice(0, 10),
		activities: allActivities.slice(0, 15),
	};
}

export const Home: React.FC = () => {
	const { index } = useGameIndex();
	const displayAllGames = index.displayList;
	const runningGameIds = useGamePlayStore((state) => state.runningGameIds);
	const launchGame = useGamePlayStore((state) => state.launchGame);
	const stopGame = useGamePlayStore((state) => state.stopGame);
	const { totalPlayTime, weekPlayTime, monthPlayTime, todayPlayTime, isLoading } =
		usePlayTimeSummary();
	const [playTimePeriod, setPlayTimePeriod] = useState<"week" | "month">(
		"week",
	);
	const [selectedFocusGameId, setSelectedFocusGameId] = useState<number | null>(
		null,
	);
	const [isStoppingFocusGame, setIsStoppingFocusGame] = useState(false);

	// 分离活动数据的状态管理
	const [activityData, setActivityData] = useState<{
		sessions: RecentSession[];
		added: RecentGame[];
		activities: ActivityItem[];
		loading: boolean;
	}>({
		sessions: [],
		added: [],
		activities: [],
		loading: true,
	});

	const { t } = useTranslation();
	const recentGameEntries = useMemo(() => {
		const gameById = new Map(displayAllGames.map((game) => [game.id, game]));
		const seen = new Set<number>();
		return activityData.sessions.flatMap((session) => {
			if (seen.has(session.game_id)) return [];
			const game = gameById.get(session.game_id);
			if (!game) return [];
			seen.add(game.id);
			return [{ game, lastPlayed: session.end_time }];
		});
	}, [activityData.sessions, displayAllGames]);
	const automaticFocusGame = useMemo(() => {
		const runningGame = recentGameEntries.find(({ game }) =>
			runningGameIds.has(game.id),
		)?.game ?? displayAllGames.find((game) => runningGameIds.has(game.id));
		if (runningGame) return runningGame;
		if (recentGameEntries[0]) return recentGameEntries[0].game;
		return (
			displayAllGames.find((game) => game.clear === PlayStatus.PLAYING) ??
			displayAllGames.find(
				(game) => Boolean(game.localpath) || game.launch_type === "steam",
			) ??
			displayAllGames[0]
		);
	}, [displayAllGames, recentGameEntries, runningGameIds]);
	const focusGame = useMemo(
		() =>
			displayAllGames.find((game) => game.id === selectedFocusGameId) ??
			automaticFocusGame,
		[automaticFocusGame, displayAllGames, selectedFocusGameId],
	);
	const focusStatsQuery = useGameStats(focusGame?.id ?? null);
	const focusLastPlayed = recentGameEntries.find(
		({ game }) => game.id === focusGame?.id,
	)?.lastPlayed;

	const handleLaunchFocusGame = async (game: GameData) => {
		try {
			const result = await launchGame(game.id);
			if (!result.success) snackbar.error(result.message);
		} catch (error) {
			console.error("主页焦点游戏启动失败:", error);
			snackbar.error(t("components.LaunchModal.launchFailed", "游戏启动失败"));
		}
	};

	const handleStopFocusGame = async () => {
		if (!focusGame) return;
		setIsStoppingFocusGame(true);
		try {
			const result = await stopGame(focusGame.id);
			if (!result.success) snackbar.error(result.message);
		} catch (error) {
			console.error("主页焦点游戏停止失败:", error);
			snackbar.error(t("components.LaunchModal.stopFailed", "停止游戏失败"));
		} finally {
			setIsStoppingFocusGame(false);
		}
	};

	const gamesLocalCount = useMemo(
		() => displayAllGames.filter((game) => Boolean(game.localpath)).length,
		[displayAllGames],
	);
	const completedGamesCount = useMemo(
		() =>
			displayAllGames.filter((game) => game.clear === PlayStatus.PLAYED).length,
		[displayAllGames],
	);

	// 统计卡片数据 - 区分同步和异步数据
	const statsCards = useMemo(
		() => [
			// 同步数据 - 立即显示
			{
				title: t("home.stats.totalGames", "总游戏数"),
				value: displayAllGames.length,
				icon: <GamesIcon />,
				isAsync: false,
			},
			{
				title: t("home.stats.localGames", "本地游戏数"),
				value: gamesLocalCount,
				icon: <LocalIcon />,
				isAsync: false,
			},
			{
				title: t("home.stats.completedGames", "通关游戏数"),
				value: completedGamesCount,
				icon: <CompletedIcon />,
				isAsync: false,
			},
			// 异步数据 - 可能需要 loading
			{
				title: t("home.stats.totalPlayTime", "总游戏时长"),
				value: formatPlayTime(totalPlayTime),
				icon: <TimeIcon />,
				isAsync: true,
			},
			{
				title:
					playTimePeriod === "week"
						? t("home.stats.weekPlayTime", "本周游戏时长")
						: t("home.stats.monthPlayTime", "本月游戏时长"),
				value: formatPlayTime(
					playTimePeriod === "week" ? weekPlayTime : monthPlayTime,
				),
				icon: <WeekIcon />,
				isAsync: true,
				periodSelectable: true,
			},
			{
				title: t("home.stats.todayPlayTime", "今日游戏时长"),
				value: formatPlayTime(todayPlayTime),
				icon: <TodayIcon />,
				isAsync: true,
			},
		],
		[
			t,
			displayAllGames.length,
			gamesLocalCount,
			completedGamesCount,
			totalPlayTime,
			weekPlayTime,
			monthPlayTime,
			todayPlayTime,
			playTimePeriod,
		],
	);

	// 异步获取活动数据
	useEffect(() => {
		const fetchActivityData = async () => {
			try {
				const result = await getGameActivities(displayAllGames);
				setActivityData({
					sessions: result.sessions,
					added: result.added,
					activities: result.activities,
					loading: false,
				});
			} catch (error) {
				console.error("获取首页活动数据失败:", error);
				setActivityData((prev) => ({ ...prev, loading: false }));
			}
		};

		fetchActivityData();
	}, [displayAllGames]);

	return (
		<Box className="min-h-[calc(100dvh-64px)] p-6 pt-4 flex flex-col gap-4">
			<Typography variant="h4">{t("home.title", "主页")}</Typography>

			{/* 数据统计卡片 */}
			<Box className="grid grid-cols-12 gap-6">
				{statsCards.map((card) => (
					<Box
						key={card.title}
						className="col-span-12 sm:col-span-6 md:col-span-4 lg:col-span-2"
					>
						<Card className="h-full shadow-md hover:shadow-lg transition-shadow">
							<CardContent className="flex flex-col items-center text-center">
								{card.icon}
								<Typography
									title={String(card.value)}
									variant="h6"
									className="font-bold mb-1 w-full whitespace-nowrap overflow-hidden text-ellipsis"
								>
									{/* 异步数据显示 loading，同步数据直接显示 */}
									{card.isAsync && isLoading ? (
										<Skeleton width={60} />
									) : (
										card.value
									)}
								</Typography>
								<Typography variant="body2" color="text.secondary">
									{card.title}
								</Typography>
								{card.periodSelectable && (
									<ToggleButtonGroup
										exclusive
										size="small"
										value={playTimePeriod}
										onChange={(_, value: "week" | "month" | null) => {
											if (value) setPlayTimePeriod(value);
										}}
										className="mt-1"
										aria-label={t("home.stats.period", "统计周期")}
									>
										<ToggleButton
											value="week"
											className="!min-w-0 !px-2 !py-0 !text-xs"
										>
											{t("home.stats.week", "周")}
										</ToggleButton>
										<ToggleButton
											value="month"
											className="!min-w-0 !px-2 !py-0 !text-xs"
										>
											{t("home.stats.month", "月")}
										</ToggleButton>
									</ToggleButtonGroup>
								)}
							</CardContent>
						</Card>
					</Box>
				))}
			</Box>

			{focusGame ? (
				<FocusGamePanel
					game={focusGame}
					isRunning={runningGameIds.has(focusGame.id)}
					lastPlayed={focusLastPlayed}
					stats={focusStatsQuery.data}
					recentGames={recentGameEntries.slice(0, 4)}
					isStopping={isStoppingFocusGame}
					onLaunch={(game) => void handleLaunchFocusGame(game)}
					onStop={() => void handleStopFocusGame()}
					onSelectRecent={setSelectedFocusGameId}
				/>
			) : null}

		</Box>
	);
};
