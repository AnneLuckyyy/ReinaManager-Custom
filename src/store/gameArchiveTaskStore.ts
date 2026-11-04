import { create } from "zustand";

export type GameArchiveTaskPhase =
	| "queued"
	| "preparing"
	| "packing"
	| "verifying"
	| "deleting"
	| "completed"
	| "failed";

export type GameArchiveProgressEvent = {
	gameId: number;
	phase: Exclude<GameArchiveTaskPhase, "queued">;
	message: string;
	progress?: number | null;
};

export type GameArchiveTask = {
	id: number;
	gameId: number;
	gameName: string;
	phase: GameArchiveTaskPhase;
	message: string;
	progress: number | null;
	archivePath: string | null;
};

type GameArchiveTaskState = {
	tasks: GameArchiveTask[];
	expanded: boolean;
	queue: (gameId: number, gameName: string) => number;
	start: (taskId: number) => void;
	applyProgress: (progress: GameArchiveProgressEvent) => void;
	complete: (gameId: number, archivePath: string, message: string) => void;
	fail: (gameId: number, message: string, archivePath?: string) => void;
	expand: () => void;
	collapse: () => void;
	dismiss: () => void;
};

let nextTaskId = 1;

function updateActiveGameTask(
	tasks: GameArchiveTask[],
	gameId: number,
	update: (task: GameArchiveTask) => GameArchiveTask,
) {
	let updated = false;
	return tasks.map((task) => {
		if (!updated && task.gameId === gameId && !["queued", "completed", "failed"].includes(task.phase)) {
			updated = true;
			return update(task);
		}
		return task;
	});
}

/** 归档任务只存于当前运行内存，重启后不假装仍有后台任务。 */
export const useGameArchiveTaskStore = create<GameArchiveTaskState>()((set) => ({
	tasks: [],
	expanded: false,
	queue: (gameId, gameName) => {
		const taskId = nextTaskId++;
		set((current) => ({
			tasks: [...current.tasks, { id: taskId, gameId, gameName, phase: "queued", message: "正在等待前方任务完成", progress: null, archivePath: null }],
		}));
		return taskId;
	},
	start: (taskId) => set((current) => ({
		tasks: current.tasks.map((task) => task.id === taskId ? { ...task, phase: "preparing", message: "正在准备打包任务", progress: null } : task),
	})),
	applyProgress: (progress) => set((current) => ({
		tasks: updateActiveGameTask(current.tasks, progress.gameId, (task) => ({ ...task, phase: progress.phase, message: progress.message, progress: progress.progress ?? null })),
	})),
	complete: (gameId, archivePath, message) => set((current) => ({
		tasks: updateActiveGameTask(current.tasks, gameId, (task) => ({ ...task, phase: "completed", message, progress: 100, archivePath: archivePath || null })),
	})),
	fail: (gameId, message, archivePath) => set((current) => {
		const taskId = [...current.tasks].reverse().find((task) => task.gameId === gameId && task.phase !== "queued")?.id;
		return {
			tasks: current.tasks.map((task) => task.id === taskId ? { ...task, phase: "failed", message, progress: null, archivePath: archivePath || task.archivePath } : task),
		};
	}),
	expand: () => set({ expanded: true }),
	collapse: () => set({ expanded: false }),
	dismiss: () => set({ tasks: [], expanded: false }),
}));

type ArchiveQueueJob = { taskId: number; run: (taskId: number) => Promise<void> };
let archiveQueue: ArchiveQueueJob[] = [];
let processing = false;
let successDismissTimer: ReturnType<typeof setTimeout> | null = null;

/** 单线程归档队列：密码只保留在当前进程闭包中，每项失败也会继续后续项。 */
export function enqueueGameArchive(params: {
	gameId: number;
	gameName: string;
	run: (taskId: number) => Promise<void>;
}) {
	if (successDismissTimer) {
		clearTimeout(successDismissTimer);
		successDismissTimer = null;
	}
	const taskId = useGameArchiveTaskStore.getState().queue(params.gameId, params.gameName);
	archiveQueue.push({ taskId, run: params.run });
	if (!processing) void processArchiveQueue();
}

async function processArchiveQueue() {
	processing = true;
	while (archiveQueue.length > 0) {
		const job = archiveQueue.shift();
		if (!job) continue;
		useGameArchiveTaskStore.getState().start(job.taskId);
		try {
			await job.run(job.taskId);
		} catch {
			// 具体任务已负责展示失败原因；此处仅保证后续项继续执行。
		}
	}
	processing = false;
	const state = useGameArchiveTaskStore.getState();
	if (state.tasks.length > 0 && state.tasks.every((task) => task.phase === "completed")) {
		successDismissTimer = setTimeout(() => {
			const latest = useGameArchiveTaskStore.getState();
			if (latest.tasks.length > 0 && latest.tasks.every((task) => task.phase === "completed")) latest.dismiss();
		}, 6000);
	}
}
