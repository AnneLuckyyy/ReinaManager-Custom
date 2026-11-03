import ArchiveIcon from "@mui/icons-material/Archive";
import CloseIcon from "@mui/icons-material/Close";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { Box, CircularProgress, IconButton, Paper, Tooltip, Typography } from "@mui/material";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import {
	type GameArchiveProgressEvent,
	useGameArchiveTaskStore,
} from "@/store/gameArchiveTaskStore";

export function GameArchiveTaskStatus() {
	const task = useGameArchiveTaskStore();

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void listen<GameArchiveProgressEvent>("game-archive-progress", (event) => {
			useGameArchiveTaskStore.getState().applyProgress(event.payload);
		}).then((dispose) => {
			unlisten = dispose;
		});
		return () => unlisten?.();
	}, []);

	if (task.phase === "idle" || !task.expanded) return null;
	const isRunning = ["preparing", "packing", "verifying", "deleting"].includes(task.phase);
	const tone = task.phase === "failed" ? "error.main" : task.phase === "completed" ? "success.main" : "primary.main";

	return (
		<Paper
			elevation={5}
			sx={{
				position: "fixed",
				left: 112,
				bottom: 16,
				zIndex: (theme) => theme.zIndex.snackbar + 1,
				width: 300,
				p: 1.25,
				borderRadius: 2,
			}}
		>
			<Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
				{isRunning ? <CircularProgress size={22} sx={{ mt: 0.25 }} /> : task.phase === "failed" ? <ErrorOutlineIcon color="error" sx={{ mt: 0.25 }} /> : <CheckCircleOutlineIcon color="success" sx={{ mt: 0.25 }} />}
				<Box sx={{ minWidth: 0, flex: 1 }}>
					<Typography variant="subtitle2" sx={{ color: tone, fontWeight: 700 }}>
						<ArchiveIcon sx={{ fontSize: 17, verticalAlign: "-3px", mr: 0.5 }} />
						{task.gameName ? `游戏打包 · ${task.gameName}` : "游戏打包"}
					</Typography>
					<Typography variant="body2" sx={{ mt: 0.25, wordBreak: "break-word" }}>
						{task.message}
					</Typography>
					{task.archivePath && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25, wordBreak: "break-all" }}>{task.archivePath}</Typography>}
				</Box>
				<Tooltip title={isRunning ? "收入侧栏" : "关闭"}><IconButton size="small" onClick={isRunning ? task.collapse : task.dismiss}><CloseIcon fontSize="small" /></IconButton></Tooltip>
			</Box>
		</Paper>
	);
}
