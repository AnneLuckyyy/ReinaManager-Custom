import BackupIcon from "@mui/icons-material/Backup";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import ImageIcon from "@mui/icons-material/Image";
import RestoreIcon from "@mui/icons-material/Restore";
import {
	Accordion,
	AccordionDetails,
	AccordionSummary,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Divider,
	Switch,
	TextField,
	Typography,
} from "@mui/material";
import { SettingsHelp } from "@/components/SettingsHelp";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputLabel from "@mui/material/InputLabel";
import Stack from "@mui/material/Stack";
import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { snackbar } from "@/providers/snackBar";
import { useModStore } from "@/store/modStore";
import { openDatabaseBackupFolder } from "@/utils/appUtils";
import {
	backupCustomCovers,
	backupDatabase,
	importDatabase,
	restoreCustomCovers,
} from "@/utils/database";
import { getUserErrorMessage } from "@/utils/errors";
import {
	getMonthlyDatabaseBackupSchedule,
	runMonthlyDatabaseBackupIfDue,
} from "@/utils/monthlyDatabaseBackup";

export const DatabaseBackupSettings = () => {
	const { t, i18n } = useTranslation();
	const [isBackingUp, setIsBackingUp] = useState(false);
	const [isBackingCovers, setIsBackingCovers] = useState(false);
	const [isRestoringCovers, setIsRestoringCovers] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
	const [restoreCoversConfirmOpen, setRestoreCoversConfirmOpen] =
		useState(false);
	const [isRetryingAutomaticBackup, setIsRetryingAutomaticBackup] =
		useState(false);
	const monthlyDatabaseBackup = useModStore(
		(state) => state.monthlyDatabaseBackup,
	);
	const [automaticBackupDayInput, setAutomaticBackupDayInput] = useState(
		String(monthlyDatabaseBackup.day),
	);
	const setMonthlyDatabaseBackupEnabled = useModStore(
		(state) => state.setMonthlyDatabaseBackupEnabled,
	);
	const updateMonthlyDatabaseBackupSchedule = useModStore(
		(state) => state.updateMonthlyDatabaseBackupSchedule,
	);
	const updateMonthlyDatabaseBackupOptions = useModStore(
		(state) => state.updateMonthlyDatabaseBackupOptions,
	);
	const automaticBackupSchedule = useMemo(
		() => getMonthlyDatabaseBackupSchedule(monthlyDatabaseBackup),
		[monthlyDatabaseBackup],
	);
	const dateTimeFormatter = useMemo(
		() =>
			new Intl.DateTimeFormat(i18n.resolvedLanguage || undefined, {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			}),
		[i18n.resolvedLanguage],
	);

	useEffect(() => {
		setAutomaticBackupDayInput(String(monthlyDatabaseBackup.day));
	}, [monthlyDatabaseBackup.day]);

	const handleBackupDatabase = async () => {
		setIsBackingUp(true);

		try {
			const result = await backupDatabase();
			if (result.success) {
				snackbar.success(
					t(
						"pages.Settings.databaseBackup.backupSuccess",
						"数据库备份成功: {{path}}",
						{
							path: result.path,
						},
					),
				);
			} else {
				snackbar.error(
					t(
						"pages.Settings.databaseBackup.backupError",
						"数据库备份失败: {{error}}",
						{
							error: result.message,
						},
					),
				);
			}
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.databaseBackup.backupFailed", "备份失败"),
			);
			snackbar.error(
				t(
					"pages.Settings.databaseBackup.backupError",
					"数据库备份失败: {{error}}",
					{ error: errorMessage },
				),
			);
		} finally {
			setIsBackingUp(false);
		}
	};

	const handleBackupCustomCovers = async () => {
		setIsBackingCovers(true);

		try {
			const result = await backupCustomCovers();
			if (result.success) {
				snackbar.success(
					result.path
						? t(
								"pages.Settings.databaseBackup.coverBackupSuccess",
								"自定义封面备份成功: {{path}}",
								{
									path: result.path,
								},
							)
						: t(
								"pages.Settings.databaseBackup.noCoversToBackup",
								"没有自定义封面需要备份",
							),
				);
			} else {
				snackbar.error(
					t(
						"pages.Settings.databaseBackup.coverBackupError",
						"自定义封面备份失败: {{error}}",
						{
							error: result.message,
						},
					),
				);
			}
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t(
					"pages.Settings.databaseBackup.coverBackupFailed",
					"备份自定义封面失败",
				),
			);
			snackbar.error(
				t(
					"pages.Settings.databaseBackup.coverBackupError",
					"自定义封面备份失败: {{error}}",
					{
						error: errorMessage,
					},
				),
			);
		} finally {
			setIsBackingCovers(false);
		}
	};

	const handleRestoreCustomCovers = async () => {
		setIsRestoringCovers(true);
		try {
			const result = await restoreCustomCovers();
			if (!result) return;
			snackbar.success(result.message);
			setTimeout(async () => {
				await relaunch();
			}, 2000);
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.databaseBackup.coverRestoreFailed", "恢复自定义封面失败"),
			);
			snackbar.error(
				t(
					"pages.Settings.databaseBackup.coverRestoreError",
					"恢复自定义封面失败: {{error}}",
					{ error: errorMessage },
				),
			);
		} finally {
			setIsRestoringCovers(false);
		}
	};

	const handleOpenBackupFolder = async () => {
		try {
			await openDatabaseBackupFolder();
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.databaseBackup.openFolderFailed", "打开文件夹失败"),
			);
			snackbar.error(
				t(
					"pages.Settings.databaseBackup.openFolderError",
					"打开备份文件夹失败: {{error}}",
					{
						error: errorMessage,
					},
				),
			);
		}
	};

	const handleImportDatabase = async () => {
		setIsImporting(true);
		try {
			const result = await importDatabase();
			if (result) {
				if (result.success) {
					snackbar.success(
						result.message ||
							t(
								"pages.Settings.databaseBackup.importSuccess",
								"数据库导入成功，已备份自定义封面并清空封面缓存，应用将自动重启",
							),
					);
					// 延迟重启应用，让用户看到成功提示
					setTimeout(async () => {
						await relaunch();
					}, 2000);
				} else {
					snackbar.error(
						t(
							"pages.Settings.databaseBackup.importError",
							"数据库导入失败: {{error}}",
							{
								error: result.message,
							},
						),
					);
				}
			}
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.databaseBackup.importFailed", "导入失败"),
			);
			snackbar.error(
				t(
					"pages.Settings.databaseBackup.importError",
					"数据库导入失败: {{error}}",
					{ error: errorMessage },
				),
			);
		} finally {
			setIsImporting(false);
		}
	};

	const handleAutomaticBackupEnabled = (enabled: boolean) => {
		setMonthlyDatabaseBackupEnabled(enabled);
		if (enabled) {
			void runMonthlyDatabaseBackupIfDue();
		}
	};

	const handleAutomaticBackupScheduleChange = (schedule: { day?: number }) => {
		updateMonthlyDatabaseBackupSchedule(schedule);
		void runMonthlyDatabaseBackupIfDue();
	};

	const handleAutomaticBackupOptionsChange = (options: {
		includeCovers?: boolean;
		maxAutoBackups?: number;
		backupOnExit?: boolean;
		exitMinIntervalHours?: number;
	}) => {
		updateMonthlyDatabaseBackupOptions(options);
	};

	const handleAutomaticBackupDayInput = (value: string) => {
		if (!/^\d*$/.test(value)) return;
		if (value === "") {
			setAutomaticBackupDayInput("");
			return;
		}

		const day = Math.min(31, Math.max(1, Number(value)));
		setAutomaticBackupDayInput(String(day));
	};

	const commitAutomaticBackupDay = () => {
		if (automaticBackupDayInput === "") {
			setAutomaticBackupDayInput(String(monthlyDatabaseBackup.day));
			return;
		}

		const day = Math.min(31, Math.max(1, Number(automaticBackupDayInput)));
		setAutomaticBackupDayInput(String(day));
		if (day !== monthlyDatabaseBackup.day) {
			handleAutomaticBackupScheduleChange({ day });
		}
	};

	const handleRetryAutomaticBackup = async () => {
		setIsRetryingAutomaticBackup(true);
		try {
			await runMonthlyDatabaseBackupIfDue({ forceRetry: true });
		} finally {
			setIsRetryingAutomaticBackup(false);
		}
	};

	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.databaseBackup.title", "数据备份与恢复")}
			</InputLabel>

			<Stack
				direction="row"
				spacing={1}
				useFlexGap
				alignItems="center"
				flexWrap="wrap"
			>
				<Button
					variant="contained"
					color="primary"
					onClick={handleBackupDatabase}
					disabled={isBackingUp}
					startIcon={
						isBackingUp ? (
							<CircularProgress size={16} color="inherit" />
						) : (
							<BackupIcon />
						)
					}
					className="px-6 py-2"
				>
					{isBackingUp
						? t("pages.Settings.databaseBackup.backing", "备份中...")
						: t("pages.Settings.databaseBackup.backup", "备份数据库")}
				</Button>

				<Button
					variant="outlined"
					color="warning"
					onClick={() => setRestoreConfirmOpen(true)}
					disabled={isImporting}
					startIcon={
						isImporting ? (
							<CircularProgress size={16} color="inherit" />
						) : (
							<RestoreIcon />
						)
					}
					className="px-6 py-2"
				>
					{isImporting
						? t("pages.Settings.databaseBackup.importing", "导入中...")
						: t("pages.Settings.databaseBackup.restore", "恢复数据库")}
				</Button>

				<Button
					variant="outlined"
					color="primary"
					onClick={handleBackupCustomCovers}
					disabled={isBackingCovers}
					startIcon={
						isBackingCovers ? (
							<CircularProgress size={16} color="inherit" />
						) : (
							<ImageIcon />
						)
					}
					className="px-6 py-2"
				>
					{isBackingCovers
						? t("pages.Settings.databaseBackup.backingCovers", "备份封面中...")
						: t("pages.Settings.databaseBackup.backupCovers", "备份自定义封面")}
				</Button>

				<Button
					variant="outlined"
					color="warning"
					onClick={() => setRestoreCoversConfirmOpen(true)}
					disabled={isRestoringCovers || isImporting}
					startIcon={
						isRestoringCovers ? (
							<CircularProgress size={16} color="inherit" />
						) : (
							<ImageIcon />
						)
					}
					className="px-6 py-2"
				>
					{isRestoringCovers
						? t("pages.Settings.databaseBackup.restoringCovers", "恢复封面中...")
						: t("pages.Settings.databaseBackup.restoreCovers", "恢复自定义封面")}
				</Button>

				<Button
					variant="outlined"
					color="primary"
					onClick={handleOpenBackupFolder}
					startIcon={<FolderOpenIcon />}
					className="px-6 py-2"
				>
					{t("pages.Settings.databaseBackup.openFolder", "打开备份文件夹")}
				</Button>

			</Stack>

			<Box className="mt-2">
				<Stack divider={<Divider flexItem />}>
				<Stack
					direction={{ xs: "column", md: "row" }}
					spacing={1.5}
					alignItems={{ md: "center" }}
					justifyContent="flex-start"
					className="px-1 py-2"
				>
					<Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ minWidth: { md: 210 } }}>
						<Stack direction="row" alignItems="center">
							<InputLabel className="font-semibold">
								{t("pages.Settings.databaseBackup.monthlyEnabled", "每月自动备份")}
							</InputLabel>
							<SettingsHelp
								text={t(
									"pages.Settings.databaseBackup.monthlyHelp",
									"在所选日期的 00:00 备份。应用未运行时会在下次启动补做，短月份使用最后一天。",
								)}
							/>
						</Stack>
						<Switch
							checked={monthlyDatabaseBackup.enabled}
							onChange={(_, checked) => handleAutomaticBackupEnabled(checked)}
						/>
					</Stack>
					<Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
						<TextField
						size="small"
						label={t("pages.Settings.databaseBackup.monthlyDay", "备份日期")}
						value={automaticBackupDayInput}
						onChange={(event) =>
							handleAutomaticBackupDayInput(event.target.value)
						}
						onBlur={commitAutomaticBackupDay}
						onKeyDown={(event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}}
						disabled={!monthlyDatabaseBackup.enabled}
						slotProps={{
							htmlInput: {
								inputMode: "numeric",
								pattern: "[0-9]*",
								maxLength: 2,
							},
						}}
						sx={{ width: { xs: "100%", md: 160 } }}
						/>
					</Stack>
				</Stack>

				<Stack
					direction={{ xs: "column", md: "row" }}
					spacing={1.5}
					alignItems={{ md: "center" }}
					justifyContent="flex-start"
					className="px-1 py-2"
				>
					<Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ minWidth: { md: 210 } }}>
						<Stack direction="row" alignItems="center">
							<InputLabel className="font-semibold">
								{t("pages.Settings.databaseBackup.autoIncludeCovers", "包含自定义封面")}
							</InputLabel>
							<SettingsHelp
								text={t(
									"pages.Settings.databaseBackup.autoIncludeCoversHelp",
									"开启后，月度和退出自动备份会额外创建自定义封面归档；网络封面缓存不会写入归档。",
								)}
							/>
						</Stack>
						<Switch
							checked={monthlyDatabaseBackup.includeCovers}
							onChange={(_, checked) =>
								handleAutomaticBackupOptionsChange({ includeCovers: checked })
							}
						/>
					</Stack>
					<TextField
						size="small"
						type="number"
						label={t(
							"pages.Settings.databaseBackup.autoRetention",
							"保留自动备份",
						)}
						value={monthlyDatabaseBackup.maxAutoBackups}
						onChange={(event) => {
							const value = Number(event.target.value);
							if (Number.isInteger(value)) {
								handleAutomaticBackupOptionsChange({
									maxAutoBackups: value,
								});
							}
						}}
						slotProps={{ htmlInput: { min: 1, max: 30 } }}
						sx={{ width: { xs: "100%", md: 160 } }}
					/>
				</Stack>

				<Stack
					direction={{ xs: "column", md: "row" }}
					spacing={1.5}
					alignItems={{ md: "center" }}
					justifyContent="flex-start"
					className="px-1 py-2"
				>
					<Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ minWidth: { md: 210 } }}>
						<Stack direction="row" alignItems="center">
							<InputLabel className="font-semibold">
								{t("pages.Settings.databaseBackup.autoExit", "退出时备份")}
							</InputLabel>
							<SettingsHelp
								text={t(
									"pages.Settings.databaseBackup.autoExitHelp",
									"关闭应用时创建自动备份；间隔用于避免频繁重复备份。备份失败不会阻止退出。",
								)}
							/>
						</Stack>
						<Switch
							checked={monthlyDatabaseBackup.backupOnExit}
							onChange={(_, checked) =>
								handleAutomaticBackupOptionsChange({ backupOnExit: checked })
							}
						/>
					</Stack>
					<TextField
						size="small"
						type="number"
						label={t(
							"pages.Settings.databaseBackup.autoExitInterval",
							"退出最短间隔（小时）",
						)}
						value={monthlyDatabaseBackup.exitMinIntervalHours}
						disabled={!monthlyDatabaseBackup.backupOnExit}
						onChange={(event) => {
							const value = Number(event.target.value);
							if (Number.isInteger(value)) {
								handleAutomaticBackupOptionsChange({
									exitMinIntervalHours: value,
								});
							}
						}}
						slotProps={{ htmlInput: { min: 0, max: 168 } }}
						sx={{ width: { xs: "100%", md: 160 } }}
					/>
				</Stack>
				</Stack>

				{(monthlyDatabaseBackup.enabled ||
					monthlyDatabaseBackup.lastSuccessAt ||
					monthlyDatabaseBackup.lastAutoBackupAt ||
					monthlyDatabaseBackup.lastWarning) && (
					<Accordion disableGutters className="mt-2">
						<AccordionSummary expandIcon={<ExpandMoreIcon />} className="min-h-0 px-1">
							<Typography variant="body2" className="font-medium">
								{t("pages.Settings.databaseBackup.status", "备份状态")}
							</Typography>
						</AccordionSummary>
						<AccordionDetails className="px-1 pb-1 pt-0">
							<Stack spacing={0.5}>
						{monthlyDatabaseBackup.enabled && (
							<Typography variant="caption" color="text.secondary">
								{automaticBackupSchedule.due
									? t(
											"pages.Settings.databaseBackup.monthlyPending",
											"计划备份待执行",
										)
									: t(
											"pages.Settings.databaseBackup.monthlyNext",
											"下次备份：{{time}}",
											{
												time: dateTimeFormatter.format(
													automaticBackupSchedule.nextScheduledAt,
												),
											},
										)}
							</Typography>
						)}
						{monthlyDatabaseBackup.lastSuccessAt && (
							<Typography
								variant="caption"
								color="success.main"
								sx={{ wordBreak: "break-all" }}
							>
								{t(
									"pages.Settings.databaseBackup.monthlyLastSuccess",
									"最近成功：{{time}}",
									{
										time: dateTimeFormatter.format(
											new Date(monthlyDatabaseBackup.lastSuccessAt),
										),
									},
								)}
								{monthlyDatabaseBackup.lastSuccessPath
									? ` · ${monthlyDatabaseBackup.lastSuccessPath}`
									: ""}
							</Typography>
						)}
						{monthlyDatabaseBackup.lastAutoBackupAt && (
							<Typography
								variant="caption"
								color="success.main"
								sx={{ wordBreak: "break-all" }}
							>
								{t(
									"pages.Settings.databaseBackup.autoLastSuccess",
									"最近自动备份：{{time}}",
									{
										time: dateTimeFormatter.format(
											new Date(monthlyDatabaseBackup.lastAutoBackupAt),
										),
									},
								)}
								{monthlyDatabaseBackup.lastAutoBackupPath
									? ` · ${monthlyDatabaseBackup.lastAutoBackupPath}`
									: ""}
							</Typography>
						)}
						{monthlyDatabaseBackup.lastWarning && (
							<Typography variant="caption" color="warning.main">
								{t(
									"pages.Settings.databaseBackup.autoLastWarning",
									"最近自动备份提示：{{warning}}",
									{ warning: monthlyDatabaseBackup.lastWarning },
								)}
							</Typography>
						)}
							</Stack>
						</AccordionDetails>
					</Accordion>
				)}
				{monthlyDatabaseBackup.lastError && (
					<Stack
						direction="row"
						spacing={1}
						alignItems="center"
						flexWrap="wrap"
						useFlexGap
						className="px-1 pt-2"
					>
						<Typography variant="caption" color="error.main">
							{t(
								"pages.Settings.databaseBackup.monthlyLastError",
								"最近失败：{{error}}",
								{ error: monthlyDatabaseBackup.lastError },
							)}
						</Typography>
						{monthlyDatabaseBackup.enabled && automaticBackupSchedule.due && (
							<Button
								size="small"
								variant="text"
								onClick={handleRetryAutomaticBackup}
								disabled={isRetryingAutomaticBackup}
							>
								{isRetryingAutomaticBackup
									? t(
											"pages.Settings.databaseBackup.monthlyRetrying",
											"重试中...",
										)
									: t(
											"pages.Settings.databaseBackup.monthlyRetry",
											"立即重试",
										)}
							</Button>
						)}
					</Stack>
				)}
			</Box>
			<Dialog
				open={restoreCoversConfirmOpen}
				onClose={
					isRestoringCovers ? undefined : () => setRestoreCoversConfirmOpen(false)
				}
				maxWidth="xs"
				fullWidth
			>
				<DialogTitle>
					{t("pages.Settings.databaseBackup.restoreCovers", "恢复自定义封面")}
				</DialogTitle>
				<DialogContent>
					<Typography>
						{t(
							"pages.Settings.databaseBackup.restoreCoversWarning",
							"请选择 ReinaManager 创建的自定义封面备份。恢复前会先备份当前自定义封面；仅替换自定义封面文件，不会删除或覆盖网络封面缓存。完成后应用将自动重启以刷新显示。",
						)}
					</Typography>
				</DialogContent>
				<DialogActions>
					<Button
						onClick={() => setRestoreCoversConfirmOpen(false)}
						disabled={isRestoringCovers}
					>
						{t("common.cancel", "取消")}
					</Button>
					<Button
						color="warning"
						variant="contained"
						onClick={() => {
							setRestoreCoversConfirmOpen(false);
							void handleRestoreCustomCovers();
						}}
						disabled={isRestoringCovers}
					>
						{t("pages.Settings.databaseBackup.restoreCovers", "恢复自定义封面")}
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog
				open={restoreConfirmOpen}
				onClose={isImporting ? undefined : () => setRestoreConfirmOpen(false)}
				maxWidth="xs"
				fullWidth
			>
				<DialogTitle>
					{t("pages.Settings.databaseBackup.restore", "恢复数据库")}
				</DialogTitle>
				<DialogContent>
					<Typography>
						{t(
							"pages.Settings.databaseBackup.restoreWarning",
							"恢复会先备份当前数据库、设置和自定义封面，再清空本地封面缓存以避免错配。新备份附带的设置快照会一并恢复；历史纯数据库备份会保留当前设置。导入后应用将自动重启。",
						)}
					</Typography>
				</DialogContent>
				<DialogActions>
					<Button
						onClick={() => setRestoreConfirmOpen(false)}
						disabled={isImporting}
					>
						{t("common.cancel", "取消")}
					</Button>
					<Button
						color="warning"
						variant="contained"
						onClick={() => {
							setRestoreConfirmOpen(false);
							void handleImportDatabase();
						}}
						disabled={isImporting}
					>
						{t("pages.Settings.databaseBackup.restore", "恢复数据库")}
					</Button>
				</DialogActions>
			</Dialog>
		</Box>
	);
};
