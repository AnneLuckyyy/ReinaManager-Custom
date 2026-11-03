import type { MonthlyDatabaseBackupState } from "@/store/modStore";
import { useModStore } from "@/store/modStore";
import {
	createAutoDatabaseBackup,
	isDatabaseImportInProgress,
} from "@/utils/database";

const FAILURE_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MonthlyDatabaseBackupSchedule {
	due: boolean;
	dueAt: Date;
	duePeriod: string;
	nextScheduledAt: Date;
	nextRetryAt: Date | null;
}

export type MonthlyDatabaseBackupRunStatus =
	| "disabled"
	| "not-due"
	| "throttled"
	| "busy"
	| "success"
	| "error";

let monthlyDatabaseBackupPromise: Promise<MonthlyDatabaseBackupRunStatus> | null =
	null;

function daysInMonth(year: number, month: number): number {
	return new Date(year, month + 1, 0).getDate();
}

function createScheduledDate(
	year: number,
	month: number,
	day: number,
): Date {
	return new Date(
		year,
		month,
		Math.min(day, daysInMonth(year, month)),
		0,
		0,
		0,
		0,
	);
}

function getPeriod(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message)
		return error.message.slice(0, 500);
	if (typeof error === "string") return error.slice(0, 500);
	return "未知错误";
}

export function getMonthlyDatabaseBackupSchedule(
	state: MonthlyDatabaseBackupState,
	now = new Date(),
): MonthlyDatabaseBackupSchedule {
	const currentScheduledAt = createScheduledDate(
		now.getFullYear(),
		now.getMonth(),
		state.day,
	);
	const previousScheduledAt = createScheduledDate(
		now.getFullYear(),
		now.getMonth() - 1,
		state.day,
	);
	const nextMonthScheduledAt = createScheduledDate(
		now.getFullYear(),
		now.getMonth() + 1,
		state.day,
	);
	const dueAt =
		now >= currentScheduledAt ? currentScheduledAt : previousScheduledAt;
	const duePeriod = getPeriod(dueAt);
	const enabledAt = state.enabledAt ? new Date(state.enabledAt) : null;
	const due =
		state.enabled &&
		enabledAt !== null &&
		Number.isFinite(enabledAt.getTime()) &&
		duePeriod >= getPeriod(enabledAt) &&
		state.lastSuccessPeriod !== duePeriod;
	const nextScheduledAt =
		now < currentScheduledAt ? currentScheduledAt : nextMonthScheduledAt;
	const lastAttemptAt = state.lastAttemptAt
		? new Date(state.lastAttemptAt)
		: null;
	const nextRetryAt =
		due &&
		state.lastError !== null &&
		state.lastAttemptPeriod === duePeriod &&
		lastAttemptAt !== null &&
		Number.isFinite(lastAttemptAt.getTime())
			? new Date(lastAttemptAt.getTime() + FAILURE_RETRY_INTERVAL_MS)
			: null;

	return {
		due,
		dueAt,
		duePeriod,
		nextScheduledAt,
		nextRetryAt,
	};
}

export async function runMonthlyDatabaseBackupIfDue(options?: {
	forceRetry?: boolean;
	now?: Date;
}): Promise<MonthlyDatabaseBackupRunStatus> {
	if (monthlyDatabaseBackupPromise) return monthlyDatabaseBackupPromise;

	monthlyDatabaseBackupPromise = (async () => {
		const now = options?.now ?? new Date();
		const store = useModStore.getState();
		const state = store.monthlyDatabaseBackup;
		if (!state.enabled) return "disabled";

		const schedule = getMonthlyDatabaseBackupSchedule(state, now);
		if (!schedule.due) return "not-due";
		if (
			!options?.forceRetry &&
			schedule.nextRetryAt !== null &&
			schedule.nextRetryAt > now
		) {
			return "throttled";
		}
		if (isDatabaseImportInProgress()) return "busy";

		const attemptedAt = new Date().toISOString();
		store.recordMonthlyDatabaseBackupAttempt(schedule.duePeriod, attemptedAt);

		try {
			const result = await createAutoDatabaseBackup(
				"scheduled",
				state.includeCovers,
				state.maxAutoBackups,
			);
			const completedAt = new Date().toISOString();
			if (!result.database.success) {
				useModStore
					.getState()
					.recordMonthlyDatabaseBackupError(
						completedAt,
						result.database.message || "数据库备份失败",
					);
				return "error";
			}

			const currentStore = useModStore.getState();
			currentStore.recordMonthlyDatabaseBackupSuccess(
				schedule.duePeriod,
				completedAt,
				result.database.path,
			);
			currentStore.recordAutoDatabaseBackupSuccess(
				completedAt,
				result.database.path,
				result.warnings.length > 0 ? result.warnings.join("；") : null,
			);
			return "success";
		} catch (error) {
			const message = getErrorMessage(error);
			const currentStore = useModStore.getState();
			currentStore.recordMonthlyDatabaseBackupError(
				new Date().toISOString(),
				message,
			);
			currentStore.recordAutoDatabaseBackupError(message);
			return "error";
		}
	})().finally(() => {
		monthlyDatabaseBackupPromise = null;
	});

	return monthlyDatabaseBackupPromise;
}
