/**
 * @file gamePlayStore
 * @description 管理游戏运行状态、游玩统计、会话记录、实时状态等，支持游戏启动与时间跟踪。
 * @module src/store/gamePlayStore
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - useGamePlayStore：Zustand 状态管理，包含游戏运行、统计、会话等方法
 * - initializeGamePlayTracking：初始化游戏时间跟踪
 *
 * 依赖：
 * - zustand
 * - @tauri-apps/api/core
 * - @/utils/gameStats
 * - @/store
 * - @/types
 * - @/utils
 */

import { create } from "zustand";
import { gameKeys } from "@/hooks/queries/useGames";
import { queryClient } from "@/providers/queryClient";
import { useStore } from "@/store/appStore";
import { useModStore } from "@/store/modStore";
import type { FullGameData, StopGameResult } from "@/types";
import { PlayStatus } from "@/types/collection";
import {
	getAllGamePaths,
	getDriveSubstitutionPaths,
	launchGameWithTracking,
	stopGameWithTracking,
} from "@/utils/appUtils";
import { toError } from "@/utils/errors";
import { initGameTimeTracking } from "@/utils/gameStats";
import { gameService } from "@/services/invoke";
import { snackbar } from "@/providers/snackBar";

/**
 * 游戏启动结果类型
 */
interface LaunchGameResult {
	success: boolean;
	message: string;
	process_id?: number;
	warning?: string;
}

/**
 * 游戏实时状态接口
 */
interface GameRealTimeState {
	isRunning: boolean;
	currentSessionMinutes: number;
	currentSessionSeconds: number;
	lastForegroundAt: number | null;
	startTime: number;
	processId?: number;
}

/**
 * 游戏游玩状态全局管理
 */
interface GamePlayState {
	runningGameIds: Set<number>; // 正在运行的游戏ID集合
	isTrackingInitialized: boolean; // 是否已初始化时间跟踪
	gameRealTimeStates: Record<string, GameRealTimeState>; // 实时状态

	// 方法
	isGameRunning: (gameId?: number) => boolean;
	isAllGamePlaytimePaused: () => boolean;
	launchGame: (gameId: number, args?: string[]) => Promise<LaunchGameResult>;
	stopGame: (gameId: number) => Promise<StopGameResult>;
	initTimeTracking: () => void;
	clearActiveGame: () => void;
	getGameRealTimeState: (gameId: number) => GameRealTimeState | null;
}

/**
 * useGamePlayStore
 * 管理游戏运行、统计、会话、实时状态等
 */
export const useGamePlayStore = create<GamePlayState>((set, get) => ({
	runningGameIds: new Set<number>(),
	isTrackingInitialized: false,
	gameRealTimeStates: {},

	/**
	 * 判断指定游戏是否正在运行
	 * @param gameId 游戏ID（可选，未传则判断是否有任意游戏在运行）
	 */
	isGameRunning: (gameId?: number) => {
		const runningGames = get().runningGameIds;
		if (!gameId) return runningGames.size > 0;
		return runningGames.has(gameId);
	},

	// 只有所有运行中游戏都超过 5 秒没有前台计时更新时，才视为已暂停计时。
	isAllGamePlaytimePaused: () => {
		const runningGameIds = get().runningGameIds;
		if (runningGameIds.size === 0) return false;
		const states = get().gameRealTimeStates;
		const now = Date.now();
		return [...runningGameIds].every((gameId) => {
			const lastForegroundAt = states[gameId]?.lastForegroundAt;
			return lastForegroundAt == null || now - lastForegroundAt > 5000;
		});
	},

	/**
	 * 获取指定游戏的实时状态
	 * @param gameId 游戏ID
	 */
	getGameRealTimeState: (gameId: number) => {
		const state = get().gameRealTimeStates[gameId];
		return state || null;
	},

	/**
	 * 启动游戏并跟踪运行状态
	 * @param gameId 游戏ID
	 * @param args 启动参数
	 */
	launchGame: async (
		gameId: number,
		args?: string[],
	): Promise<LaunchGameResult> => {
		try {
			if (get().isGameRunning(gameId)) {
				return { success: false, message: "该游戏已在运行中" };
			}

			const game = await gameService.getGameById(gameId);
			if (!game) {
				return { success: false, message: `游戏不存在: ${gameId}` };
			}
			const isSteamLaunch = game.launch_type === "steam";

			const configuredPaths = isSteamLaunch ? [] : getAllGamePaths(game);
			if (!isSteamLaunch && configuredPaths.length === 0) {
				return { success: false, message: "游戏路径未设置" };
			}

			const modSettings = useModStore.getState();
			const generatedPaths = !isSteamLaunch && modSettings.autoDriveFallbackEnabled
				? getDriveSubstitutionPaths(
						game,
						modSettings.autoDriveStart,
						modSettings.autoDriveEnd,
					)
				: [];
			const paths: Array<string | undefined> = isSteamLaunch
				? [undefined]
				: [...configuredPaths, ...generatedPaths];

			// 添加到运行中游戏列表
			set((state) => {
				const newRunningGames = new Set(state.runningGameIds);
				newRunningGames.add(gameId);

				// 初始化游戏实时状态
				const newRealTimeStates = {
					...state.gameRealTimeStates,
					[gameId]: {
						isRunning: true,
					currentSessionMinutes: 0,
					currentSessionSeconds: 0,
					lastForegroundAt: null,
					startTime: Math.floor(Date.now() / 1000),
					},
				};

				return {
					runningGameIds: newRunningGames,
					gameRealTimeStates: newRealTimeStates,
				};
			});

			// 确保初始化了事件监听
			if (!get().isTrackingInitialized) {
				get().initTimeTracking();
			}

			let result: LaunchGameResult | null = null;
			let successfulPath: string | null = null;
			const failureMessages: string[] = [];

			for (const candidatePath of paths) {
				try {
					const attempt = await launchGameWithTracking(
						gameId,
						args,
						candidatePath,
						modSettings.magpieHotkey,
					);
					if (attempt.success) {
						result = attempt;
						successfulPath = candidatePath || null;
						break;
					}
					failureMessages.push(attempt.message);
				} catch (error) {
					failureMessages.push(
						toError(error, `路径无法启动: ${candidatePath}`).message,
					);
				}
			}

			if (!result || (!isSteamLaunch && !successfulPath)) {
				// 启动失败，恢复状态
				set((state) => {
					const newRunningGames = new Set(state.runningGameIds);
					newRunningGames.delete(gameId);

					const newRealTimeStates = { ...state.gameRealTimeStates };
					delete newRealTimeStates[gameId];

					return {
						runningGameIds: newRunningGames,
						gameRealTimeStates: newRealTimeStates,
					};
				});

				const lastFailure = failureMessages.at(-1) || "未知错误";
				return {
					success: false,
					message:
						paths.length === 1
							? lastFailure
							: `已尝试 ${paths.length} 个路径，均无法启动游戏。最后错误：${lastFailure}`,
				};
			}

			// 启动成功，更新进程 ID
			set((state) => {
				const newRealTimeStates = {
					...state.gameRealTimeStates,
					[gameId]: {
						...state.gameRealTimeStates[gameId],
						processId: result.process_id,
					},
				};
				return { gameRealTimeStates: newRealTimeStates };
			});

			if (isSteamLaunch) {
				if (result.warning) snackbar.warning(result.warning);
				return result;
			}
			if (!successfulPath) {
				return { success: false, message: "未获得可用的本地启动路径" };
			}

			const successfulPrimaryPath = successfulPath === game.localpath;
			const currentPathHistory = getAllGamePaths({
				localpath: game.localpath,
				custom_data: {
					extraLocalPaths: game.custom_data?.extraLocalPaths,
				},
			});
			const nextPathHistory = getAllGamePaths({
				custom_data: {
					extraLocalPaths: [...currentPathHistory, successfulPath],
				},
			});
			const shouldAppendPrimaryPath =
				successfulPrimaryPath && nextPathHistory.length > currentPathHistory.length;
			const successfulGeneratedPath = generatedPaths.includes(successfulPath);

			// 自动回退和换盘都要保留旧主路径，再记录新的成功路径。
			// 这样 A → B 的切换不会丢失 A，也符合全局路径历史契约。
			if (!successfulPrimaryPath || shouldAppendPrimaryPath) {
				try {
					await gameService.updateGame(
						gameId,
						!successfulPrimaryPath || successfulGeneratedPath
							? {
								localpath: successfulPath,
								custom_data: {
									...game.custom_data,
									extraLocalPaths: nextPathHistory,
								},
							}
							: {
								custom_data: {
									...game.custom_data,
									extraLocalPaths: nextPathHistory,
								},
							},
					);
					await queryClient.invalidateQueries({
						queryKey: gameKeys.all,
						exact: true,
					});
					await queryClient.invalidateQueries({
						queryKey: gameKeys.idLists(),
					});
				} catch (error) {
					console.error("游戏已启动，但保存成功路径失败:", error);
				}
			}

			if (result.warning) snackbar.warning(result.warning);

			return result;
		} catch (error) {
			// 启动异常，恢复状态
			set((state) => {
				const newRunningGames = new Set(state.runningGameIds);
				newRunningGames.delete(gameId);

				const newRealTimeStates = { ...state.gameRealTimeStates };
				delete newRealTimeStates[gameId];

				return {
					runningGameIds: newRunningGames,
					gameRealTimeStates: newRealTimeStates,
				};
			});

			const errorMessage = toError(error, "Failed to launch game").message;
			return { success: false, message: errorMessage };
		}
	},

	/**
	 * 停止游戏
	 * @param gameId 游戏ID
	 */
	stopGame: async (gameId: number): Promise<StopGameResult> => {
		try {
			if (!get().isGameRunning(gameId)) {
				return {
					success: false,
					message: "该游戏未在运行中",
					terminated_count: 0,
				};
			}

			// 调用工具函数停止游戏
			const result = await stopGameWithTracking(gameId);

			return result;
		} catch (error) {
			const errorMessage = toError(error, "Failed to stop game").message;
			return {
				success: false,
				message: errorMessage,
				terminated_count: 0,
			};
		}
	},

	/**
	 * 初始化游戏时间跟踪
	 * 设置事件监听，自动管理运行状态与实时时长
	 */
	initTimeTracking: () => {
		if (get().isTrackingInitialized) return;

		try {
			// 设置事件监听
			const cleanup = initGameTimeTracking(
				// 时间更新回调
				(gameId: number, _minutes: number, totalSeconds: number) => {
					// 更新实时游戏状态
					set((state) => {
						if (!state.gameRealTimeStates[gameId]) return state;

						const newMinutes = Math.floor(totalSeconds / 60);
						const newSeconds = totalSeconds % 60;

						return {
							gameRealTimeStates: {
								...state.gameRealTimeStates,
								[gameId]: {
									...state.gameRealTimeStates[gameId],
							currentSessionMinutes: newMinutes,
							currentSessionSeconds: newSeconds,
							lastForegroundAt: Date.now(),
								},
							},
						};
					});
				},
				// 会话结束回调
				async (gameId: number, minutes: number) => {
					// 只清除运行状态
					set((state) => {
						const newRunningGames = new Set(state.runningGameIds);
						newRunningGames.delete(gameId);
						// 移除对应游戏条目
						const newRealTimeStates = { ...state.gameRealTimeStates };
						delete newRealTimeStates[gameId];
						return {
							runningGameIds: newRunningGames,
							gameRealTimeStates: newRealTimeStates,
						};
					});
					await queryClient.invalidateQueries({ queryKey: ["stats"] });

					// ====== 自动切换游戏状态（改版功能 #9） ======
					// 单次游玩达到 30 分钟后，自动从"想玩"切换为"在玩"
					if (minutes >= 30) {
						const gamesCache = queryClient.getQueryData<FullGameData[]>(gameKeys.all);
						const currentGame = gamesCache?.find((g) => g.id === gameId);
						if (currentGame) {
							const currentClear = currentGame.clear;
							if (currentClear === undefined || currentClear === PlayStatus.WISH) {
								try {
									await gameService.updateGame(gameId, { clear: PlayStatus.PLAYING });
									await queryClient.invalidateQueries({ queryKey: gameKeys.all, exact: true });
									await queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
								} catch (err) {
									console.warn(`[AutoStatus] 自动切换游戏 ${gameId} 状态失败:`, err);
								}
							}
						}
					}
					// ====== END ======

					// ====== 游戏结束后刷新Cards组件 ======
					// 获取主store的状态，检查当前排序选项
					const store = useStore.getState();
					if (minutes && store.sortOption === "lastplayed") {
						// 如果当前排序是"最近游玩"，刷新游戏列表查询以更新顺序
						await queryClient.invalidateQueries({
							queryKey: gameKeys.idLists(),
						});
					}
					// ====== END ======
				},
			);

			// 设置初始化标志
			set({ isTrackingInitialized: true });

			// 添加全局事件清理函数
			window.addEventListener("beforeunload", cleanup);

			return cleanup;
		} catch (error) {
			console.error(
				"初始化游戏时间跟踪失败:",
				toError(error, "Failed to initialize game time tracking").message,
			);
		}
	},

	/**
	 * 清除所有运行中游戏状态
	 */
	clearActiveGame: () => {
		set({
			runningGameIds: new Set<number>(),
			gameRealTimeStates: {},
		});
	},
}));

/**
 * initializeGamePlayTracking
 * 在应用启动时初始化时间跟踪
 */
export const initializeGamePlayTracking = (): void => {
	useGamePlayStore.getState().initTimeTracking();
};
