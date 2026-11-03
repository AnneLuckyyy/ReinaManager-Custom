import { diskHealthService } from "@/services/invoke";
import { useStore } from "@/store/appStore";
import { useGamePlayStore } from "@/store/gamePlayStore";
import { useModStore } from "@/store/modStore";
import type {
	DiskHealthDrive,
	DiskHealthIndicators,
	DiskHealthSnapshot,
} from "@/types/diskHealth";
import { isDatabaseOperationInProgress } from "@/utils/database";
import { toError } from "@/utils/errors";

let diskHealthPromise: Promise<DiskHealthSnapshot> | null = null;

function isRecent(value: string | null, now: number, intervalMs: number): boolean {
	return value !== null && now - Date.parse(value) < intervalMs;
}

export function isDiskHealthBlockedByGame(): boolean {
	const gamePlay = useGamePlayStore.getState();
	if (!gamePlay.isGameRunning()) return false;
	return (
		useStore.getState().timeTrackingMode !== "playtime" ||
		!gamePlay.isAllGamePlaytimePaused()
	);
}

function grew(current: string | null, previous: string | null): boolean {
	if (current === null || previous === null) return false;
	try {
		return BigInt(current) > BigInt(previous);
	} catch {
		return false;
	}
}

function indicatorsGrew(
	current: DiskHealthIndicators,
	previous: DiskHealthIndicators,
): boolean {
	return (
		grew(current.reallocatedSectors, previous.reallocatedSectors) ||
		grew(current.pendingSectors, previous.pendingSectors) ||
		grew(current.uncorrectableSectors, previous.uncorrectableSectors) ||
		grew(current.nvmeCriticalWarning, previous.nvmeCriticalWarning) ||
		grew(current.nvmeMediaErrors, previous.nvmeMediaErrors)
	);
}

function addIndicatorTrends(
	snapshot: DiskHealthSnapshot,
	previous: DiskHealthSnapshot | null,
): DiskHealthSnapshot {
	if (!previous) return snapshot;
	const previousById = new Map(
		previous.drives.map((drive) => [drive.id, drive] as const),
	);

	return {
		...snapshot,
		drives: snapshot.drives.map((drive): DiskHealthDrive => {
			const oldDrive = previousById.get(drive.id);
			if (!oldDrive || !indicatorsGrew(drive.indicators, oldDrive.indicators)) {
				return drive;
			}
			return {
				...drive,
				health: drive.health === "normal" ? "attention" : drive.health,
				indicatorGrowth: true,
			};
		}),
	};
}

export function isDiskHealthReady(): boolean {
	const { executablePath, testedPath, snapshot } =
		useModStore.getState().diskHealth;
	return (
		snapshot !== null &&
		testedPath !== null &&
		testedPath.replaceAll("/", "\\").toLocaleLowerCase() ===
			executablePath.replaceAll("/", "\\").toLocaleLowerCase()
	);
}

export async function refreshDiskHealth(options?: {
	force?: boolean;
	allowDisabled?: boolean;
}): Promise<DiskHealthSnapshot | null> {
	const store = useModStore.getState();
	const state = store.diskHealth;
	const force = options?.force === true;
	if (isDiskHealthBlockedByGame()) {
		if (force) throw new Error("[GAME_RUNNING] 游戏运行中");
		return null;
	}
	if (diskHealthPromise) return diskHealthPromise;
	if (!state.enabled && options?.allowDisabled !== true) return null;
	if (!state.executablePath.trim()) {
		const at = new Date().toISOString();
		store.recordDiskHealthError(at, "未设置 CrystalDiskInfo 路径");
		throw new Error("未设置 CrystalDiskInfo 路径");
	}

	const now = Date.now();
	const refreshIntervalMs = state.refreshIntervalHours * 60 * 60 * 1000;
	if (!force) {
		if (isDatabaseOperationInProgress()) return null;
		if (state.lastError && isRecent(state.lastAttemptAt, now, refreshIntervalMs)) return null;
		if (!state.lastError && isRecent(state.lastSuccessAt, now, refreshIntervalMs)) return null;
	}

	const path = state.executablePath;
	const useAuthorizedTask =
		state.authorizationFingerprint !== null &&
		state.authorizedPath !== null &&
		state.authorizedPath.replaceAll("/", "\\").toLocaleLowerCase() ===
			path.replaceAll("/", "\\").toLocaleLowerCase();
	const attemptAt = new Date().toISOString();
	store.recordDiskHealthAttempt(attemptAt);
	diskHealthPromise = (async () => {
		try {
			const snapshot = addIndicatorTrends(
				await diskHealthService.read(
					path,
					useAuthorizedTask,
					useAuthorizedTask ? state.authorizationFingerprint : null,
				),
				useModStore.getState().diskHealth.snapshot,
			);
			useModStore
				.getState()
				.recordDiskHealthSuccess(path, snapshot.checkedAt, snapshot);
			return snapshot;
		} catch (error) {
			const message = toError(error, "磁盘状态读取失败").message;
			if (message.includes("[AUTH_STALE]")) {
				useModStore.getState().clearDiskHealthAuthorization();
			}
			useModStore
				.getState()
				.recordDiskHealthError(new Date().toISOString(), message);
			throw error;
		} finally {
			diskHealthPromise = null;
		}
	})();

	return diskHealthPromise;
}
