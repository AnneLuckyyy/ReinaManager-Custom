import ArchiveIcon from "@mui/icons-material/Archive";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { Box, CircularProgress, LinearProgress, Typography } from "@mui/material";
import { useGameArchiveTaskStore } from "@/store/gameArchiveTaskStore";

const activePhases = new Set(["preparing", "packing", "verifying", "deleting"]);

export function GameArchiveSidebarStatus({ mini }: { mini: boolean }) {
	const taskState = useGameArchiveTaskStore();
	if (taskState.tasks.length === 0) return null;
	const active = taskState.tasks.find((task) => activePhases.has(task.phase));
	const waiting = taskState.tasks.filter((task) => task.phase === "queued");
	const failed = taskState.tasks.find((task) => task.phase === "failed");
	const headline = active
		? `${active.gameName} · ${active.phase === "packing" && active.progress !== null ? `打包 ${active.progress}/100` : active.message}`
		: failed ? `${failed.gameName} · 打包失败`
		: "游戏打包已完成";
	const waitingNames = waiting.map((task) => task.gameName).join("、");

	return (
		<Box
			onClick={taskState.expand}
			title={`${headline}${waitingNames ? `\n等待：${waitingNames}` : ""}`}
			sx={{ mx: mini ? 0.75 : 1.25, mb: 0.75, p: 0.75, minHeight: 36, borderRadius: 2, cursor: "pointer", bgcolor: failed ? "error.lighter" : "action.hover", display: "flex", alignItems: "flex-start", gap: 0.75 }}
		>
			{active ? <CircularProgress size={18} /> : failed ? <ErrorOutlineIcon color="error" fontSize="small" /> : <ArchiveIcon color="success" fontSize="small" />}
			{!mini && <Box sx={{ minWidth: 0, flex: 1 }}>
				<Typography variant="caption" noWrap sx={{ display: "block" }}>{headline}</Typography>
				{active?.phase === "packing" && active.progress !== null && <LinearProgress variant="determinate" value={active.progress} sx={{ mt: 0.45, height: 4, borderRadius: 3 }} />}
				{waiting.length > 0 && <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>等待：{waitingNames}</Typography>}
			</Box>}
		</Box>
	);
}
