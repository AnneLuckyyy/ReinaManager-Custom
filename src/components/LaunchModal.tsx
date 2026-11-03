/**
 * @file LaunchModal 组件
 * @description 游戏启动弹窗组件，负责判断游戏是否可启动、是否正在运行，并提供启动按钮，支持国际化。
 * @module src/components/LaunchModal/index
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - LaunchModal：游戏启动弹窗组件
 */

import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import SyncIcon from "@mui/icons-material/Sync";
import TimerIcon from "@mui/icons-material/Timer";
import {
	Box,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	IconButton,
	TextField,
	Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SelectedGameGuard } from "@/components/SelectedGameGuard";
import { ToolbarIconAction } from "@/components/Toolbar/ToolbarIconAction";
import { useUpdateGame } from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";
import { useStore } from "@/store/appStore";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData, UpdateGameParams } from "@/types";
import { cleanPathQuotes, handleExeFile } from "@/utils/appUtils";
import { getUserErrorMessage } from "@/utils/errors";

/**
 * 格式化游戏时长显示
 * @param minutes 分钟数
 * @param seconds 秒数
 * @returns 格式化的时长字符串，如 "1:23:45" 或 "23:45" 或 "0:05"
 */
const formatPlayTime = (minutes: number, seconds: number): string => {
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	const secs = seconds;

	if (hours > 0) {
		return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
	}
	return `${mins}:${secs.toString().padStart(2, "0")}`;
};

/**
 * LaunchModal 组件
 * 判断游戏是否可启动、是否正在运行，并渲染启动按钮。
 * 仅本地游戏且未运行时可启动。
 * 运行时显示实时游戏时长。
 * 支持两种计时模式：
 * - playtime: 真实游戏时间（仅活跃时间，通过后端事件更新）
 * - elapsed: 游戏启动时间（从启动到现在的总时间，前端计时器计算）
 *
 * @returns {JSX.Element} 启动按钮或运行中提示
 */
export const LaunchModal = ({ compact = false }: { compact?: boolean }) => {
	const { t } = useTranslation();
	const disabledFallback = (
		compact ? (
			<ToolbarIconAction label={t("components.LaunchModal.launchGame", "启动游戏")} disabled onClick={() => undefined}>
				<PlayArrowIcon />
			</ToolbarIconAction>
		) : (
			<Button startIcon={<PlayArrowIcon />} disabled>
				{t("components.LaunchModal.launchGame", "启动游戏")}
			</Button>
		)
	);

	return (
		<SelectedGameGuard
			fallback={disabledFallback}
			loadingFallback={disabledFallback}
			notFoundFallback={disabledFallback}
		>
			{(selectedGame) => <LaunchModalContent selectedGame={selectedGame} compact={compact} />}
		</SelectedGameGuard>
	);
};

interface LaunchModalContentProps {
	selectedGame: GameData;
	compact: boolean;
}

function LaunchModalContent({ selectedGame, compact }: LaunchModalContentProps) {
	const { t } = useTranslation();
	const timeTrackingMode = useStore((s) => s.timeTrackingMode);
	const updateGameMutation = useUpdateGame();
	const { launchGame, stopGame, isGameRunning, getGameRealTimeState } =
		useGamePlayStore();

	const selectedGameId = selectedGame.id;
	const isThisGameRunning = isGameRunning(selectedGameId);
	const isSteamLaunch = selectedGame.launch_type === "steam";
	const hasLaunchPath = isSteamLaunch
		? Boolean(selectedGame.steam_launch_id && selectedGame.steam_monitor_path)
		: Boolean(
				selectedGame.localpath ||
					selectedGame.custom_data?.extraLocalPaths?.some((path) => path?.trim()),
			);
	const realTimeState = getGameRealTimeState(selectedGameId);

	// 用于 elapsed 模式下的前端计时器显示
	const timerRef = useRef<HTMLSpanElement>(null);
	const [stopping, setStopping] = useState(false);

	// 路径设置对话框状态
	const [pathDialogOpen, setPathDialogOpen] = useState(false);
	const [localPath, setLocalPath] = useState<string>("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (
			timeTrackingMode !== "elapsed" ||
			!isThisGameRunning ||
			!realTimeState?.startTime
		) {
			return;
		}

		const startTime = realTimeState.startTime;

		const updateDisplay = () => {
			if (!timerRef.current) return;

			const now = Math.floor(Date.now() / 1000);
			const elapsed = now - startTime;
			const minutes = Math.floor(elapsed / 60);
			const seconds = elapsed % 60;
			timerRef.current.textContent = formatPlayTime(minutes, seconds);
		};

		updateDisplay();

		const intervalId = setInterval(updateDisplay, 1000);

		return () => {
			clearInterval(intervalId);
		};
	}, [timeTrackingMode, isThisGameRunning, realTimeState?.startTime]);

	const handleStartGame = async () => {
		const result = await launchGame(selectedGameId);
		if (!result.success) snackbar.error(result.message);
	};

	const handleStopGame = async () => {
		setStopping(true);
		try {
			const res = await stopGame(selectedGameId);
			if (!res.success) {
				snackbar.error(
					res.message ||
						t("components.LaunchModal.stopFailed", "游戏停止失败:"),
				);
			}
		} catch (error) {
			snackbar.error(
				`${t("components.LaunchModal.stopFailed", "游戏停止失败:")}: ${getUserErrorMessage(error, t)}`,
			);
		} finally {
			setStopping(false);
		}
	};

	const handleOpenPathDialog = () => {
		try {
			setLocalPath(selectedGame.localpath || "");
			setPathDialogOpen(true);
		} catch (error) {
			console.error("Failed to load game data:", error);
		}
	};

	const handleClosePathDialog = () => {
		if (!isSaving) {
			setPathDialogOpen(false);
			setLocalPath("");
		}
	};

	const handleSelectExecutable = async () => {
		try {
			const selectedPath = await handleExeFile();
			if (selectedPath) {
				setLocalPath(selectedPath);
			}
		} catch (error) {
			snackbar.error(
				`${t("components.LaunchModal.selectFolder", "选择文件夹")}: ${getUserErrorMessage(error, t)}`,
			);
		}
	};

	const handleSavePath = async () => {
		if (!localPath.trim()) {
			snackbar.error(
				t("components.LaunchModal.pathRequired", "请选择或输入路径"),
			);
			return;
		}

		setIsSaving(true);
		try {
			const updateData: UpdateGameParams = {
				localpath: cleanPathQuotes(localPath),
			};

			await updateGameMutation.mutateAsync({
				gameId: selectedGameId,
				updates: updateData,
			});
			snackbar.success(t("components.LaunchModal.pathSaved", "路径已保存"));
			handleClosePathDialog();
		} catch (error) {
			snackbar.error(
				`${t("components.LaunchModal.pathSaveFailed", "保存路径失败")}: ${getUserErrorMessage(error, t)}`,
			);
		} finally {
			setIsSaving(false);
		}
	};

	if (stopping) {
		if (compact) {
			return <ToolbarIconAction label={t("components.LaunchModal.stoppingGame", "停止游戏中...")} disabled onClick={() => undefined}><StopIcon /></ToolbarIconAction>;
		}
		return (
			<Button startIcon={<StopIcon />} disabled>
				{t("components.LaunchModal.stoppingGame", "停止游戏中...")}
			</Button>
		);
	}

	if (isThisGameRunning && realTimeState) {
		const { currentSessionMinutes, currentSessionSeconds } = realTimeState;
		const initialTimeDisplay = formatPlayTime(
			currentSessionMinutes,
			currentSessionSeconds,
		);

		const elapsedInitial = realTimeState.startTime
			? Math.floor(Date.now() / 1000) - realTimeState.startTime
			: 0;
		const elapsedInitialDisplay = formatPlayTime(
			Math.floor(elapsedInitial / 60),
			elapsedInitial % 60,
		);

		if (compact) {
			return <ToolbarIconAction label={t("components.LaunchModal.stopGame", "停止游戏")} color="error" onClick={handleStopGame}><StopIcon /></ToolbarIconAction>;
		}

		return (
			<Button
				startIcon={<StopIcon />}
				onClick={handleStopGame}
				className="rounded"
				color="error"
				variant="outlined"
			>
				<TimerIcon fontSize="small" color="disabled" />
				<Typography
					ref={timerRef}
					className="ml-1"
					variant="button"
					component="span"
					color="textDisabled"
				>
					{timeTrackingMode === "elapsed"
						? elapsedInitialDisplay
						: initialTimeDisplay}
				</Typography>
			</Button>
		);
	}

	if (hasLaunchPath) {
		if (compact) {
			return <ToolbarIconAction label={t("components.LaunchModal.launchGame", "启动游戏")} onClick={handleStartGame}><PlayArrowIcon /></ToolbarIconAction>;
		}
		return (
			<Button startIcon={<PlayArrowIcon />} onClick={handleStartGame}>
				{t("components.LaunchModal.launchGame", "启动游戏")}
			</Button>
		);
	}

	return isSteamLaunch ? (
		compact ? (
			<ToolbarIconAction label={t("components.LaunchModal.steamAssociationRequired", "请先在详情页关联 Steam 游戏")} disabled onClick={() => undefined}><PlayArrowIcon /></ToolbarIconAction>
		) : (
			<Button startIcon={<PlayArrowIcon />} disabled>
				{t("components.LaunchModal.steamAssociationRequired", "请先在详情页关联 Steam 游戏")}
			</Button>
		)
	) : (
		<>
			{compact ? (
				<ToolbarIconAction label={t("components.LaunchModal.syncLocalPath", "同步本地")} onClick={handleOpenPathDialog}><SyncIcon /></ToolbarIconAction>
			) : (
				<Button
					startIcon={<SyncIcon />}
					onClick={handleOpenPathDialog}
					variant="text"
				>
					{t("components.LaunchModal.syncLocalPath", "同步本地")}
				</Button>
			)}

			<Dialog
				open={pathDialogOpen}
				onClose={handleClosePathDialog}
				maxWidth="sm"
				fullWidth
			>
				<DialogTitle>
					{t("components.LaunchModal.setLocalPathTitle", "设置本地路径")}
				</DialogTitle>
				<DialogContent>
					<Box sx={{ display: "flex", gap: 1, mt: 2 }}>
						<TextField
							label={t(
								"components.LaunchModal.localPathLabel",
								"可执行文件路径",
							)}
							variant="outlined"
							fullWidth
							value={localPath}
							onChange={(e) =>
								setLocalPath(cleanPathQuotes(e.target.value))
							}
							disabled={isSaving}
							onKeyDown={(e) => {
								if (e.key === "Enter" && localPath.trim()) {
									handleSavePath();
								}
							}}
						/>
						<IconButton
							onClick={handleSelectExecutable}
							disabled={isSaving}
							color="primary"
						>
							<FolderOpenIcon />
						</IconButton>
					</Box>
				</DialogContent>
				<DialogActions>
					<Button onClick={handleClosePathDialog} disabled={isSaving}>
						{t("common.cancel", "取消")}
					</Button>
					<Button
						onClick={handleSavePath}
						variant="contained"
						disabled={!localPath.trim() || isSaving}
					>
						{isSaving
							? t("common.saving", "保存中...")
							: t("common.confirm", "确认")}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
}
