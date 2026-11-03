import ArchiveIcon from "@mui/icons-material/Archive";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { Box, CircularProgress, Typography } from "@mui/material";
import { useGameArchiveTaskStore } from "@/store/gameArchiveTaskStore";

export function GameArchiveSidebarStatus({ mini }: { mini: boolean }) {
	const task = useGameArchiveTaskStore();
	if (task.phase === "idle") return null;
	const running = ["preparing", "packing", "verifying", "deleting"].includes(task.phase);
	const position = task.totalInBatch > 1 ? `${Math.min(task.completedInBatch + 1, task.totalInBatch)}/${task.totalInBatch}` : "";
	return (
		<Box
			onClick={task.expand}
			title={`${position ? `${position} · ` : ""}${task.message ?? "游戏打包"}`}
			sx={{ mx: mini ? 0.75 : 1.25, mb: 0.75, p: 0.75, minHeight: 36, borderRadius: 2, cursor: "pointer", bgcolor: task.phase === "failed" ? "error.lighter" : "action.hover", display: "flex", alignItems: "center", gap: 0.75 }}
		>
			{running ? <CircularProgress size={18} /> : task.phase === "failed" ? <ErrorOutlineIcon color="error" fontSize="small" /> : <ArchiveIcon color="success" fontSize="small" />}
			{!mini && <Typography variant="caption" noWrap sx={{ minWidth: 0 }}>{position ? `${position} · ` : ""}{task.message ?? "游戏打包"}</Typography>}
		</Box>
	);
}
