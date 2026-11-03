import HistoryIcon from "@mui/icons-material/History";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import TimerIcon from "@mui/icons-material/Timer";
import {
	Box,
	Button,
	ButtonBase,
	Chip,
	CircularProgress,
	Paper,
	Typography,
} from "@mui/material";
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useStore } from "@/store/appStore";
import { useGamePlayStore } from "@/store/gamePlayStore";
import type { GameData, GameTimeStats } from "@/types";
import {
	formatPlayTime,
	formatRelativeTime,
	getGameCover,
	getGameDisplayName,
} from "@/utils/appUtils";

interface FocusGamePanelProps {
	game: GameData;
	isRunning: boolean;
	lastPlayed?: number;
	stats: GameTimeStats | null | undefined;
	recentGames: Array<{ game: GameData; lastPlayed: number }>;
	isStopping: boolean;
	onLaunch: (game: GameData) => void;
	onStop: () => void;
	onSelectRecent: (gameId: number) => void;
}

const coverAspectCache = new Map<string, boolean>();

function getCoverIsPortrait(url: string): boolean | undefined {
	if (!url) return undefined;
	const cached = coverAspectCache.get(url);
	if (cached !== undefined) return cached;

	const image = new Image();
	image.src = url;
	if (image.complete && image.naturalWidth > 0) {
		const portrait = image.naturalHeight > image.naturalWidth;
		coverAspectCache.set(url, portrait);
		return portrait;
	}
	return undefined;
}

function getWeekPlayTime(stats: GameTimeStats | null | undefined): number {
	if (!stats?.daily_stats) return 0;
	const now = new Date();
	const weekStart = new Date(now);
	const daysFromMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
	weekStart.setDate(now.getDate() - daysFromMonday);
	weekStart.setHours(0, 0, 0, 0);
	const weekStartKey = `${weekStart.getFullYear()}-${String(
		weekStart.getMonth() + 1,
	).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;

	return stats.daily_stats.reduce(
		(total, item) => total + (item.date >= weekStartKey ? item.playtime : 0),
		0,
	);
}

function formatSessionTime(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function FocusGamePanel({
	game,
	isRunning,
	lastPlayed,
	stats,
	recentGames,
	isStopping,
	onLaunch,
	onStop,
	onSelectRecent,
}: FocusGamePanelProps) {
	const { t } = useTranslation();
	const timeTrackingMode = useStore((state) => state.timeTrackingMode);
	const realTimeState = useGamePlayStore(
		(state) => state.gameRealTimeStates[game.id],
	);
	const coverUrl = getGameCover(game);
	const cachedPortrait = getCoverIsPortrait(coverUrl);
	const [coverLayout, setCoverLayout] = useState<{
		url: string;
		isPortrait: boolean;
	} | null>(null);
	const isPortrait =
		cachedPortrait ??
		(coverLayout?.url === coverUrl ? coverLayout.isPortrait : false);
	const [elapsedSeconds, setElapsedSeconds] = useState(() =>
		Math.max(0, Math.floor(Date.now() / 1000) - (realTimeState?.startTime ?? 0)),
	);

	useLayoutEffect(() => {
		const portrait = getCoverIsPortrait(coverUrl);
		if (portrait !== undefined) {
			setCoverLayout({ url: coverUrl, isPortrait: portrait });
		}
	}, [coverUrl]);

	useEffect(() => {
		if (!isRunning || timeTrackingMode !== "elapsed" || !realTimeState?.startTime) {
			return;
		}
		const updateElapsed = () =>
			setElapsedSeconds(
				Math.max(0, Math.floor(Date.now() / 1000) - realTimeState.startTime),
			);
		updateElapsed();
		const intervalId = window.setInterval(updateElapsed, 1000);
		return () => window.clearInterval(intervalId);
	}, [isRunning, realTimeState?.startTime, timeTrackingMode]);

	const canLaunch = Boolean(game.localpath) || game.launch_type === "steam";
	const weekPlayTime = getWeekPlayTime(stats);

	return (
		<Paper
			variant="outlined"
			className="relative min-h-[330px] overflow-hidden !bg-slate-950 !text-white"
		>
			<Box
				component="img"
				src={coverUrl}
				alt=""
				className={`absolute inset-0 h-full w-full object-cover ${
					isPortrait ? "scale-110 blur-2xl" : ""
				}`}
				onLoad={(event) => {
					const image = event.currentTarget;
					if (image.naturalWidth <= 0) return;
					const portrait = image.naturalHeight > image.naturalWidth;
					coverAspectCache.set(coverUrl, portrait);
					setCoverLayout({ url: coverUrl, isPortrait: portrait });
				}}
			/>
			{isPortrait ? (
				<Box
					className="absolute inset-y-3 right-3 w-[48%]"
					sx={{
						maskImage: "linear-gradient(90deg, transparent 0%, black 28%)",
					}}
				>
					<Box
						component="img"
						src={coverUrl}
						alt=""
						className="h-full w-full object-contain object-right drop-shadow-[0_8px_24px_rgba(0,0,0,.45)]"
					/>
				</Box>
			) : null}
			<Box
				className="absolute inset-0"
				sx={{
					background: isPortrait
						? "linear-gradient(90deg, rgba(7,13,27,.96) 0%, rgba(7,13,27,.82) 42%, rgba(7,13,27,.24) 72%, rgba(7,13,27,.34) 100%)"
						: "linear-gradient(90deg, rgba(7,13,27,.94) 0%, rgba(7,13,27,.76) 42%, rgba(7,13,27,.18) 76%, rgba(7,13,27,.32) 100%)",
				}}
			/>
			<Box className="relative z-1 flex min-h-[330px] flex-col p-5">
				<Chip
					label={
						isRunning
							? t("home.focus.running", "正在运行")
							: lastPlayed
								? t("home.focus.continue", "继续游戏")
								: t("home.focus.start", "启动游戏")
					}
					size="small"
					className="!self-start !bg-[rgba(37,99,235,.72)] !font-bold !text-white"
				/>
				<Typography
					component="h2"
					className={`mt-3 line-clamp-2 text-[26px] leading-[1.2] font-bold min-[1200px]:text-[34px] ${
						isPortrait ? "max-w-[58%]" : "max-w-[72%]"
					}`}
					title={getGameDisplayName(game)}
				>
					{getGameDisplayName(game)}
				</Typography>
				<Typography className="mt-2 flex items-center gap-1.5 text-[rgba(255,255,255,.78)]">
					{isRunning && realTimeState ? (
						<>
							<TimerIcon fontSize="small" />
							<span>
								{t("home.focus.currentSession", "本次游玩 {{time}}", {
									time: formatSessionTime(
										timeTrackingMode === "elapsed"
											? elapsedSeconds
											: realTimeState.currentSessionMinutes * 60 +
												realTimeState.currentSessionSeconds,
									),
								})}
							</span>
						</>
					) : isRunning ? (
						t("home.focus.currentlyPlaying", "正在记录本次游玩")
					) : lastPlayed
							? t("home.focus.lastPlayed", "上次游玩：{{time}}", {
									time: formatRelativeTime(lastPlayed),
								})
							: t("home.focus.notPlayed", "还没有游玩记录")}
				</Typography>
				<Typography className="mt-1 text-[rgba(255,255,255,.78)]">
					{t("home.focus.playTime", "本周 {{week}} · 总计 {{total}}", {
						week: formatPlayTime(weekPlayTime),
						total: formatPlayTime(stats?.totalMinutes ?? 0),
					})}
				</Typography>
				<Box className="mt-3 flex flex-wrap gap-2.5">
					{isRunning ? (
						<Button
							variant="contained"
							color="error"
							startIcon={
								isStopping ? <CircularProgress size={16} color="inherit" /> : <StopIcon />
							}
							disabled={isStopping}
							onClick={onStop}
						>
							{isStopping
								? t("components.LaunchModal.stoppingGame", "停止游戏中...")
								: t("components.LaunchModal.stopGame", "停止游戏")}
						</Button>
					) : (
						<Button
							variant="contained"
							startIcon={<PlayArrowIcon />}
							disabled={!canLaunch}
							onClick={() => onLaunch(game)}
						>
							{canLaunch
								? t("home.focus.start", "启动游戏")
								: t("components.LaunchModal.syncLocalPath", "同步本地")}
						</Button>
					)}
					<Button
						component={Link}
						to={`/libraries/${game.id}`}
						variant="outlined"
						startIcon={<InfoOutlinedIcon />}
						className="!border-[rgba(255,255,255,.55)] !text-white hover:!border-white hover:!bg-[rgba(255,255,255,.08)]"
					>
						{t("home.focus.details", "查看详情")}
					</Button>
				</Box>

				{recentGames.length > 0 ? (
					<Box className="mt-auto pt-4">
						<Box className="mb-1.5 flex items-center gap-2">
							<HistoryIcon fontSize="small" />
							<Typography variant="body2" fontWeight={700}>
								{t("home.focus.recent", "最近玩过")}
							</Typography>
						</Box>
						<Box className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-4">
							{recentGames.map((recent) => (
								<ButtonBase
									key={recent.game.id}
									onClick={() => onSelectRecent(recent.game.id)}
									className="h-13 min-w-0 justify-start overflow-hidden rounded-2xl border border-solid border-[rgba(255,255,255,.22)] bg-[rgba(7,13,27,.48)] text-left"
									sx={{
										borderColor:
											game.id === recent.game.id
												? "primary.light"
												: "rgba(255,255,255,.22)",
									}}
								>
									<Box
										component="img"
										src={getGameCover(recent.game)}
										alt=""
										className="h-full w-[50px] shrink-0 object-cover"
									/>
									<Box className="min-w-0 px-2">
										<Typography variant="body2" fontWeight={700} noWrap>
											{getGameDisplayName(recent.game)}
										</Typography>
										<Typography
											variant="caption"
											className="text-[rgba(255,255,255,.66)]"
											noWrap
										>
											{formatRelativeTime(recent.lastPlayed)}
										</Typography>
									</Box>
								</ButtonBase>
							))}
						</Box>
					</Box>
				) : null}
			</Box>
		</Paper>
	);
}
