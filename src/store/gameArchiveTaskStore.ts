import { create } from "zustand";

export type GameArchiveTaskPhase =
	| "idle"
	| "preparing"
	| "packing"
	| "verifying"
	| "deleting"
	| "completed"
	| "failed";

export type GameArchiveProgressEvent = {
	gameId: number;
	phase: Exclude<GameArchiveTaskPhase, "idle">;
	message: string;
};

type GameArchiveTaskState = {
	gameId: number | null;
	gameName: string | null;
	phase: GameArchiveTaskPhase;
	message: string | null;
	archivePath: string | null;
	queuedCount: number;
	completedInBatch: number;
	totalInBatch: number;
	expanded: boolean;
	start: (gameId: number, gameName: string) => void;
	applyProgress: (progress: GameArchiveProgressEvent) => void;
	complete: (archivePath: string, message: string) => void;
	fail: (message: string) => void;
	queue: () => void;
	finishQueueJob: () => void;
	expand: () => void;
	collapse: () => void;
	dismiss: () => void;
};

/** 归档任务只存于当前运行内存，重启后不假装仍有后台任务。 */
export const useGameArchiveTaskStore = create<GameArchiveTaskState>()((set) => ({
	gameId: null,
	gameName: null,
	phase: "idle",
	message: null,
	archivePath: null,
	queuedCount: 0,
	completedInBatch: 0,
	totalInBatch: 0,
	expanded: false,
	start: (gameId, gameName) => set({
		gameId,
		gameName,
		phase: "preparing",
		message: "正在准备打包任务",
		archivePath: null,
		expanded: false,
	}),
	applyProgress: (progress) => set((current) => (
		current.gameId === progress.gameId
			? { phase: progress.phase, message: progress.message }
			: current
	)),
	complete: (archivePath, message) => set({
		phase: "completed",
		message,
		archivePath,
	}),
	fail: (message) => set({ phase: "failed", message }),
	queue: () => set((current) => {
		const isNewBatch = current.queuedCount === 0 && current.phase === "idle";
		return {
			queuedCount: current.queuedCount + 1,
			completedInBatch: isNewBatch ? 0 : current.completedInBatch,
			totalInBatch: isNewBatch ? 1 : current.totalInBatch + 1,
		};
	}),
	finishQueueJob: () => set((current) => ({
		queuedCount: Math.max(0, current.queuedCount - 1),
		completedInBatch: current.completedInBatch + 1,
	})),
	expand: () => set({ expanded: true }),
	collapse: () => set({ expanded: false }),
	dismiss: () => set({
		gameId: null,
		gameName: null,
		phase: "idle",
		message: null,
		archivePath: null,
		queuedCount: 0,
		completedInBatch: 0,
		totalInBatch: 0,
		expanded: false,
	}),
}));

type ArchiveQueueJob = () => Promise<void>;
let archiveQueue: ArchiveQueueJob[] = [];
let processing = false;
let successDismissTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 单线程归档队列。密码与具体操作闭包只保留在当前进程内存，绝不写入 store。
 * 每项自行报告成功/失败，队列始终继续处理下一项。
 */
export function enqueueGameArchive(job: ArchiveQueueJob) {
	if (successDismissTimer) {
		clearTimeout(successDismissTimer);
		successDismissTimer = null;
	}
	archiveQueue.push(job);
	useGameArchiveTaskStore.getState().queue();
	if (!processing) void processArchiveQueue();
}

async function processArchiveQueue() {
	processing = true;
	while (archiveQueue.length > 0) {
		const job = archiveQueue.shift();
		if (!job) continue;
		try {
			await job();
		} catch {
			// 具体任务已负责展示失败原因；此处仅保证后续项继续执行。
		}
		useGameArchiveTaskStore.getState().finishQueueJob();
	}
	processing = false;
	const state = useGameArchiveTaskStore.getState();
	if (state.phase === "completed") {
		successDismissTimer = setTimeout(() => {
			const latest = useGameArchiveTaskStore.getState();
			if (latest.queuedCount === 0 && latest.phase === "completed") latest.dismiss();
		}, 4500);
	}
}
