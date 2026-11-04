import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import RestorePageIcon from "@mui/icons-material/RestorePage";
import SaveIcon from "@mui/icons-material/Save";
import {
	Checkbox,
	IconButton,
	Switch,
	Tooltip,
	Typography,
} from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { path } from "@tauri-apps/api";
import { isEnabled } from "@tauri-apps/plugin-autostart";
import { load } from "@tauri-apps/plugin-store";
import { join } from "pathe";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useLogLevel, useSetLogLevel } from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { SettingsHelp } from "@/components/SettingsHelp";
import { fileService } from "@/services/invoke";
import { toggleAutostart } from "@/services/plugins/autoStartService";
import { useStore } from "@/store/appStore";
import { getUserErrorMessage } from "@/utils/errors";

export const AutoStartSettings = () => {
	const { t } = useTranslation();
	const [autoStart, setAutoStart] = useState(false);
	const [silentAutostart, setSilentAutostart] = useState(false);
	const [isSavingSilentAutostart, setIsSavingSilentAutostart] = useState(false);
	const SILENT_AUTOSTART_STORE_KEY = "silent_autostart";

	useEffect(() => {
		const loadSettings = async () => {
			const [enabled, store] = await Promise.all([
				isEnabled(),
				load("settings.json", { autoSave: false, defaults: {} }),
			]);
			setAutoStart(enabled);
			setSilentAutostart(
				(await store.get<boolean>(SILENT_AUTOSTART_STORE_KEY)) === true,
			);
		};
		void loadSettings();
	}, []);

	const handleSilentAutostartChange = async (enabled: boolean) => {
		setIsSavingSilentAutostart(true);
		try {
			const store = await load("settings.json", {
				autoSave: false,
				defaults: {},
			});
			await store.set(SILENT_AUTOSTART_STORE_KEY, enabled);
			await store.save();
			setSilentAutostart(enabled);
		} catch (error) {
			console.error("保存开机静默启动设置失败:", error);
			snackbar.error(t("pages.Settings.saveFailed", "保存设置失败"));
		} finally {
			setIsSavingSilentAutostart(false);
		}
	};

	return (
		<Stack
			spacing={1.25}
		>
			<Stack direction="row" alignItems="center" spacing={1}>
				<Box><InputLabel className="font-semibold">
					{t("pages.Settings.autoStart", "开机自启")}
				</InputLabel></Box>
				<Switch
					checked={autoStart}
					onChange={() => {
						setAutoStart(!autoStart);
						void toggleAutostart();
					}}
					color="primary"
				/>
			</Stack>
			<Stack direction="row" alignItems="center" spacing={1}>
				<Box><Stack direction="row" alignItems="center">
					<InputLabel className="font-semibold">开机时静默启动</InputLabel>
					<SettingsHelp text="仅开机自启时隐藏主窗口；托盘不可用会自动显示窗口。" />
				</Stack></Box>
				<Switch
					checked={silentAutostart}
					disabled={isSavingSilentAutostart}
					onChange={(event) => void handleSilentAutostartChange(event.target.checked)}
					color="primary"
				/>
			</Stack>
		</Stack>
	);
};

export const LogLevelSettings = () => {
	const { t } = useTranslation();
	const { data: logLevel = "error" } = useLogLevel();
	const setLogLevelMutation = useSetLogLevel();

	const handleChange = async (event: SelectChangeEvent) => {
		const level = event.target.value as "error" | "warn" | "info" | "debug";
		try {
			await setLogLevelMutation.mutateAsync(level);
			snackbar.success(
				t("pages.Settings.logLevel.changed", `日志级别已切换为 ${level}`, {
					level,
				}),
			);
		} catch {
			snackbar.error(
				t("pages.Settings.logLevel.changeFailed", "切换日志级别失败"),
			);
		}
	};

	const handleOpenLogFolder = async () => {
		try {
			const AppLocalData = await path.appLocalDataDir();
			const logDir = join(AppLocalData, "logs");
			await fileService.openDirectory(logDir);
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.logLevel.openFolderFailed", "打开文件夹失败"),
			);
			snackbar.error(
				t(
					"pages.Settings.logLevel.openFolderError",
					"打开日志文件夹失败: {{error}}",
					{ error: errorMessage },
				),
			);
		}
	};

	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.logLevel.title", "日志设置")}
			</InputLabel>
			<Stack
				direction={{ xs: "column", sm: "row" }}
				alignItems={{ xs: "stretch", sm: "center" }}
				justifyContent="flex-start"
			spacing={1}
			>
				<Stack direction="row" alignItems="center">
						<InputLabel className="text-sm">
						{t("pages.Settings.logLevel.levelLabel", "日志输出级别")}
						</InputLabel>
						<SettingsHelp
							text={t(
							"pages.Settings.logLevel.description",
							"仅当前会话有效，不会保存。用于临时调整后端日志输出详尽程度。",
						)}
						/>
					</Stack>
				<Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
					<Select
						value={logLevel}
						onChange={handleChange}
						className="min-w-40"
						size="small"
					>
						<MenuItem value="error">Error</MenuItem>
						<MenuItem value="warn">Warn</MenuItem>
						<MenuItem value="info">Info</MenuItem>
						<MenuItem value="debug">Debug</MenuItem>
					</Select>
					<Button
						variant="outlined"
						color="primary"
						onClick={handleOpenLogFolder}
						startIcon={<FolderOpenIcon />}
						className="px-6 py-2"
					>
						{t("pages.Settings.logLevel.openFolder", "打开日志文件夹")}
					</Button>
				</Stack>
			</Stack>
		</Box>
	);
};

export const CloseBtnSettings = () => {
	const { t } = useTranslation();
	const {
		skipCloseRemind,
		defaultCloseAction,
		setSkipCloseRemind,
		setDefaultCloseAction,
	} = useStore(
		useShallow((s) => ({
			skipCloseRemind: s.skipCloseRemind,
			defaultCloseAction: s.defaultCloseAction,
			setSkipCloseRemind: s.setSkipCloseRemind,
			setDefaultCloseAction: s.setDefaultCloseAction,
		})),
	);
	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.closeSettings", "关闭设置")}
			</InputLabel>
			<Stack
				direction={{ xs: "column", sm: "row" }}
				alignItems={{ sm: "center" }}
				spacing={1}
				useFlexGap
				flexWrap="wrap"
			>
				<Stack direction="row" alignItems="center" spacing={1}>
					<Typography variant="body2">
						{t("pages.Settings.skipCloseRemind", "不再提醒")}
					</Typography>
					<Checkbox
						checked={skipCloseRemind}
						onChange={(e) => setSkipCloseRemind(e.target.checked)}
						inputProps={{ "aria-label": t("pages.Settings.skipCloseRemind", "不再提醒") }}
						color="primary"
					/>
				</Stack>
				<Button
					size="small"
					variant={defaultCloseAction === "hide" ? "contained" : "outlined"}
					disabled={!skipCloseRemind}
					onClick={() => setDefaultCloseAction("hide")}
				>
					{t("pages.Settings.closeToTray", "最小化到托盘")}
				</Button>
				<Button
					size="small"
					variant={defaultCloseAction === "close" ? "contained" : "outlined"}
					disabled={!skipCloseRemind}
					onClick={() => setDefaultCloseAction("close")}
				>
					{t("pages.Settings.closeApp", "直接退出应用")}
				</Button>
			</Stack>
		</Box>
	);
};

export const TimeTrackingModeSettings = () => {
	const { t } = useTranslation();
	const timeTrackingMode = useStore((s) => s.timeTrackingMode);
	const setTimeTrackingMode = useStore((s) => s.setTimeTrackingMode);

	return (
		<Box>
			<Stack direction="row" alignItems="center" className="mb-2">
				<InputLabel className="font-semibold">
					{t("pages.Settings.timeTrackingMode.title", "游戏计时模式")}
				</InputLabel>
				<SettingsHelp
					text={t(
						"pages.Settings.timeTrackingMode.description",
						"选择游戏时间的计算方式，影响游戏运行时的时间显示和统计记录。",
					)}
				/>
			</Stack>
			<Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
				<Button
					variant={timeTrackingMode === "playtime" ? "contained" : "outlined"}
					onClick={() => setTimeTrackingMode("playtime")}
					aria-pressed={timeTrackingMode === "playtime"}
					size="small"
					sx={{ minHeight: 32, px: 1.75, py: 0.25 }}
				>
					{t("pages.Settings.timeTrackingMode.playtime", "真实游戏时间")}
				</Button>
				<Button
					variant={timeTrackingMode === "elapsed" ? "contained" : "outlined"}
					onClick={() => setTimeTrackingMode("elapsed")}
					aria-pressed={timeTrackingMode === "elapsed"}
					size="small"
					sx={{ minHeight: 32, px: 1.75, py: 0.25 }}
				>
					{t("pages.Settings.timeTrackingMode.elapsed", "游戏启动时间")}
				</Button>
			</Stack>
		</Box>
	);
};

export const LinuxLaunchCommandSettings = () => {
	const { t } = useTranslation();
	const [launchCommand, setLaunchCommand] = useState("wine");
	const [isLoading, setIsLoading] = useState(false);
	const [originalCommand, setOriginalCommand] = useState("wine");

	// 持久化 Linux 启动命令的存储键
	const STORE_KEY = "linux_launch_command";
	const STORE_PATH = "settings.json";

	// 加载当前设置的启动命令
	useEffect(() => {
		const loadLaunchCommand = async () => {
			setIsLoading(true);
			try {
				const store = await load(STORE_PATH, {
					autoSave: false,
					defaults: {
						[STORE_KEY]: "wine",
					},
				});
				const savedCommand = await store.get<string>(STORE_KEY);
				if (savedCommand) {
					setLaunchCommand(savedCommand);
					setOriginalCommand(savedCommand);
				}
			} catch (error) {
				console.error("加载 Linux 启动命令失败:", error);
			} finally {
				setIsLoading(false);
			}
		};
		loadLaunchCommand();
	}, []);

	const handleSaveCommand = async () => {
		setIsLoading(true);

		try {
			const store = await load(STORE_PATH, { autoSave: false, defaults: {} });
			await store.set(STORE_KEY, launchCommand.trim() || "wine");
			await store.save();
			setOriginalCommand(launchCommand.trim() || "wine");
			snackbar.success(
				t(
					"pages.Settings.linuxLaunchCommand.saveSuccess",
					"Linux 启动命令已保存",
				),
			);
		} catch (error) {
			console.error("保存 Linux 启动命令失败:", error);
			snackbar.error(
				t("pages.Settings.linuxLaunchCommand.saveError", "保存失败"),
			);
		} finally {
			setIsLoading(false);
		}
	};

	const handleReset = () => {
		setLaunchCommand("wine");
	};

	return (
		<Box>
			<InputLabel className="font-semibold mb-1">
				{t("pages.Settings.linuxLaunchCommand.title", "Linux 启动命令")}
			</InputLabel>

			<Typography
				variant="caption"
				color="text.secondary"
				className="block mb-2"
			>
				{t(
					"pages.Settings.linuxLaunchCommand.description",
					"设置 Linux 上启动 Windows 可执行文件（.exe）时使用的命令。支持 wine、proton 或其他兼容层命令，也可以是 PATH 中的可执行文件或脚本的完整路径。",
				)}
			</Typography>

			<Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
				<TextField
					label={t(
						"pages.Settings.linuxLaunchCommand.commandLabel",
						"启动命令",
					)}
					variant="outlined"
					value={launchCommand}
					onChange={(e) => setLaunchCommand(e.target.value)}
					className="min-w-60 flex-grow"
					sx={{ width: { xs: "100%", sm: "auto" } }}
					placeholder="wine"
					disabled={isLoading}
					size="small"
					helperText={t(
						"pages.Settings.linuxLaunchCommand.helperText",
						"例如: wine, /usr/bin/wine, ~/scripts/run-game.sh",
					)}
				/>

				<Tooltip
					title={t(
						"pages.Settings.linuxLaunchCommand.resetTooltip",
						"重置为默认值 (wine)",
					)}
				>
					<IconButton
						onClick={handleReset}
						disabled={isLoading || launchCommand === "wine"}
						color="default"
					>
						<RestorePageIcon />
					</IconButton>
				</Tooltip>

				<Button
					variant="contained"
					color="primary"
					onClick={handleSaveCommand}
					disabled={isLoading || launchCommand === originalCommand}
					startIcon={<SaveIcon />}
					className="px-4 py-2"
				>
					{t("pages.Settings.linuxLaunchCommand.saveBtn", "保存")}
				</Button>
			</Stack>

			<Typography
				variant="caption"
				color="text.secondary"
				className="block mt-2"
			>
				{t(
					"pages.Settings.linuxLaunchCommand.note",
					"注意：更改此设置后，需要重新启动游戏才能生效。",
				)}
			</Typography>
		</Box>
	);
};
