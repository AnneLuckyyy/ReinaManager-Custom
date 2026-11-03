import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import i18n from "i18next";
import { useGamePlayStore } from "@/store/gamePlayStore";
import { useModStore } from "@/store/modStore";
import { createAutoDatabaseBackup } from "@/utils/database";

const HOUR_MS = 60 * 60 * 1000;
let exitAutoBackupPromise: Promise<void> | null = null;

const confirmTrayExitIfNeeded = async (): Promise<boolean> => {
	const runningGameCount = getRunningGameCount();

	if (runningGameCount <= 0) {
		return true;
	}

	return ask(
		i18n.t(
			"components.Window.runningExitDialog.message",
			"当前仍有 {{count}} 个游戏正在运行。退出应用后不会关闭这些游戏，但会丢失游戏时长记录。确定要退出应用吗？",
			{
				count: runningGameCount,
			},
		),
		{
			title: i18n.t("components.Window.runningExitDialog.title", "退出提醒"),
			kind: "warning",
			okLabel: i18n.t(
				"components.Window.runningExitDialog.exitApp",
				"仍然退出",
			),
			cancelLabel: i18n.t("common.cancel", "取消"),
		},
	);
};

export const getRunningGameCount = (): number => {
	return useGamePlayStore.getState().runningGameIds.size;
};

function shouldRunAutoBackupOnExit(): boolean {
	const state = useModStore.getState().monthlyDatabaseBackup;
	if (!state.backupOnExit) return false;
	if (state.exitMinIntervalHours <= 0 || !state.lastAutoBackupAt) return true;
	const lastSuccessAt = Date.parse(state.lastAutoBackupAt);
	return (
		!Number.isFinite(lastSuccessAt) ||
		Date.now() - lastSuccessAt >= state.exitMinIntervalHours * HOUR_MS
	);
}

async function runAutoBackupOnExitIfNeeded(): Promise<void> {
	if (!shouldRunAutoBackupOnExit()) return;
	if (exitAutoBackupPromise) return exitAutoBackupPromise;

	exitAutoBackupPromise = (async () => {
		const state = useModStore.getState().monthlyDatabaseBackup;
		try {
			const result = await createAutoDatabaseBackup(
				"exit",
				state.includeCovers,
				state.maxAutoBackups,
			);
			useModStore.getState().recordAutoDatabaseBackupSuccess(
				new Date().toISOString(),
				result.database.path,
				result.warnings.length > 0 ? result.warnings.join("；") : null,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "退出自动备份失败";
			console.error("退出自动备份失败:", error);
			useModStore.getState().recordAutoDatabaseBackupError(message);
		}
	})().finally(() => {
		exitAutoBackupPromise = null;
	});

	return exitAutoBackupPromise;
}

export const destroyCurrentWindow = async (): Promise<void> => {
	await runAutoBackupOnExitIfNeeded();
	await getCurrentWindow().destroy();
};

export const exitCurrentWindowFromTray = async (): Promise<void> => {
	if (await confirmTrayExitIfNeeded()) {
		await destroyCurrentWindow();
	}
};
