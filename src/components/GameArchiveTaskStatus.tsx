import ArchiveIcon from "@mui/icons-material/Archive";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CloseIcon from "@mui/icons-material/Close";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { Box, CircularProgress, IconButton, LinearProgress, Paper, Stack, Tooltip, Typography } from "@mui/material";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import {
	type GameArchiveProgressEvent,
	type GameArchiveTask,
	useGameArchiveTaskStore,
} from "@/store/gameArchiveTaskStore";

const activePhases = new Set(["preparing", "packing", "verifying", "deleting"]);

function phaseLabel(task: GameArchiveTask) {
	if (task.phase === "queued") return "排队等待";
	if (task.phase === "completed") return "已完成";
	if (task.phase === "failed") return "失败";
	return task.phase === "packing" && task.progress !== null
		? `打包中 ${task.progress}/100`
		: task.phase === "packing" ? "打包中" : task.phase === "verifying" ? "校验中" : task.phase === "deleting" ? "删除原目录中" : "准备中";
}

function TaskIcon({ task }: { task: GameArchiveTask }) {
	if (activePhases.has(task.phase)) return <CircularProgress size={18} />;
	if (task.phase === "failed") return <ErrorOutlineIcon color="error" fontSize="small" />;
	if (task.phase === "completed") return <CheckCircleOutlineIcon color="success" fontSize="small" />;
	return <ArchiveIcon color="action" fontSize="small" />;
}

export function GameArchiveTaskStatus() {
	const taskState = useGameArchiveTaskStore();

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void listen<GameArchiveProgressEvent>("game-archive-progress", (event) => {
			useGameArchiveTaskStore.getState().applyProgress(event.payload);
		}).then((dispose) => {
			unlisten = dispose;
		});
		return () => unlisten?.();
	}, []);

	if (taskState.tasks.length === 0 || !taskState.expanded) return null;
	const running = taskState.tasks.some((task) => activePhases.has(task.phase));
	const queuedCount = taskState.tasks.filter((task) => task.phase === "queued").length;
	const hasFailures = taskState.tasks.some((task) => task.phase === "failed");

	return (
		<Paper elevation={6} sx={{ position: "fixed", left: 112, bottom: 16, zIndex: (theme) => theme.zIndex.snackbar + 1, width: 420, maxWidth: "calc(100vw - 136px)", borderRadius: 2, overflow: "hidden" }}>
			<Box sx={{ px: 1.5, py: 1.15, display: "flex", alignItems: "center", gap: 1, borderBottom: 1, borderColor: "divider" }}>
				<ArchiveIcon color={hasFailures ? "error" : "primary"} fontSize="small" />
				<Box sx={{ minWidth: 0, flex: 1 }}>
					<Typography variant="subtitle2" fontWeight={700}>游戏打包任务</Typography>
					<Typography variant="caption" color="text.secondary">{running ? "正在处理" : hasFailures ? "存在失败任务，需要手动关闭" : "全部任务已完成"}{queuedCount > 0 ? ` · 等待 ${queuedCount} 项` : ""}</Typography>
				</Box>
				<Tooltip title={running ? "收入侧栏" : "关闭并清空本次任务"}>
					<IconButton size="small" onClick={running ? taskState.collapse : taskState.dismiss}><CloseIcon fontSize="small" /></IconButton>
				</Tooltip>
			</Box>
			<Stack spacing={0} sx={{ maxHeight: 380, overflowY: "auto" }}>
				{taskState.tasks.map((task) => (
					<Box key={task.id} sx={{ px: 1.5, py: 1.1, borderBottom: 1, borderColor: "divider", bgcolor: task.phase === "failed" ? "error.lighter" : "background.paper" }}>
						<Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
							<Box sx={{ pt: 0.2 }}><TaskIcon task={task} /></Box>
							<Box sx={{ minWidth: 0, flex: 1 }}>
								<Box sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 1 }}>
									<Typography variant="body2" fontWeight={600} noWrap>{task.gameName}</Typography>
									<Typography variant="caption" color={task.phase === "failed" ? "error.main" : task.phase === "completed" ? "success.main" : "text.secondary"} noWrap>{phaseLabel(task)}</Typography>
								</Box>
								<Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.2, wordBreak: "break-word" }}>{task.message}</Typography>
								{task.phase === "packing" && task.progress !== null && <LinearProgress variant="determinate" value={task.progress} sx={{ mt: 0.7, height: 5, borderRadius: 4 }} />}
								{task.archivePath && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.35, wordBreak: "break-all" }}>{task.archivePath}</Typography>}
							</Box>
						</Box>
					</Box>
				))}
			</Stack>
		</Paper>
	);
}
