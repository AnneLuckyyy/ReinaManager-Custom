/**
 * @file RightMenu 组件
 * @description 游戏卡片右键菜单组件，支持启动游戏、进入详情、删除、打开文件夹等操作，集成国际化和删除确认弹窗。
 * @module src/components/RightMenu/index
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * 主要导出：
 * - RightMenu：游戏卡片右键菜单组件
 * - CollectionRightMenu：分组/分类右键菜单组件
 *
 * 依赖：
 * - @mui/icons-material
 * - @/store
 * - @/utils
 * - @/components/AlertBox
 * - react-i18next
 * - @tauri-apps/api/core
 */

import ArticleIcon from "@mui/icons-material/Article";
import ArchiveIcon from "@mui/icons-material/Archive";
import CloudOffOutlinedIcon from "@mui/icons-material/CloudOffOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import {
	Chip,
	Checkbox,
	Divider,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	FormControlLabel,
	ListItemIcon,
	ListItemText,
	MenuItem,
	MenuList,
	Tooltip,
	TextField,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertConfirmBox } from "@/components/AlertBox";
import { LinkWithScrollSave } from "@/components/LinkWithScrollSave";
import { useGameById } from "@/hooks/features/games/useGameFacade";
import { useGameStatusActions } from "@/hooks/features/games/useGameStatusActions";
import { useDeleteGame, useUpdateGame } from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";
import {
	backupCatalogService,
	fileService,
	type GameBackupArchiveRecord,
} from "@/services/invoke";
import { useStore } from "@/store/appStore";
import { useGamePlayStore } from "@/store/gamePlayStore";
import { enqueueGameArchive, useGameArchiveTaskStore } from "@/store/gameArchiveTaskStore";
import { useModStore } from "@/store/modStore";

import type { PlayStatus } from "@/types/collection";
import { handleOpenFolder } from "@/utils/appUtils";
import { getUserErrorMessage } from "@/utils/errors";
import { BaseRightMenu } from "./BaseRightMenu";
import { PlayStatusSubmenu } from "./PlayStatusSubmenu";

/**
 * RightMenu 组件属性类型
 */
interface RightMenuProps {
	id: number;
	anchorPosition: { top: number; left: number };
	onClose: () => void;
}

/**
 * 游戏卡片右键菜单组件
 * 支持启动、详情、删除、打开文件夹等操作
 *
 * @param {RightMenuProps} props 组件属性
 * @returns {JSX.Element | null} 右键菜单
 */
const RightMenu: React.FC<RightMenuProps> = ({
	anchorPosition,
	onClose,
	id,
}) => {
	const setSelectedGameId = useStore((state) => state.setSelectedGameId);
	const deleteGameMutation = useDeleteGame();
	const updateGameMutation = useUpdateGame();
	const { selectedGame } = useGameById(id);
	const launchGame = useGamePlayStore((s) => s.launchGame);
	const isGameRunning = useGamePlayStore((s) => s.isGameRunning);
	const [openAlert, setOpenAlert] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [isSettingCloudGame, setIsSettingCloudGame] = useState(false);
	const [archiveOpen, setArchiveOpen] = useState(false);
	const [archivePassword, setArchivePassword] = useState("");
	const [deleteAfterArchive, setDeleteAfterArchive] = useState(false);
	const [cloudBackups, setCloudBackups] = useState<GameBackupArchiveRecord[]>([]);
	const [loadingCloudBackups, setLoadingCloudBackups] = useState(true);
	const { t } = useTranslation();
	const archiveSettings = useModStore((state) => state.gameArchiveSettings);
	const isSteamLaunch = selectedGame?.launch_type === "steam";
	const hasLocalPath = selectedGame?.localpath;
	const hasFolderPath = isSteamLaunch
		? Boolean(selectedGame?.steam_monitor_path)
		: Boolean(hasLocalPath || selectedGame?.custom_data?.extraLocalPaths?.some((path) => path?.trim()));
	const canSetAsCloudGame = !isSteamLaunch && Boolean(hasLocalPath?.trim());
	const hasLaunchPath = isSteamLaunch
		? Boolean(selectedGame?.steam_launch_id && selectedGame?.steam_monitor_path)
		: Boolean(
				hasLocalPath ||
					selectedGame?.custom_data?.extraLocalPaths?.some((path) => path?.trim()),
			);

	// 使用 Feature Facade 更新游戏状态
	const { updatePlayStatus } = useGameStatusActions();

	const isThisGameCanRun = hasLaunchPath && !isGameRunning(id);
	const hasCloudBackups = cloudBackups.length > 0;
	const hasDoubtfulCloudBackups = cloudBackups.some(
		(backup) => !backup.matchConfirmed,
	);
	const cloudBackupSecondary = loadingCloudBackups
		? t("components.RightMenu.loadingCloudBackups", "正在读取...")
		: !hasCloudBackups
			? t("components.RightMenu.noCloudBackups", "没有关联的网盘备份")
			: hasDoubtfulCloudBackups
				? t(
						"components.RightMenu.cloudBackupsWithDoubtful",
						"{{count}} 个备份，含待确认",
						{ count: cloudBackups.length },
					)
				: t("components.RightMenu.cloudBackupCount", "{{count}} 个备份", {
						count: cloudBackups.length,
					});
	const cloudBackupNames = useMemo(
		() => [...new Set(cloudBackups.map((backup) => backup.baseName))],
		[cloudBackups],
	);

	useEffect(() => {
		let cancelled = false;
		setLoadingCloudBackups(true);
		void backupCatalogService
			.listGameArchives(id)
			.then((records) => {
				if (!cancelled) setCloudBackups(records);
			})
			.catch((error) => {
				console.error("读取游戏网盘备份失败:", error);
				if (!cancelled) setCloudBackups([]);
			})
			.finally(() => {
				if (!cancelled) setLoadingCloudBackups(false);
			});
		return () => {
			cancelled = true;
		};
	}, [id]);

	/**
	 * 删除游戏操作，带删除确认弹窗
	 */
	const handleDeleteGame = async () => {
		try {
			setIsDeleting(true);
			onClose();
			await deleteGameMutation.mutateAsync(id);
			setSelectedGameId(null);
		} catch (error) {
			console.error("删除游戏失败:", error);
		} finally {
			onClose();
			setIsDeleting(false);
			setOpenAlert(false);
		}
	};

	/**
	 * 启动游戏操作
	 */
	const handleStartGame = async () => {
		try {
			if (!hasLaunchPath) {
				snackbar.error(
					t("components.LaunchModal.gamePathNotFound", "游戏路径未找到"),
				);
				return;
			}
			const result = await launchGame(id);
			if (!result.success) {
				snackbar.error(result.message);
			}
		} catch (error) {
			snackbar.error(
				`${t("components.LaunchModal.launchFailed", "游戏启动失败:")}: ${getUserErrorMessage(error, t)}`,
			);
		}
	};

	/**
	 * 更新游戏状态
	 */
	const handlePlayStatusChange = (newStatus: PlayStatus) => {
		updatePlayStatus(
			{ gameId: id, newStatus },
			{
				invalidateScope: "all",
			},
		);
		onClose();
	};

	const handleCopyCloudBackup = async (values: string[]) => {
		if (values.length === 0) return;
		try {
			await navigator.clipboard.writeText(values.join("\n"));
			snackbar.success(
				t("components.RightMenu.archiveNamesCopied", "已复制 {{count}} 个压缩包名", {
					count: values.length,
				}),
			);
		} catch {
			snackbar.error(t("components.RightMenu.cloudBackupCopyFailed", "复制网盘备份信息失败"));
		} finally {
			onClose();
		}
	};

	const handleSetAsCloudGame = async () => {
		if (!selectedGame?.localpath?.trim() || isSteamLaunch) return;

		const primaryPath = selectedGame.localpath;
		const extraLocalPaths = (selectedGame.custom_data?.extraLocalPaths ?? []).filter(
			(path): path is string => Boolean(path?.trim()),
		);
		const pathKey = (path: string) =>
			path.replaceAll("/", "\\").toLocaleLowerCase();
		const nextExtraLocalPaths = extraLocalPaths.some(
			(path) => pathKey(path) === pathKey(primaryPath),
		)
			? extraLocalPaths
			: [...extraLocalPaths, primaryPath];

		try {
			setIsSettingCloudGame(true);
			await updateGameMutation.mutateAsync({
				gameId: id,
				updates: {
					localpath: null,
					custom_data: {
						...selectedGame.custom_data,
						extraLocalPaths: nextExtraLocalPaths,
					},
				},
			});
			snackbar.success(t("components.RightMenu.setAsCloudGameSuccess", "已设为云端游戏"));
			onClose();
		} catch (error) {
			console.error("设为云端游戏失败:", error);
			snackbar.error(
				t("components.RightMenu.setAsCloudGameFailed", "设为云端游戏失败"),
			);
		} finally {
			setIsSettingCloudGame(false);
		}
	};

	const handleArchiveGame = async () => {
		if (!selectedGame?.localpath?.trim() || isSteamLaunch) return;
		if (archiveSettings.requirePassword && !archivePassword) {
			snackbar.warning(t("components.RightMenu.archivePasswordRequired", "请输入归档密码"));
			return;
		}
		const queuedGame = selectedGame;
		const queuedSettings = { ...archiveSettings };
		const queuedPassword = archivePassword;
		const queuedDelete = deleteAfterArchive;
		setArchiveOpen(false);
		setArchivePassword("");
		onClose();
		enqueueGameArchive(async () => {
			const taskStore = useGameArchiveTaskStore.getState();
			taskStore.start(queuedGame.id, queuedGame.name?.trim() || "未命名游戏");
			let archiveFinished = false;
			try {
				const result = await fileService.archiveGameDirectory({
					gameId: queuedGame.id,
					format: queuedSettings.format,
					compressionLevel: queuedSettings.compressionLevel,
					password: queuedPassword || undefined,
					encryptHeaders: queuedSettings.encryptHeaders,
					deleteSource: queuedDelete,
					deleteBehavior: queuedSettings.deleteBehavior,
				});
				archiveFinished = true;
				if (result.source_deleted) {
					const primaryPath = queuedGame.localpath!;
					const existingPaths = (queuedGame.custom_data?.extraLocalPaths ?? []).filter((path): path is string => Boolean(path?.trim()));
					const pathKey = (path: string) => path.replaceAll("/", "\\").toLocaleLowerCase();
					const extraLocalPaths = existingPaths.some((path) => pathKey(path) === pathKey(primaryPath)) ? existingPaths : [...existingPaths, primaryPath];
					await updateGameMutation.mutateAsync({ gameId: queuedGame.id, updates: { localpath: null, custom_data: { ...queuedGame.custom_data, extraLocalPaths } } });
				}
				taskStore.complete(result.archive_path, result.warning ?? (result.source_deleted ? t("components.RightMenu.archiveAndCloudSuccess", "已打包、校验并删除原目录，游戏已设为云端游戏") : t("components.RightMenu.archiveSuccess", "游戏目录已打包并校验完成")));
			} catch (error) {
				console.error("打包游戏目录失败:", error);
				const message = getUserErrorMessage(error, t, t("components.RightMenu.archiveFailed", "打包游戏目录失败"));
				if (archiveFinished) taskStore.complete("", `打包已完成，但游戏记录未能更新：${message}`);
				else taskStore.fail(message);
			}
		});
	};

	return (
		<BaseRightMenu
			isopen
			anchorPosition={anchorPosition}
			onClose={onClose}
			ariaLabel={t("components.RightMenu.label", "右键菜单")}
		>
			{/* 删除确认弹窗 */}
			<AlertConfirmBox
				open={openAlert}
				setOpen={setOpenAlert}
				onConfirm={handleDeleteGame}
				isLoading={isDeleting}
			/>
			<Dialog
				open={archiveOpen}
				onClose={() => setArchiveOpen(false)}
				maxWidth="xs"
				fullWidth
			>
				<DialogTitle>{t("components.RightMenu.archiveGame", "打包游戏")}</DialogTitle>
				<DialogContent>
					<ListItemText
						primary={t("components.RightMenu.archiveDestination", "压缩包会保存到游戏目录的同级位置")}
						secondary={`${archiveSettings.format.toUpperCase()} · ${t("components.RightMenu.archiveLevel", "压缩等级")} ${archiveSettings.compressionLevel}/9`}
						sx={{ mt: 0.5 }}
					/>
					{archiveSettings.requirePassword && (
						<TextField
							fullWidth
							size="small"
							label={t("components.RightMenu.archivePassword", "归档密码")}
							type="password"
							value={archivePassword}
							onChange={(event) => setArchivePassword(event.target.value)}
							autoComplete="new-password"
							sx={{ mt: 2 }}
						/>
					)}
					<FormControlLabel
						sx={{ mt: 1 }}
						control={<Checkbox checked={deleteAfterArchive} onChange={(event) => setDeleteAfterArchive(event.target.checked)} />}
						label={t("components.RightMenu.archiveDeleteSource", "校验成功后删除原游戏目录，并设为云端游戏")}
					/>
				</DialogContent>
				<DialogActions>
					<MenuItem onClick={() => setArchiveOpen(false)}>{t("common.cancel", "取消")}</MenuItem>
					<MenuItem disabled={archiveSettings.requirePassword && !archivePassword} onClick={() => void handleArchiveGame()}>
						{deleteAfterArchive ? t("components.RightMenu.archiveAndDelete", "打包并删除原目录") : t("components.RightMenu.archiveStart", "开始打包")}
					</MenuItem>
				</DialogActions>
			</Dialog>

			<MenuList sx={{ py: 1 }}>
				{/* 启动游戏 */}
				<MenuItem
					disabled={!isThisGameCanRun}
					onClick={() => {
						handleStartGame();
						onClose();
					}}
				>
					<ListItemIcon>
						<PlayCircleOutlineIcon />
					</ListItemIcon>
					<ListItemText
						primary={t("components.RightMenu.startGame", "启动游戏")}
					/>
				</MenuItem>

				{/* 进入详情 */}
				<LinkWithScrollSave
					to={`/libraries/${id}`}
					style={{ textDecoration: "none", color: "inherit" }}
				>
					<MenuItem onClick={onClose}>
						<ListItemIcon>
							<ArticleIcon />
						</ListItemIcon>
						<ListItemText
							primary={t("components.RightMenu.enterDetails", "进入详情页")}
						/>
					</MenuItem>
				</LinkWithScrollSave>

				{/* 删除游戏 */}
				<MenuItem onClick={() => setOpenAlert(true)}>
					<ListItemIcon>
						<DeleteIcon />
					</ListItemIcon>
					<ListItemText
						primary={t("components.RightMenu.deleteGame", "删除游戏")}
					/>
				</MenuItem>

				<Divider />

				{/* 打开游戏文件夹 */}
				<MenuItem
					disabled={!hasFolderPath}
					onClick={() => {
						if (selectedGame && hasFolderPath) {
							handleOpenFolder(selectedGame);
						}
						onClose();
					}}
				>
					<ListItemIcon>
						<FolderOpenIcon />
					</ListItemIcon>
					<ListItemText
						primary={t("components.RightMenu.openGameFolder", "打开游戏目录")}
					/>
				</MenuItem>

				{/* 游戏状态切换 - 二级菜单 */}
				<PlayStatusSubmenu
					currentStatus={selectedGame?.clear}
					onStatusChange={handlePlayStatusChange}
				/>

				<Divider />

				<MenuItem
					disabled={loadingCloudBackups || !hasCloudBackups}
					onClick={() => void handleCopyCloudBackup(cloudBackupNames)}
				>
					<ListItemIcon>
						<ContentCopyIcon />
					</ListItemIcon>
					<ListItemText
						primary={t("components.RightMenu.copyArchiveNames", "复制压缩包名")}
						sx={{
							mr: 1,
							"& .MuiListItemText-primary": { whiteSpace: "nowrap" },
						}}
					/>
					<Tooltip title={cloudBackupSecondary} placement="right">
						<Chip
							size="small"
							variant="outlined"
							color={hasDoubtfulCloudBackups ? "warning" : "default"}
							label={loadingCloudBackups ? "…" : cloudBackups.length}
							sx={{
								height: 22,
								minWidth: 28,
								"& .MuiChip-label": { px: 0.75 },
							}}
						/>
					</Tooltip>
				</MenuItem>

				<MenuItem
					disabled={!canSetAsCloudGame || isSettingCloudGame}
					onClick={() => void handleSetAsCloudGame()}
				>
					<ListItemIcon>
						<CloudOffOutlinedIcon />
					</ListItemIcon>
					<ListItemText
						primary={t("components.RightMenu.setAsCloudGame", "设为云端游戏")}
					/>
				</MenuItem>

				<MenuItem
					disabled={!canSetAsCloudGame}
					onClick={() => {
						setDeleteAfterArchive(false);
						setArchivePassword("");
						setArchiveOpen(true);
					}}
				>
					<ListItemIcon><ArchiveIcon /></ListItemIcon>
					<ListItemText primary={t("components.RightMenu.archiveGame", "打包游戏")} />
				</MenuItem>
			</MenuList>
		</BaseRightMenu>
	);
};

export default RightMenu;
