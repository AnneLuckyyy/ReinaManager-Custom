/**
 * @file PathSettingsModal 路径设置弹窗组件
 * @description 统一的路径设置弹窗，包含游戏存档备份路径、LE转区软件路径、Magpie软件路径、数据库备份路径设置
 * @module src/components/PathSettingsModal/index
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * 主要功能：
 * - 统一的路径设置弹窗
 * - 条件渲染：设置页面显示所有路径，非设置页面只显示LE和Magpie路径
 * - 集成路径选择、保存等功能
 *
 * 依赖：
 * - @mui/material
 * - @mui/icons-material
 * - @tauri-apps/api/dialog
 * - @/services/settingsService
 * - @/store
 * - react-i18next
 */

import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import SaveIcon from "@mui/icons-material/Save";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import InputLabel from "@mui/material/InputLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { open as openfile } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsHelp } from "@/components/SettingsHelp";
import { useAllSettings, useUpdateSettings } from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { savedataService } from "@/services/invoke";
import { useModStore } from "@/store/modStore";
import {
	cleanPathQuotes,
	handleGetFolder,
} from "@/utils/appUtils";
import { getUserErrorMessage } from "@/utils/errors";

/**
 * 路径设置弹窗组件属性
 */
interface PathSettingsModalProps {
	open: boolean;
	onClose: () => void;
	/** 是否在设置页面显示，如果为false只显示LE和Magpie路径 */
	inSettingsPage?: boolean;
}

interface PathSettingsDraft {
	savePath: string;
	lePath: string;
	magpiePath: string;
	dbBackupPath: string;
	diskHealthPath: string;
	toolWorkspacePath: string;
	downloadRootPath: string;
	installRootPath: string;
}

const EMPTY_DRAFT: PathSettingsDraft = {
	savePath: "",
	lePath: "",
	magpiePath: "",
	dbBackupPath: "",
	diskHealthPath: "",
	toolWorkspacePath: "",
	downloadRootPath: "",
	installRootPath: "",
};

/**
 * 路径设置弹窗组件
 * @param {PathSettingsModalProps} props
 * @returns {JSX.Element}
 */
export const PathSettingsModal: React.FC<PathSettingsModalProps> = ({
	open,
	onClose,
	inSettingsPage = true,
}) => {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<PathSettingsDraft>(EMPTY_DRAFT);
	const [initialDraft, setInitialDraft] =
		useState<PathSettingsDraft>(EMPTY_DRAFT);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const {
		data: settingsData,
		isPending,
		refetch: refetchSettings,
	} = useAllSettings({ enabled: open });
	const updateSettingsMutation = useUpdateSettings();
	const toolWorkspacePath = useModStore((state) => state.toolWorkspacePath);
	const setToolWorkspacePath = useModStore(
		(state) => state.setToolWorkspacePath,
	);
	const diskHealthPath = useModStore(
		(state) => state.diskHealth.executablePath,
	);
	const setDiskHealthPath = useModStore(
		(state) => state.setDiskHealthExecutablePath,
	);

	const initDraft = useCallback(
		(settings: NonNullable<typeof settingsData>) => {
			const nextDraft: PathSettingsDraft = {
				savePath: inSettingsPage ? (settings.save_root_path ?? "") : "",
				lePath: settings.le_path ?? "",
				magpiePath: settings.magpie_path ?? "",
				dbBackupPath: inSettingsPage ? (settings.db_backup_path ?? "") : "",
				diskHealthPath: inSettingsPage ? diskHealthPath : "",
				toolWorkspacePath: inSettingsPage ? toolWorkspacePath : "",
				downloadRootPath: inSettingsPage
					? (settings.download_root_path ?? "")
					: "",
				installRootPath: inSettingsPage
					? (settings.install_root_path ?? "")
					: "",
			};

			setDraft(nextDraft);
			setInitialDraft(nextDraft);
		},
		[inSettingsPage, diskHealthPath, toolWorkspacePath],
	);

	useEffect(() => {
		if (!open || !settingsData) {
			return;
		}
		initDraft(settingsData);
	}, [open, settingsData, initDraft]);

	const isDirty =
		draft.savePath !== initialDraft.savePath ||
		draft.lePath !== initialDraft.lePath ||
		draft.magpiePath !== initialDraft.magpiePath ||
		draft.dbBackupPath !== initialDraft.dbBackupPath ||
		draft.diskHealthPath !== initialDraft.diskHealthPath ||
		draft.toolWorkspacePath !== initialDraft.toolWorkspacePath ||
		draft.downloadRootPath !== initialDraft.downloadRootPath ||
		draft.installRootPath !== initialDraft.installRootPath;

	const isLoading = open && isPending;

	const updateDraft = (key: keyof PathSettingsDraft, value: string) => {
		setDraft((prev) => ({
			...prev,
			[key]: cleanPathQuotes(value),
		}));
	};

	/**
	 * 选择文件夹的通用处理函数
	 */
	const handleSelectFolder = async (key: keyof PathSettingsDraft) => {
		try {
			const selectedPath = await handleGetFolder();
			if (selectedPath) {
				updateDraft(key, selectedPath);
			}
		} catch (error) {
			snackbar.error(
				t(
					"components.PathSettingsModal.selectFolderError",
					"选择目录失败：{{error}}",
					{
						error: getUserErrorMessage(error, t),
					},
				),
			);
		}
	};

	/**
	 * 选择文件的通用处理函数
	 */
	const handleSelectFile = async (
		key: keyof PathSettingsDraft,
		fileTypes: string[],
	) => {
		try {
			const selectedPath = await openfile({
				multiple: false,
				filters: [
					{
						name: "Executable Files",
						extensions: fileTypes,
					},
				],
			});
			if (selectedPath && !Array.isArray(selectedPath)) {
				updateDraft(key, selectedPath);
			}
		} catch (error) {
			snackbar.error(
				t(
					"components.PathSettingsModal.selectFileError",
					"选择文件失败：{{error}}",
					{
						error: getUserErrorMessage(error, t),
					},
				),
			);
		}
	};

	/**
	 * 统一保存路径设置
	 */
	const handleSubmit = async () => {
		try {
			setIsSubmitting(true);
			const saveRootChanged =
				inSettingsPage && initialDraft.savePath !== draft.savePath;
			await updateSettingsMutation.mutateAsync({
				// 存档根目录必须走后端的复制、核验和可回滚切换，不能由通用设置直接覆盖。
				saveRootPath: undefined,
				dbBackupPath: inSettingsPage ? draft.dbBackupPath || null : undefined,
				lePath: draft.lePath || null,
				magpiePath: draft.magpiePath || null,
				downloadRootPath: inSettingsPage
					? draft.downloadRootPath || null
					: undefined,
				installRootPath: inSettingsPage
					? draft.installRootPath || null
					: undefined,
			});
			if (saveRootChanged) {
				const result = await savedataService.changeBackupRoot(draft.savePath);
				if (result.status === "saved_with_warning") {
					snackbar.warning(
						result.residue_path
							? `${result.message}：${result.residue_path}`
							: result.message,
					);
				}
				await refetchSettings();
			}
			if (inSettingsPage) {
				setDiskHealthPath(draft.diskHealthPath);
				setToolWorkspacePath(draft.toolWorkspacePath);
			}

			const nextInitialDraft = { ...draft };
			setInitialDraft(nextInitialDraft);
			snackbar.success(
				t("components.PathSettingsModal.saveSuccess", "路径设置已保存"),
			);

		} catch (error) {
			snackbar.error(
				t(
					"components.PathSettingsModal.saveError",
					"保存路径设置失败：{{error}}",
					{
						error: getUserErrorMessage(error, t),
					},
				),
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog
			open={open}
			onClose={isSubmitting ? undefined : onClose}
			maxWidth="md"
			fullWidth
			PaperProps={{
				sx: { minHeight: "60vh" },
			}}
		>
			<DialogTitle>
				{t("components.PathSettingsModal.title", "路径设置")}
			</DialogTitle>
			<DialogContent>
				<Box className="space-y-6">
					{/* 游戏存档备份路径设置 */}
					{inSettingsPage && (
						<Box>
							<Stack direction="row" alignItems="center" className="mb-4">
								<InputLabel className="font-semibold">
									{t(
										"components.PathSettingsModal.downloadRootPath.title",
										"游戏下载目录",
									)}
								</InputLabel>
								<SettingsHelp
									text={t(
										"components.PathSettingsModal.downloadRootPath.note",
										"下载任务的临时和已完成文件只会保存在这里。留空时不能创建下载任务。",
									)}
								/>
							</Stack>
							<Stack direction="row" spacing={2} alignItems="center" className="mb-2">
								<TextField
									label={t(
										"components.PathSettingsModal.downloadRootPath.pathLabel",
										"游戏下载目录",
									)}
									variant="outlined"
									value={draft.downloadRootPath}
									onChange={(e) => updateDraft("downloadRootPath", e.target.value)}
									className="min-w-60 flex-grow"
									placeholder={t(
										"components.PathSettingsModal.downloadRootPath.pathPlaceholder",
										"选择保存游戏下载文件的目录",
									)}
									disabled={isLoading}
								/>
								<Button
									variant="outlined"
									onClick={() => handleSelectFolder("downloadRootPath")}
									disabled={isLoading}
									startIcon={<FolderOpenIcon />}
									className="px-4 py-2"
								>
									{t(
										"components.PathSettingsModal.downloadRootPath.selectBtn",
										"选择目录",
									)}
								</Button>
							</Stack>
					</Box>
				)}

				{inSettingsPage && (
					<Box>
						<Stack direction="row" alignItems="center" className="mb-4">
							<InputLabel className="font-semibold">
								{t(
									"components.PathSettingsModal.installRootPath.title",
									"游戏安装目录",
								)}
							</InputLabel>
							<SettingsHelp
								text={t(
									"components.PathSettingsModal.installRootPath.note",
									"以后从资源站自动安装的游戏会放在这里。修改此项不会移动现有游戏、下载文件或临时文件。",
								)}
							/>
						</Stack>
						<Stack direction="row" spacing={2} alignItems="center" className="mb-2">
							<TextField
								label={t(
									"components.PathSettingsModal.installRootPath.pathLabel",
									"游戏安装目录",
								)}
								variant="outlined"
								value={draft.installRootPath}
								onChange={(e) => updateDraft("installRootPath", e.target.value)}
								className="min-w-60 flex-grow"
								placeholder={t(
									"components.PathSettingsModal.installRootPath.pathPlaceholder",
									"选择自动安装游戏的目录",
								)}
								disabled={isLoading}
							/>
							<Button
								variant="outlined"
								onClick={() => handleSelectFolder("installRootPath")}
								disabled={isLoading}
								startIcon={<FolderOpenIcon />}
								className="px-4 py-2"
							>
								{t(
									"components.PathSettingsModal.installRootPath.selectBtn",
									"选择目录",
								)}
							</Button>
						</Stack>
					</Box>
				)}

				{inSettingsPage && (
						<Box>
							<Stack direction="row" alignItems="center" className="mb-4">
								<InputLabel className="font-semibold">
									{t(
									"components.PathSettingsModal.savePath.title",
									"游戏存档备份路径",
								)}
								</InputLabel>
								<SettingsHelp
									text={t(
										"components.PathSettingsModal.savePath.note",
										"设置游戏存档的备份根目录路径，留空将使用默认路径",
									)}
								/>
							</Stack>
							<Stack
								direction="row"
								spacing={2}
								alignItems="center"
								className="mb-2"
							>
								<TextField
									label={t(
										"components.PathSettingsModal.savePath.pathLabel",
										"备份根目录路径",
									)}
									variant="outlined"
									value={draft.savePath}
									onChange={(e) => updateDraft("savePath", e.target.value)}
									className="min-w-60 flex-grow"
									placeholder={t(
										"components.PathSettingsModal.savePath.pathPlaceholder",
										"留空使用默认路径",
									)}
									disabled={isLoading}
								/>
								<Button
									variant="outlined"
									onClick={() => handleSelectFolder("savePath")}
									disabled={isLoading}
									startIcon={<FolderOpenIcon />}
									className="px-4 py-2"
								>
									{t(
										"components.PathSettingsModal.savePath.selectBtn",
										"选择目录",
									)}
								</Button>
							</Stack>
						</Box>
					)}

					{/* 数据库备份路径设置 */}
					{inSettingsPage && (
						<Box>
							<Stack direction="row" alignItems="center" className="mb-4">
								<InputLabel className="font-semibold">
									{t(
										"components.PathSettingsModal.dbBackupPath.title",
										"数据库备份路径",
									)}
								</InputLabel>
								<SettingsHelp
									text={t(
										"components.PathSettingsModal.dbBackupPath.note",
										"设置数据库备份文件的保存路径，留空将使用默认路径（AppData/data/backups），或便携模式下的程序目录",
									)}
								/>
							</Stack>
							<Stack
								direction="row"
								spacing={2}
								alignItems="center"
								className="mb-2"
							>
								<TextField
									label={t(
										"components.PathSettingsModal.dbBackupPath.pathLabel",
										"备份保存路径",
									)}
									variant="outlined"
									value={draft.dbBackupPath}
									onChange={(e) => updateDraft("dbBackupPath", e.target.value)}
									className="min-w-60 flex-grow"
									placeholder={t(
										"components.PathSettingsModal.dbBackupPath.pathPlaceholder",
										"留空使用默认路径",
									)}
									disabled={isLoading}
								/>
								<Button
									variant="outlined"
									onClick={() => handleSelectFolder("dbBackupPath")}
									disabled={isLoading}
									startIcon={<FolderOpenIcon />}
									className="px-4 py-2"
								>
									{t(
										"components.PathSettingsModal.dbBackupPath.selectBtn",
										"选择目录",
									)}
								</Button>
							</Stack>
						</Box>
					)}

					{/* LE转区软件路径设置 */}
					<Box>
						<Stack direction="row" alignItems="center" className="mb-4">
							<InputLabel className="font-semibold">
								{t("components.PathSettingsModal.lePath.title", "LE转区软件路径")}
							</InputLabel>
							<SettingsHelp
								text={t(
									"components.PathSettingsModal.lePath.note",
									"设置LE转区软件的可执行文件路径，用于游戏启动时的转区功能",
								)}
							/>
						</Stack>
						<Stack
							direction="row"
							spacing={2}
							alignItems="center"
							className="mb-2"
						>
							<TextField
								label={t(
									"components.PathSettingsModal.lePath.pathLabel",
									"LE转区软件路径",
								)}
								variant="outlined"
								value={draft.lePath}
								onChange={(e) => updateDraft("lePath", e.target.value)}
								className="min-w-60 flex-grow"
								placeholder={t(
									"components.PathSettingsModal.lePath.pathPlaceholder",
									"选择LE转区软件的可执行文件",
								)}
								disabled={isLoading}
							/>
							<Button
								variant="outlined"
								onClick={() => handleSelectFile("lePath", ["exe"])}
								disabled={isLoading}
								startIcon={<FolderOpenIcon />}
								className="px-4 py-2"
							>
								{t("components.PathSettingsModal.lePath.selectBtn", "选择文件")}
							</Button>
						</Stack>
					</Box>

					{/* Magpie软件路径设置 */}
					<Box>
						<Stack direction="row" alignItems="center" className="mb-4">
							<InputLabel className="font-semibold">
								{t(
								"components.PathSettingsModal.magpiePath.title",
								"Magpie软件路径",
							)}
							</InputLabel>
							<SettingsHelp
								text={t(
									"components.PathSettingsModal.magpiePath.note",
									"设置Magpie软件的可执行文件路径，用于游戏画面的放大功能",
								)}
							/>
						</Stack>
						<Stack
							direction="row"
							spacing={2}
							alignItems="center"
							className="mb-2"
						>
							<TextField
								label={t(
									"components.PathSettingsModal.magpiePath.pathLabel",
									"Magpie软件路径",
								)}
								variant="outlined"
								value={draft.magpiePath}
								onChange={(e) => updateDraft("magpiePath", e.target.value)}
								className="min-w-60 flex-grow"
								placeholder={t(
									"components.PathSettingsModal.magpiePath.pathPlaceholder",
									"选择Magpie软件的可执行文件",
								)}
								disabled={isLoading}
							/>
							<Button
								variant="outlined"
								onClick={() => handleSelectFile("magpiePath", ["exe"])}
								disabled={isLoading}
								startIcon={<FolderOpenIcon />}
								className="px-4 py-2"
							>
								{t(
									"components.PathSettingsModal.magpiePath.selectBtn",
									"选择文件",
								)}
							</Button>
						</Stack>
					</Box>

					{inSettingsPage && (
						<Box>
							<Stack direction="row" alignItems="center" className="mb-4">
								<InputLabel className="font-semibold">CrystalDiskInfo</InputLabel>
								<SettingsHelp
									text={t(
										"pages.Settings.diskHealth.pathHint",
										"选择 CrystalDiskInfo 的可执行文件；更换路径后需重新测试。",
									)}
								/>
							</Stack>
							<Stack direction="row" spacing={2} alignItems="center">
								<TextField
									label="CrystalDiskInfo"
									variant="outlined"
									value={draft.diskHealthPath}
									onChange={(event) =>
										updateDraft("diskHealthPath", event.target.value)
									}
									className="min-w-60 flex-grow"
									disabled={isLoading}
								/>
								<Button
									variant="outlined"
									onClick={() => handleSelectFile("diskHealthPath", ["exe"])}
									disabled={isLoading}
									startIcon={<FolderOpenIcon />}
									className="px-4 py-2"
								>
									{t("pages.Settings.diskHealth.choose", "选择")}
								</Button>
							</Stack>
						</Box>
					)}

					{inSettingsPage && (
						<Box>
							<Stack direction="row" alignItems="center" className="mb-4">
								<InputLabel className="font-semibold">
									{t("pages.Settings.toolWorkspace.title", "操作目录")}
								</InputLabel>
								<SettingsHelp
									text={t(
										"pages.Settings.toolWorkspace.description",
										"需要手动确认、运行或放入的文件统一放在这里。",
									)}
								/>
							</Stack>
							<Stack
								direction="row"
								spacing={2}
								alignItems="center"
								className="mb-2"
							>
								<TextField
									label={t("pages.Settings.toolWorkspace.path", "目录")}
									variant="outlined"
									value={draft.toolWorkspacePath}
									onChange={(e) => updateDraft("toolWorkspacePath", e.target.value)}
									className="min-w-60 flex-grow"
									disabled={isLoading}
								/>
								<Button
									variant="outlined"
									onClick={() => handleSelectFolder("toolWorkspacePath")}
									disabled={isLoading}
									startIcon={<FolderOpenIcon />}
									className="px-4 py-2"
								>
									{t("pages.Settings.toolWorkspace.choose", "选择")}
								</Button>
							</Stack>
						</Box>
					)}
				</Box>
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose} disabled={isSubmitting}>
					{t("components.PathSettingsModal.close", "关闭")}
				</Button>
				<Button
					variant="contained"
					onClick={handleSubmit}
					disabled={isSubmitting || isLoading || !isDirty}
					startIcon={<SaveIcon />}
				>
					{isSubmitting
						? t("components.PathSettingsModal.saving", "保存中...")
						: t("components.PathSettingsModal.saveBtn", "保存")}
				</Button>
			</DialogActions>
		</Dialog>
	);
};
