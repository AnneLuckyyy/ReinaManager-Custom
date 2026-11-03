import AddIcon from "@mui/icons-material/Add";
import CancelIcon from "@mui/icons-material/Cancel";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DownloadIcon from "@mui/icons-material/Download";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { open as chooseDirectory } from "@tauri-apps/plugin-dialog";
import {
	Alert,
	Box,
	Button,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	LinearProgress,
	MenuItem,
	Paper,
	Stack,
	Switch,
	TextField,
	Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { gameMetadataService } from "@/api";
import { useGameCategorySourceAssignment } from "@/hooks/features/games/useGameCategorySourceAssignment";
import { useAllSettings } from "@/hooks/queries/useSettings";
import { gameKeys } from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";
import {
	downloadTaskService,
	type DownloadArchiveInspection,
	type DownloadArchiveMoveResult,
	type DownloadArchiveStagingResult,
	type DownloadTask,
} from "@/services/invoke";
import type { BgmData } from "@/types";
import { withBgmAuth } from "@/utils/bgmAuthSession";
import { getUserErrorMessage } from "@/utils/errors";
import { useModStore } from "@/store/modStore";

const downloadTaskKey = ["download-tasks"] as const;

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
	return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function getStatusLabel(
	status: DownloadTask["status"],
	t: (key: string, fallback: string) => string,
): string {
	return {
		running: t("pages.DownloadTasks.status.running", "下载中"),
		paused: t("pages.DownloadTasks.status.paused", "已暂停"),
		completed: t("pages.DownloadTasks.status.completed", "已完成"),
		failed: t("pages.DownloadTasks.status.failed", "下载失败"),
		cancelled: t("pages.DownloadTasks.status.cancelled", "已取消"),
	}[status];
}

function isRecognizedArchive(fileName: string | null | undefined): boolean {
	if (!fileName) return false;
	const lower = fileName.toLowerCase();
	return [".7z", ".zip", ".rar", ".tar", ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"].some(
		(extension) => lower.endsWith(extension) || lower.includes(`${extension}.`),
	);
}

function getInstallStageLabel(task: DownloadTask): string | null {
	if (task.task_kind !== "shionlib_install") return null;
	return {
		downloading: "Shionlib：正在下载",
		extracting: "Shionlib：正在安全解压",
		organizing: "Shionlib：正在整理安装目录",
		scanning: "Shionlib：正在识别启动程序",
		matching_metadata: "Shionlib：正在核对现有资料",
		installed_pending_import: "Shionlib：已安装，等待下一阶段添加到游戏库",
		imported: "Shionlib：已添加到游戏库",
	}[task.install_stage ?? ""] ?? "Shionlib 安装任务";
}

function getInstallExecutableLabel(task: DownloadTask): string | null {
	if (task.task_kind !== "shionlib_install" || !task.install_result_json) return null;
	try {
		const result = JSON.parse(task.install_result_json) as {
			executable_candidates?: string[];
			selected_executable?: string | null;
		};
		if (result.selected_executable) return `识别的启动程序：${result.selected_executable}`;
		if (result.executable_candidates?.length) return `发现 ${result.executable_candidates.length} 个启动程序候选，等待后续选择`;
		return "未找到根目录直属的启动程序";
	} catch {
		return null;
	}
}

function getInstallExecutableCandidates(task: DownloadTask): string[] {
	if (task.task_kind !== "shionlib_install" || !task.install_result_json) return [];
	try {
		const result = JSON.parse(task.install_result_json) as {
			executable_candidates?: string[];
			selected_executable?: string | null;
		};
		const candidates = result.executable_candidates ?? [];
		if (result.selected_executable && !candidates.includes(result.selected_executable)) {
			return [result.selected_executable, ...candidates];
		}
		return candidates;
	} catch {
		return [];
	}
}

function getShionlibBgmId(task: DownloadTask): string | null {
	if (task.task_kind !== "shionlib_install" || !task.metadata_json) return null;
	try {
		const metadata = JSON.parse(task.metadata_json) as { bgm_id?: string | null };
		const bgmId = metadata.bgm_id?.trim();
		return bgmId || null;
	} catch {
		return null;
	}
}

function isShionlibMatchedExistingGame(task: DownloadTask): boolean {
	if (task.task_kind !== "shionlib_install" || !task.install_result_json) return false;
	try {
		const result = JSON.parse(task.install_result_json) as {
			metadata_match?: { state?: string };
		};
		return result.metadata_match?.state === "matched_existing";
	} catch {
		return false;
	}
}

function getInstallMetadataMatchLabel(task: DownloadTask): string | null {
	if (task.task_kind !== "shionlib_install" || !task.install_result_json) return null;
	try {
		const result = JSON.parse(task.install_result_json) as {
			metadata_match?: {
				state?: string;
				game_id?: number | null;
				matched_by?: string | null;
				note?: string | null;
			};
		};
		const match = result.metadata_match;
		if (!match) return null;
		if (match.state === "matched_existing" && match.game_id) {
			return `可关联现有未安装资料：游戏 #${match.game_id}${match.matched_by ? `（${match.matched_by}）` : ""}`;
		}
		return match.note ?? null;
	} catch {
		return null;
	}
}

export function DownloadTasksPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: settings } = useAllSettings();
	const automationDefaults = useModStore((state) => state.downloadTaskAutomationDefaults);
	const { assignImportedGames } = useGameCategorySourceAssignment();
	const [createOpen, setCreateOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [url, setUrl] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<DownloadTask | null>(null);
	const [restartTarget, setRestartTarget] = useState<DownloadTask | null>(null);
	const [inspectionTarget, setInspectionTarget] = useState<DownloadTask | null>(null);
	const [archiveInspection, setArchiveInspection] = useState<DownloadArchiveInspection | null>(null);
	const [archivePassword, setArchivePassword] = useState("");
	const [archiveStagingResult, setArchiveStagingResult] = useState<DownloadArchiveStagingResult | null>(null);
	const [stagingCleanupTarget, setStagingCleanupTarget] = useState<DownloadTask | null>(null);
	const [stagingMoveTarget, setStagingMoveTarget] = useState<DownloadTask | null>(null);
	const [moveTargetParent, setMoveTargetParent] = useState("");
	const [moveTargetFolderName, setMoveTargetFolderName] = useState("");
	const [gameRegistrationTarget, setGameRegistrationTarget] = useState<{
		task: DownloadTask;
		targetDirectory: string;
	} | null>(null);
	const [gameExecutablePath, setGameExecutablePath] = useState("");
	const [gameRegistrationTitle, setGameRegistrationTitle] = useState("");
	const [shionlibImportTarget, setShionlibImportTarget] = useState<DownloadTask | null>(null);
	const [shionlibImportExecutable, setShionlibImportExecutable] = useState("");
	const [shionlibImportTitle, setShionlibImportTitle] = useState("");

	const tasksQuery = useQuery({
		queryKey: downloadTaskKey,
		queryFn: () => downloadTaskService.listTasks(),
		refetchInterval: (query) =>
			(query.state.data ?? []).some((task) => task.status === "running")
				? 1500
				: false,
	});
	const tasks = tasksQuery.data ?? [];
	const sourceHost = useMemo(() => {
		try {
			return new URL(url.trim()).host;
		} catch {
			return "无效地址";
		}
	}, [url]);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: downloadTaskKey });

	const createMutation = useMutation({
		mutationFn: () => downloadTaskService.createTask({ title, url }),
		onSuccess: (task) => {
			if (automationDefaults.autoImport || automationDefaults.autoDelete) {
				void downloadTaskService.updateTaskAutomation(task.id, automationDefaults.autoImport, automationDefaults.autoDelete).then(() => refresh());
			}
			setConfirmOpen(false);
			setCreateOpen(false);
			setTitle("");
			setUrl("");
			void refresh();
			snackbar.success("下载任务已创建");
		},
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});
	const actionMutation = useMutation({
		mutationFn: async (input: { task: DownloadTask; action: "resume" | "restart" | "pause" | "cancel" | "delete" }) => {
			if (input.action === "resume") return downloadTaskService.resumeTask(input.task.id);
			if (input.action === "restart") return downloadTaskService.restartTask(input.task.id);
			if (input.action === "pause") return downloadTaskService.pauseTask(input.task.id);
			if (input.action === "cancel") return downloadTaskService.cancelTask(input.task.id);
			await downloadTaskService.deleteTask(input.task.id);
			return null;
		},
		onSuccess: () => void refresh(),
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});
	const automationMutation = useMutation({
		mutationFn: (input: { task: DownloadTask; autoImport: boolean; autoDelete: boolean }) =>
			downloadTaskService.updateTaskAutomation(input.task.id, input.autoImport, input.autoDelete),
		onSuccess: () => void refresh(),
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});
	const archiveInspectionMutation = useMutation({
		mutationFn: (taskId: number) => downloadTaskService.inspectCompletedArchive(taskId),
		onSuccess: (inspection) => setArchiveInspection(inspection),
		onError: (error) => {
			setInspectionTarget(null);
			snackbar.error(getUserErrorMessage(error, t));
		},
	});
	const archiveExtractMutation = useMutation({
		mutationFn: (data: { taskId: number; password?: string }) => downloadTaskService.extractCompletedArchive(data),
		onSuccess: (result) => {
			setArchiveStagingResult(result);
			setArchiveInspection((current) => current ? { ...current, has_staging: true } : current);
			snackbar.success("已安全解压到任务专属临时区；尚未移动或导入游戏");
		},
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});
	const archiveStagingMoveMutation = useMutation({
		mutationFn: (data: {
			taskId: number;
			targetParent: string;
			targetFolderName: string;
		}) => downloadTaskService.moveCompletedArchiveStaging(data),
		onSuccess: (result: DownloadArchiveMoveResult) => {
			const task = stagingMoveTarget;
			setStagingMoveTarget(null);
			setArchiveStagingResult(null);
			setArchiveInspection((current) => current ? {
				...current,
				has_staging: result.source_staging_retained,
			} : current);
			if (result.source_staging_retained) {
				snackbar.warning(`已发布到“${result.target_folder_name}”；原临时区仍保留，请确认后单独清理`);
			} else {
				snackbar.success(`已移动 ${result.file_count} 个文件到“${result.target_folder_name}”；可按需手动创建游戏记录`);
			}
			if (task) {
				setGameRegistrationTarget({ task, targetDirectory: result.target_path });
				setGameExecutablePath("");
				setGameRegistrationTitle(result.target_folder_name);
			}
		},
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});
	const movedGameRegistrationMutation = useMutation({
		mutationFn: (data: {
			taskId: number;
			targetDirectory: string;
			executablePath: string;
			title: string;
		}) => downloadTaskService.registerMovedGame(data),
		onSuccess: async (result, variables) => {
			setGameRegistrationTarget(null);
			const assignment = await assignImportedGames([{
				gameId: result.game_id,
				path: variables.executablePath,
			}]);
			await queryClient.invalidateQueries({ queryKey: gameKeys.all, exact: true });
			await queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
			await queryClient.invalidateQueries({ queryKey: ["collections"] });
			if (assignment.failed) snackbar.warning("游戏已创建，但收藏夹分类自动归属未完成");
			else snackbar.success(assignment.assigned ? "已创建游戏记录并加入来源分类；不会自动启动游戏" : "已创建本地游戏记录；不会自动启动游戏");
		},
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});
	const shionlibImportMutation = useMutation({
		mutationFn: async (data: {
			task: DownloadTask;
			executableName: string;
			title: string;
		}) => {
			const bgmId = getShionlibBgmId(data.task);
			let bgmData: BgmData | undefined;
			if (bgmId && !isShionlibMatchedExistingGame(data.task)) {
				const metadata = await withBgmAuth(
					(token) => gameMetadataService.getGameById(bgmId, "bgm", token),
					{ required: true },
				);
				if (metadata.bgm_id !== bgmId || !metadata.bgm_data) {
					throw new Error("Bangumi 返回的资料与 Shionlib 请求标识不一致");
				}
				bgmData = metadata.bgm_data;
			}
			return downloadTaskService.importShionlibInstalledGame({
				taskId: data.task.id,
				executableName: data.executableName,
				title: data.title,
				bgmId: bgmData ? bgmId ?? undefined : undefined,
				bgmData,
			});
		},
		onSuccess: async (result) => {
			setShionlibImportTarget(null);
			const assignment = await assignImportedGames([{
				gameId: result.game_id,
				path: result.executable_path,
			}]);
			await queryClient.invalidateQueries({ queryKey: gameKeys.all, exact: true });
			await queryClient.invalidateQueries({ queryKey: gameKeys.idLists() });
			await queryClient.invalidateQueries({ queryKey: ["collections"] });
			await refresh();
			if (assignment.failed) snackbar.warning("游戏已入库，但收藏夹分类自动归属未完成");
			else if (assignment.assigned) snackbar.success(result.created_new_game ? "已创建游戏记录并加入来源分类；不会自动启动游戏" : "已关联现有游戏资料并加入来源分类；不会自动启动游戏");
			else snackbar.success(result.created_new_game ? "已创建游戏记录；不会自动启动游戏" : "已关联现有游戏资料；不会自动启动游戏");
		},
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});
	const archiveStagingCleanupMutation = useMutation({
		mutationFn: (taskId: number) => downloadTaskService.discardCompletedArchiveStaging(taskId),
		onSuccess: () => {
			setStagingCleanupTarget(null);
			setArchiveStagingResult(null);
			setArchiveInspection((current) => current ? { ...current, has_staging: false } : current);
			snackbar.success("已清理该任务的临时解压区；原压缩包和下载任务仍保留");
		},
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});

	const openCreate = () => {
		if (!settings?.download_root_path) {
			snackbar.warning("请先在路径管理中设置游戏下载目录");
			navigate("/settings");
			return;
		}
		setCreateOpen(true);
	};
	const requestCreate = () => {
		if (!title.trim() || !url.trim()) {
			snackbar.warning("请填写任务名称和 HTTPS 下载地址");
			return;
		}
		setConfirmOpen(true);
	};
	const openShionlib = () => {
		void openUrl("https://shionlib.com/").catch((error) =>
			snackbar.error(getUserErrorMessage(error, t)),
		);
	};
	const openArchiveInspection = (task: DownloadTask) => {
		setInspectionTarget(task);
		setArchiveInspection(null);
		setArchivePassword("");
		setArchiveStagingResult(null);
		archiveInspectionMutation.mutate(task.id);
	};
	const chooseMoveTargetParent = async () => {
		try {
			const selected = await chooseDirectory({ multiple: false, directory: true });
			if (selected && !Array.isArray(selected)) setMoveTargetParent(selected);
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	};
	const openStagingMove = (task: DownloadTask) => {
		setStagingMoveTarget(task);
		setMoveTargetParent("");
		setMoveTargetFolderName(task.title);
	};
	const openShionlibImport = (task: DownloadTask) => {
		const candidates = getInstallExecutableCandidates(task);
		if (!candidates.length) {
			snackbar.warning("未找到可安全使用的启动程序，不能自动添加游戏");
			return;
		}
		setShionlibImportTarget(task);
		setShionlibImportExecutable(candidates[0]);
		setShionlibImportTitle(task.title);
	};
	const chooseGameExecutable = async () => {
		if (!gameRegistrationTarget) return;
		try {
			const selected = await chooseDirectory({
				multiple: false,
				directory: false,
				defaultPath: gameRegistrationTarget.targetDirectory,
				filters: [{ name: "Windows Executable", extensions: ["exe"] }],
			});
			if (selected && !Array.isArray(selected)) setGameExecutablePath(selected);
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		}
	};

	return (
		<Box className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 md:p-7">
			<Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
				<Box>
					<Typography variant="h5" fontWeight={700}>下载任务</Typography>
					<Typography variant="body2" color="text.secondary">
						普通下载只保留文件；确认 Shionlib 资源后会下载、解压并整理到游戏安装目录。
					</Typography>
				</Box>
				<Stack direction="row" spacing={1} flexWrap="wrap" justifyContent="flex-end">
					<Button variant="outlined" onClick={openShionlib}>
						前往 Shionlib
					</Button>
					<Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
						新建下载
					</Button>
				</Stack>
			</Stack>

			<Alert severity="info">
				仅接受 HTTPS 地址。创建前会读取文件大小；暂停、失败和取消均会保留断点文件，只有删除任务才会删除对应下载文件。Shionlib 资源会在你确认后自动下载、解压和整理，不会自动执行其中程序或创建游戏记录。
			</Alert>

			{tasksQuery.isPending ? (
				<Box className="flex justify-center py-12"><CircularProgress /></Box>
			) : tasks.length === 0 ? (
				<Paper variant="outlined" className="flex flex-col items-center gap-3 rounded-xl py-14">
					<DownloadIcon color="disabled" sx={{ fontSize: 52 }} />
					<Typography fontWeight={700}>暂无下载任务</Typography>
					<Button variant="outlined" onClick={openCreate}>创建第一个任务</Button>
				</Paper>
			) : (
				<Stack spacing={1.5}>
					{tasks.map((task) => {
						const percentage = Math.min(100, Math.max(0, (task.progress_current / task.progress_total) * 100));
						const busy = actionMutation.isPending && actionMutation.variables?.task.id === task.id;
						const installStageLabel = getInstallStageLabel(task);
						const installExecutableLabel = getInstallExecutableLabel(task);
						const installMetadataMatchLabel = getInstallMetadataMatchLabel(task);
						const installExecutableCandidates = getInstallExecutableCandidates(task);
						return (
							<Paper key={task.id} variant="outlined" className="rounded-xl p-4">
								<Stack spacing={1.25}>
									<Stack direction="row" justifyContent="space-between" gap={2} alignItems="flex-start">
										<Box className="min-w-0">
											<Typography fontWeight={700} noWrap>{task.title}</Typography>
							<Typography variant="caption" color="text.secondary" noWrap display="block">{getStatusLabel(task.status, t)} · {task.root_path}</Typography>
										</Box>
										<Typography variant="body2" color={task.status === "failed" ? "error" : "text.secondary"}>{Math.round(percentage)}%</Typography>
									</Stack>
									<LinearProgress variant="determinate" value={percentage} color={task.status === "failed" ? "error" : "primary"} />
									<Typography variant="caption" color="text.secondary">{formatBytes(task.progress_current)} / {formatBytes(task.progress_total)}</Typography>
									{installStageLabel ? <Typography variant="caption" color="text.secondary">{installStageLabel}</Typography> : null}
									{installExecutableLabel ? <Typography variant="caption" color="text.secondary">{installExecutableLabel}</Typography> : null}
									{installMetadataMatchLabel ? <Typography variant="caption" color="text.secondary">{installMetadataMatchLabel}</Typography> : null}
									{task.file_name ? <Typography variant="caption" color="text.secondary">保存为：{task.file_name}</Typography> : <Typography variant="caption" color="text.secondary">旧任务将保留原有临时文件名</Typography>}
									<Typography variant="caption" color="text.secondary">{task.checksum_algorithm ? `来源校验：${task.checksum_algorithm.toUpperCase()}` : "来源未提供可验证的校验值"}</Typography>
									{task.error_message ? <Alert severity="error">{task.error_message}</Alert> : null}
									<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
										<Stack direction="row" spacing={0.25} alignItems="center">
											<Switch size="small" checked={task.auto_import} disabled={automationMutation.isPending} onChange={(event) => automationMutation.mutate({ task, autoImport: event.target.checked, autoDelete: event.target.checked ? task.auto_delete : false })} />
											<Typography variant="body2">自动入库</Typography>
										</Stack>
										<Stack direction="row" spacing={0.25} alignItems="center" title="仅在自动入库成功后，按现有删除任务流程清理该任务文件">
											<Switch size="small" checked={task.auto_delete} disabled={!task.auto_import || automationMutation.isPending} onChange={(event) => automationMutation.mutate({ task, autoImport: true, autoDelete: event.target.checked })} />
											<Typography variant="body2" color={task.auto_import ? "text.primary" : "text.disabled"}>自动删除</Typography>
										</Stack>
									</Stack>
									<Stack direction="row" spacing={1} flexWrap="wrap">
										{task.status === "running" && (task.task_kind === "download" || task.install_stage === "downloading") ? <Button size="small" startIcon={<PauseIcon />} disabled={busy} onClick={() => actionMutation.mutate({ task, action: "pause" })}>暂停</Button> : null}
										{task.status === "running" && (task.task_kind === "download" || task.install_stage === "downloading") ? <Button size="small" color="warning" startIcon={<CancelIcon />} disabled={busy} onClick={() => actionMutation.mutate({ task, action: "cancel" })}>取消</Button> : null}
										{task.status === "failed" && (task.error_message?.startsWith("来源校验失败：") || task.error_message?.startsWith("来源文件已变化：")) ? <Button size="small" color="warning" startIcon={<PlayArrowIcon />} disabled={busy} onClick={() => setRestartTarget(task)}>重新下载</Button> : null}
										{task.status !== "running" && task.status !== "completed" && !(task.status === "failed" && (task.error_message?.startsWith("来源校验失败：") || task.error_message?.startsWith("来源文件已变化："))) ? <Button size="small" startIcon={<PlayArrowIcon />} disabled={busy} onClick={() => actionMutation.mutate({ task, action: "resume" })}>继续</Button> : null}
										{task.task_kind === "download" && task.status === "completed" && isRecognizedArchive(task.file_name) ? <Button size="small" disabled={archiveInspectionMutation.isPending} onClick={() => openArchiveInspection(task)}>检查压缩包</Button> : null}
										{task.task_kind === "shionlib_install" && task.status === "completed" && task.install_stage === "installed_pending_import" && installExecutableCandidates.length ? <Button size="small" variant="contained" disabled={shionlibImportMutation.isPending} onClick={() => openShionlibImport(task)}>添加到游戏库</Button> : null}
										{task.status !== "running" ? <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} disabled={busy} onClick={() => setDeleteTarget(task)}>删除任务</Button> : null}
									</Stack>
								</Stack>
							</Paper>
						);
					})}
				</Stack>
			)}

			<Dialog open={createOpen} onClose={createMutation.isPending ? undefined : () => setCreateOpen(false)} fullWidth maxWidth="sm">
				<DialogTitle>新建下载任务</DialogTitle>
				<DialogContent><Stack spacing={2} className="pt-2"><TextField autoFocus label="任务名称" value={title} onChange={(event) => setTitle(event.target.value)} /><TextField label="HTTPS 下载地址" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/game.7z" /><Typography variant="caption" color="text.secondary">任务只下载文件；本阶段不会自动解压、安装或执行其中的内容。</Typography></Stack></DialogContent>
				<DialogActions><Button onClick={() => setCreateOpen(false)}>取消</Button><Button variant="contained" onClick={requestCreate}>继续</Button></DialogActions>
			</Dialog>

			<Dialog open={confirmOpen} onClose={createMutation.isPending ? undefined : () => setConfirmOpen(false)} fullWidth maxWidth="sm">
				<DialogTitle>确认创建下载任务</DialogTitle>
				<DialogContent><Stack spacing={1.5}><Alert severity="warning">只在你信任该来源和地址时继续。下载服务器可能跳转到其文件存储服务。</Alert><Typography>名称：{title}</Typography><Typography>来源主机：{sourceHost}</Typography><Typography>目标目录：{settings?.download_root_path}</Typography><Typography variant="body2" color="text.secondary">应用会先读取文件大小；无法验证大小的地址不会创建任务。</Typography></Stack></DialogContent>
				<DialogActions><Button onClick={() => setConfirmOpen(false)} disabled={createMutation.isPending}>返回</Button><Button variant="contained" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>{createMutation.isPending ? "创建中…" : "确认下载"}</Button></DialogActions>
			</Dialog>

			<Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
				<DialogTitle>删除下载任务？</DialogTitle>
				<DialogContent><Alert severity="warning">{deleteTarget?.task_kind === "shionlib_install" ? "这会删除该任务在游戏下载目录内的临时或已下载安装包；已经整理到游戏安装目录的文件夹不会删除，游戏库、115 备份和其它文件也不会受影响。" : "这会删除该任务在游戏下载目录内的临时或已下载文件。游戏库、115 备份和其它文件不会受影响。"}</Alert></DialogContent>
				<DialogActions><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button color="error" variant="contained" onClick={() => { if (deleteTarget) actionMutation.mutate({ task: deleteTarget, action: "delete" }); setDeleteTarget(null); }}>删除</Button></DialogActions>
			</Dialog>

			<Dialog open={Boolean(restartTarget)} onClose={() => setRestartTarget(null)} fullWidth maxWidth="xs">
				<DialogTitle>重新下载文件？</DialogTitle>
				<DialogContent><Alert severity="warning">{restartTarget?.error_message?.startsWith("来源文件已变化：") ? "来源文件已改变。重新下载会删除该任务自己的临时下载文件并从头下载；不会删除任何已完成文件、游戏或其它目录内容。" : "来源校验失败。重新下载会删除该任务自己的临时下载文件并从头下载；不会删除任何已完成文件、游戏或其它目录内容。"}</Alert></DialogContent>
				<DialogActions><Button onClick={() => setRestartTarget(null)}>取消</Button><Button color="warning" variant="contained" onClick={() => { if (restartTarget) actionMutation.mutate({ task: restartTarget, action: "restart" }); setRestartTarget(null); }}>重新下载</Button></DialogActions>
			</Dialog>

			<Dialog open={Boolean(inspectionTarget)} onClose={archiveInspectionMutation.isPending || archiveExtractMutation.isPending ? undefined : () => setInspectionTarget(null)} fullWidth maxWidth="xs">
				<DialogTitle>压缩包安全检查</DialogTitle>
				<DialogContent>
					{archiveInspectionMutation.isPending ? <Box className="flex justify-center py-6"><CircularProgress size={28} /></Box> : archiveInspection ? <Stack spacing={1.25}>
						<Alert severity={archiveInspection.readable ? "info" : "warning"}>{archiveInspection.note}</Alert>
						<Typography>格式：{archiveInspection.archive_format.toUpperCase()}</Typography>
						<Typography>分卷：{archiveInspection.is_multipart ? `检测到第 ${archiveInspection.part_index} 卷；本阶段不会组合或处理其它分卷。` : "未检测到分卷命名。"}</Typography>
						<Typography>密码：{archiveInspection.password_status === "required" ? "需要密码；本阶段不会索取或保存密码。" : archiveInspection.password_status === "not_required" ? "未检测到密码保护。" : "当前无法判断。"}</Typography>
						{archiveInspection.entry_count !== null && archiveInspection.entry_count !== undefined ? <Typography>目录条目：{archiveInspection.entry_count}</Typography> : null}
						{archiveInspection.unpacked_size !== null && archiveInspection.unpacked_size !== undefined ? <Typography>预计解压空间：至少 {formatBytes(archiveInspection.unpacked_size)}</Typography> : null}
						{archiveInspection.archive_format === "7z" && !archiveInspection.is_multipart ? <TextField size="small" type="password" label="压缩包密码（如需要）" value={archivePassword} onChange={(event) => setArchivePassword(event.target.value)} helperText="仅用于本次解压，不保存。" /> : null}
						{archiveStagingResult ? <Alert severity="success">已创建临时区：{archiveStagingResult.staging_name}，共 {archiveStagingResult.entry_count} 项、{formatBytes(archiveStagingResult.unpacked_size)}。此阶段尚未移动或导入。</Alert> : null}
						{archiveInspection.has_staging && !archiveStagingResult ? <Alert severity="info">此任务已有临时解压区；可确认清理，或保留给后续的手动移动步骤。</Alert> : null}
						<Typography variant="caption" color="text.secondary">检查本身只读取目录信息；后续解压或移动均须你在此窗口再次确认，不会自动安装、执行或添加游戏。</Typography>
					</Stack> : null}
				</DialogContent>
				<DialogActions>{(archiveStagingResult || archiveInspection?.has_staging) && inspectionTarget ? <Button variant="contained" onClick={() => openStagingMove(inspectionTarget)}>移动到游戏目录</Button> : null}{(archiveStagingResult || archiveInspection?.has_staging) && inspectionTarget ? <Button color="warning" onClick={() => setStagingCleanupTarget(inspectionTarget)}>清理临时区</Button> : null}{archiveInspection?.archive_format === "7z" && !archiveInspection.is_multipart && !archiveStagingResult && !archiveInspection.has_staging ? <Button variant="contained" disabled={archiveInspectionMutation.isPending || archiveExtractMutation.isPending || !inspectionTarget} onClick={() => { if (inspectionTarget) archiveExtractMutation.mutate({ taskId: inspectionTarget.id, password: archivePassword || undefined }); }}>{archiveExtractMutation.isPending ? "安全解压中…" : "解压到临时区"}</Button> : null}<Button onClick={() => setInspectionTarget(null)} disabled={archiveInspectionMutation.isPending || archiveExtractMutation.isPending}>关闭</Button></DialogActions>
			</Dialog>

			<Dialog open={Boolean(stagingMoveTarget)} onClose={archiveStagingMoveMutation.isPending ? undefined : () => setStagingMoveTarget(null)} fullWidth maxWidth="sm">
				<DialogTitle>移动到新的游戏目录</DialogTitle>
				<DialogContent><Stack spacing={1.5} className="pt-2">
					<Alert severity="warning">只会移动本任务的临时解压区。目标游戏文件夹必须不存在，应用不会覆盖其中任何文件，也不会自动导入、扫描或启动游戏。</Alert>
					<TextField label="目标父目录" value={moveTargetParent} InputProps={{ readOnly: true }} placeholder="请选择保存游戏文件夹的位置" />
					<Button variant="outlined" startIcon={<FolderOpenIcon />} onClick={chooseMoveTargetParent} disabled={archiveStagingMoveMutation.isPending}>选择目标父目录</Button>
					<TextField label="新游戏文件夹名" value={moveTargetFolderName} onChange={(event) => setMoveTargetFolderName(event.target.value)} helperText="将在目标父目录中新建该文件夹；名称不能包含路径或危险字符。" />
					<Typography variant="caption" color="text.secondary">同盘会直接移动；跨盘会先完整复制到目标盘临时区、发布成功后才清理原临时区。若原临时区清理失败，会保留并提示你手动确认清理。</Typography>
				</Stack></DialogContent>
				<DialogActions><Button onClick={() => setStagingMoveTarget(null)} disabled={archiveStagingMoveMutation.isPending}>取消</Button><Button variant="contained" disabled={archiveStagingMoveMutation.isPending || !moveTargetParent || !moveTargetFolderName.trim() || !stagingMoveTarget} onClick={() => { if (stagingMoveTarget) archiveStagingMoveMutation.mutate({ taskId: stagingMoveTarget.id, targetParent: moveTargetParent, targetFolderName: moveTargetFolderName }); }}>{archiveStagingMoveMutation.isPending ? "移动中…" : "确认移动"}</Button></DialogActions>
			</Dialog>

			<Dialog open={Boolean(gameRegistrationTarget)} onClose={movedGameRegistrationMutation.isPending ? undefined : () => setGameRegistrationTarget(null)} fullWidth maxWidth="sm">
				<DialogTitle>手动添加为游戏</DialogTitle>
				<DialogContent><Stack spacing={1.5} className="pt-2">
					<Alert severity="warning">请确认后再创建游戏记录。应用只会登记你选中的启动程序，不会扫描其它文件、自动寻找程序、启动游戏或修改已有游戏。</Alert>
					<TextField label="已移动的游戏目录" value={gameRegistrationTarget?.targetDirectory ?? ""} InputProps={{ readOnly: true }} />
					<TextField label="游戏名称" value={gameRegistrationTitle} onChange={(event) => setGameRegistrationTitle(event.target.value)} helperText="默认使用新文件夹名；可按需要修改。" />
					<TextField label="启动程序" value={gameExecutablePath} InputProps={{ readOnly: true }} placeholder="请选择该游戏目录内的 .exe 文件" />
					<Button variant="outlined" startIcon={<FolderOpenIcon />} onClick={chooseGameExecutable} disabled={movedGameRegistrationMutation.isPending}>选择启动程序</Button>
					<Typography variant="caption" color="text.secondary">提交前会验证所选文件是该游戏目录内的普通 .exe，并检查它是否已属于现有游戏。重复时不会创建新记录。</Typography>
				</Stack></DialogContent>
				<DialogActions><Button onClick={() => setGameRegistrationTarget(null)} disabled={movedGameRegistrationMutation.isPending}>暂不添加</Button><Button variant="contained" disabled={movedGameRegistrationMutation.isPending || !gameRegistrationTarget || !gameExecutablePath || !gameRegistrationTitle.trim()} onClick={() => { if (gameRegistrationTarget) movedGameRegistrationMutation.mutate({ taskId: gameRegistrationTarget.task.id, targetDirectory: gameRegistrationTarget.targetDirectory, executablePath: gameExecutablePath, title: gameRegistrationTitle }); }}>{movedGameRegistrationMutation.isPending ? "创建中…" : "创建游戏记录"}</Button></DialogActions>
			</Dialog>

			<Dialog open={Boolean(shionlibImportTarget)} onClose={shionlibImportMutation.isPending ? undefined : () => setShionlibImportTarget(null)} fullWidth maxWidth="sm">
				<DialogTitle>添加 Shionlib 游戏到库</DialogTitle>
				<DialogContent><Stack spacing={1.5} className="pt-2">
					<Alert severity="warning">这一步会写入游戏库，但不会启动游戏。只有已核对的唯一未安装资料才会关联现有记录；未匹配时才创建新记录。已有本地路径、资料冲突或多条命中的任务不会自动改写。</Alert>
					<TextField label="游戏名称" value={shionlibImportTitle} onChange={(event) => setShionlibImportTitle(event.target.value)} helperText="仅在需要创建新记录时使用；关联现有资料不会改名。" />
					{(shionlibImportTarget ? getInstallExecutableCandidates(shionlibImportTarget) : []).length > 1 ? <TextField select label="启动程序" value={shionlibImportExecutable} onChange={(event) => setShionlibImportExecutable(event.target.value)} helperText="安装目录有多个候选，请手动选择。">{(shionlibImportTarget ? getInstallExecutableCandidates(shionlibImportTarget) : []).map((candidate) => <MenuItem key={candidate} value={candidate}>{candidate}</MenuItem>)}</TextField> : <TextField label="启动程序" value={shionlibImportExecutable} InputProps={{ readOnly: true }} helperText="已识别唯一安全候选；提交时会再次核对。" />}
					<Typography variant="caption" color="text.secondary">提交会在同一事务中写入游戏和任务结果；任一步失败都会整体撤销。新路径会同时保留为初始备用路径，已有的人工备份匹配名不会被覆盖。</Typography>
				</Stack></DialogContent>
				<DialogActions><Button onClick={() => setShionlibImportTarget(null)} disabled={shionlibImportMutation.isPending}>暂不添加</Button><Button variant="contained" disabled={shionlibImportMutation.isPending || !shionlibImportTarget || !shionlibImportExecutable || !shionlibImportTitle.trim()} onClick={() => { if (shionlibImportTarget) shionlibImportMutation.mutate({ task: shionlibImportTarget, executableName: shionlibImportExecutable, title: shionlibImportTitle }); }}>{shionlibImportMutation.isPending ? "添加中…" : "确认添加"}</Button></DialogActions>
			</Dialog>

			<Dialog open={Boolean(stagingCleanupTarget)} onClose={archiveStagingCleanupMutation.isPending ? undefined : () => setStagingCleanupTarget(null)} fullWidth maxWidth="xs">
				<DialogTitle>清理临时解压区？</DialogTitle>
				<DialogContent><Alert severity="warning">这会删除该下载任务专属临时区内的解压文件。原压缩包、下载任务、游戏库和其它文件不会受影响。</Alert></DialogContent>
				<DialogActions><Button onClick={() => setStagingCleanupTarget(null)} disabled={archiveStagingCleanupMutation.isPending}>取消</Button><Button color="warning" variant="contained" disabled={archiveStagingCleanupMutation.isPending} onClick={() => { if (stagingCleanupTarget) archiveStagingCleanupMutation.mutate(stagingCleanupTarget.id); }}>{archiveStagingCleanupMutation.isPending ? "清理中…" : "确认清理"}</Button></DialogActions>
			</Dialog>
		</Box>
	);
}
