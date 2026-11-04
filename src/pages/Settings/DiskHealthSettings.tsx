import LockOpenIcon from "@mui/icons-material/LockOpen";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
	Alert,
	Box,
	Button,
	CircularProgress,
	InputLabel,
	Stack,
	Switch,
	TextField,
	Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsHelp } from "@/components/SettingsHelp";
import { diskHealthService } from "@/services/invoke";
import { useModStore } from "@/store/modStore";
import {
	isDiskHealthBlockedByGame,
	refreshDiskHealth,
} from "@/utils/diskHealth";
import { getUserErrorMessage } from "@/utils/errors";

function samePath(left: string | null, right: string): boolean {
	return (
		left !== null &&
		left.replaceAll("/", "\\").toLocaleLowerCase() ===
			right.replaceAll("/", "\\").toLocaleLowerCase()
	);
}

export const DiskHealthSettings = () => {
	const { t, i18n } = useTranslation();
	const diskHealth = useModStore((state) => state.diskHealth);
	const toolWorkspacePath = useModStore((state) => state.toolWorkspacePath);
	const setEnabled = useModStore((state) => state.setDiskHealthEnabled);
	const setRefreshIntervalHours = useModStore(
		(state) => state.setDiskHealthRefreshIntervalHours,
	);
	const recordAuthorization = useModStore(
		(state) => state.recordDiskHealthAuthorization,
	);
	const recordSuccess = useModStore(
		(state) => state.recordDiskHealthSuccess,
	);
	const clearAuthorization = useModStore(
		(state) => state.clearDiskHealthAuthorization,
	);
	const [loading, setLoading] = useState(false);
	const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
	const [refreshIntervalInput, setRefreshIntervalInput] = useState(
		String(diskHealth.refreshIntervalHours),
	);
	const ready =
		diskHealth.snapshot !== null &&
		samePath(diskHealth.testedPath, diskHealth.executablePath);
	const authorized =
		diskHealth.authorizationFingerprint !== null &&
		samePath(diskHealth.authorizedPath, diskHealth.executablePath);
	const needsAuthorization =
		diskHealth.lastError?.includes("[ELEVATION_REQUIRED]") === true;
	const authorizationStale =
		diskHealth.lastError?.includes("[AUTH_STALE]") === true;
	const gameRunning = diskHealth.lastError?.includes("[GAME_RUNNING]") === true;
	useEffect(() => {
		setRefreshIntervalInput(String(diskHealth.refreshIntervalHours));
	}, [diskHealth.refreshIntervalHours]);

	useEffect(() => {
		setConnectionNotice(null);
	}, [diskHealth.executablePath]);

	const commitRefreshInterval = () => {
		const hours = Number(refreshIntervalInput);
		const normalized = Number.isInteger(hours)
			? Math.min(24, Math.max(1, hours))
			: 1;
		setRefreshIntervalHours(normalized);
		setRefreshIntervalInput(String(normalized));
	};

	const prepareConnection = async () => {
		setLoading(true);
		try {
			const result = await diskHealthService.prepareConnection(
				diskHealth.executablePath,
				toolWorkspacePath,
			);
			setConnectionNotice(
				`${t(
					"pages.Settings.diskHealth.connectionPrepared",
					"连接文件已准备，双击运行后再检查连接。",
				)} ${result.filePath}`,
			);
		} catch (error) {
			const message = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.diskHealth.prepareFailed", "准备失败"),
			);
			useModStore
				.getState()
				.recordDiskHealthError(new Date().toISOString(), message);
		} finally {
			setLoading(false);
		}
	};

	const checkConnection = async () => {
		if (isDiskHealthBlockedByGame()) {
			useModStore
				.getState()
				.recordDiskHealthError(
					new Date().toISOString(),
					"[GAME_RUNNING] 游戏运行中",
				);
			return;
		}
		setLoading(true);
		try {
			const result = await diskHealthService.checkConnection(
				diskHealth.executablePath,
				toolWorkspacePath,
			);
			recordAuthorization(result.executablePath, result.fingerprint);
			recordSuccess(
				result.executablePath,
				result.snapshot.checkedAt,
				result.snapshot,
			);
			setConnectionNotice(
				t("pages.Settings.diskHealth.connected", "已连接"),
			);
		} catch (error) {
			const message = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.diskHealth.checkFailed", "连接失败"),
			);
			useModStore
				.getState()
				.recordDiskHealthError(new Date().toISOString(), message);
		} finally {
			setLoading(false);
		}
	};

	const prepareDisconnection = async () => {
		setLoading(true);
		try {
			await diskHealthService.prepareDisconnection(toolWorkspacePath);
			clearAuthorization();
			setConnectionNotice(
				t(
					"pages.Settings.diskHealth.disconnectionPrepared",
					"取消文件已准备，双击后完成清理。",
				),
			);
		} catch (error) {
			const message = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.diskHealth.disconnectFailed", "准备失败"),
			);
			useModStore
				.getState()
				.recordDiskHealthError(new Date().toISOString(), message);
		} finally {
			setLoading(false);
		}
	};

	const read = async () => {
		setLoading(true);
		try {
			await refreshDiskHealth({ force: true, allowDisabled: true });
		} catch (error) {
			const message = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.diskHealth.readFailed", "读取失败"),
			);
			useModStore
				.getState()
				.recordDiskHealthError(new Date().toISOString(), message);
		} finally {
			setLoading(false);
		}
	};

	const lastSuccess = diskHealth.lastSuccessAt
		? new Intl.DateTimeFormat(i18n.language, {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			}).format(new Date(diskHealth.lastSuccessAt))
		: null;

	return (
		<Box className="mb-6">
			<Stack
				direction={{ xs: "column", sm: "row" }}
				alignItems={{ sm: "center" }}
				spacing={1}
				useFlexGap
				flexWrap="wrap"
			>
				<Box>
					<Stack direction="row" alignItems="center">
						<InputLabel className="font-semibold">
						{t("pages.Settings.diskHealth.title", "磁盘健康")}
						</InputLabel>
						<SettingsHelp
							text={t(
							"pages.Settings.diskHealth.description",
							"每 {{hours}} 小时读取健康状态与最高温度。",
							{ hours: diskHealth.refreshIntervalHours },
						)}
						/>
					</Stack>
				</Box>
				<Switch
					checked={diskHealth.enabled}
					onChange={(event) => setEnabled(event.target.checked)}
					disabled={loading || (!diskHealth.enabled && !ready)}
				/>
				<TextField
					size="small"
					label={t("pages.Settings.diskHealth.interval", "刷新间隔")}
					value={refreshIntervalInput}
					onChange={(event) =>
						setRefreshIntervalInput(event.target.value.replace(/\D/g, ""))
					}
					onBlur={commitRefreshInterval}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
					}}
					inputProps={{ inputMode: "numeric", pattern: "[0-9]*" }}
					disabled={loading}
					sx={{ width: 118 }}
				/>
				<Typography variant="body2" color="text.secondary">
					{t("pages.Settings.diskHealth.hours", "小时（1–24）")}
				</Typography>
			</Stack>

			<Stack
				direction="row"
				spacing={1}
				alignItems="center"
				useFlexGap
				flexWrap="wrap"
				className="mt-2"
			>
				<Button
					variant="contained"
					startIcon={loading ? <CircularProgress size={16} /> : <RefreshIcon />}
					onClick={read}
					disabled={loading || !diskHealth.executablePath.trim()}
				>
					{diskHealth.enabled
						? t("pages.Settings.diskHealth.refresh", "刷新")
						: t("pages.Settings.diskHealth.test", "测试读取")}
				</Button>
				{(needsAuthorization ||
					authorizationStale ||
					connectionNotice !== null) &&
					!authorized && (
						<>
							<Button
								variant="outlined"
								startIcon={<LockOpenIcon />}
								onClick={prepareConnection}
								disabled={loading}
							>
								{t("pages.Settings.diskHealth.prepareConnection", "准备连接")}
							</Button>
							<Button
								variant="outlined"
								onClick={checkConnection}
								disabled={loading}
							>
								{t("pages.Settings.diskHealth.checkConnection", "检查连接")}
							</Button>
						</>
					)}
				{authorized && (
					<Button
						variant="text"
						onClick={prepareDisconnection}
						disabled={loading}
					>
						{t("pages.Settings.diskHealth.disconnect", "取消连接")}
					</Button>
				)}
				{ready && lastSuccess && !diskHealth.lastError && (
					<Typography variant="caption" color="text.secondary">
						{diskHealth.enabled
							? t("pages.Settings.diskHealth.updated", "已更新")
							: t("pages.Settings.diskHealth.ready", "已就绪")}
						{` · ${lastSuccess} · ${diskHealth.snapshot?.drives.length ?? 0} ${t(
							"pages.Settings.diskHealth.disks",
							"块",
						)}`}
					</Typography>
				)}
			</Stack>

			{connectionNotice && (
				<Alert severity="info" className="mt-3">
					{connectionNotice}
				</Alert>
			)}
			{diskHealth.lastError && (
				<Alert
					severity={
						needsAuthorization || authorizationStale || gameRunning
							? "warning"
							: "error"
					}
					className="mt-3"
				>
					{needsAuthorization
						? t("pages.Settings.diskHealth.connectionRequired", "需要连接")
						: authorizationStale
							? t("pages.Settings.diskHealth.connectionStale", "连接失效")
							: gameRunning
								? t("pages.Settings.diskHealth.gameRunning", "游戏运行中")
								: diskHealth.lastError}
				</Alert>
			)}
		</Box>
	);
};
