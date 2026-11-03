import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import ManageSearchIcon from "@mui/icons-material/ManageSearch";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
	Alert,
	Box,
	Button,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	InputLabel,
	Paper,
	Stack,
	TextField,
	Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { basename } from "pathe";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { backupCatalogKeys } from "@/hooks/queries/useBackupCatalog";
import { snackbar } from "@/providers/snackBar";
import { SettingsHelp } from "@/components/SettingsHelp";
import {
	backupCatalogService,
	type BackupCatalogPreview,
	type BackupCatalogSourceSummary,
} from "@/services/invoke";
import { getUserErrorMessage } from "@/utils/errors";
import { BackupMatchingDialog } from "./BackupMatchingDialog";

type ImportTarget = BackupCatalogSourceSummary | null;

export const BackupCatalogSettings = () => {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [sources, setSources] = useState<BackupCatalogSourceSummary[]>([]);
	const [loadingSources, setLoadingSources] = useState(true);
	const [previewing, setPreviewing] = useState(false);
	const [importing, setImporting] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [filePath, setFilePath] = useState("");
	const [sourceName, setSourceName] = useState("");
	const [preview, setPreview] = useState<BackupCatalogPreview | null>(null);
	const [importTarget, setImportTarget] = useState<ImportTarget>(null);
	const [deleteTarget, setDeleteTarget] = useState<BackupCatalogSourceSummary | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [matchingOpen, setMatchingOpen] = useState(false);

	const loadSources = useCallback(async () => {
		setLoadingSources(true);
		try {
			setSources(await backupCatalogService.listSources());
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Settings.backupCatalog.loadFailed", "读取备份目录来源失败"),
				),
			);
		} finally {
			setLoadingSources(false);
		}
	}, [t]);

	useEffect(() => {
		void loadSources();
	}, [loadSources]);

	const handleChooseTree = async (target: ImportTarget) => {
		const selected = await open({
			filters: [{ name: "115 Directory Tree", extensions: ["txt"] }],
			multiple: false,
			directory: false,
		});
		if (!selected || Array.isArray(selected)) return;

		setImportTarget(target);
		setFilePath(selected);
		setPreview(null);
		setSourceName(target?.name ?? basename(selected).replace(/\.txt$/i, ""));
		setDialogOpen(true);
		setPreviewing(true);
		try {
			const result = await backupCatalogService.preview(selected);
			setPreview(result);
			if (!target) setSourceName(result.suggestedSourceName);
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Settings.backupCatalog.previewFailed", "目录树解析失败"),
				),
			);
			setDialogOpen(false);
		} finally {
			setPreviewing(false);
		}
	};

	const handleImport = async () => {
		if (!preview || !sourceName.trim()) return;
		setImporting(true);
		try {
			const result = await backupCatalogService.import(
				filePath,
				sourceName.trim(),
				importTarget?.id,
			);
			snackbar.success(
				t(
					"pages.Settings.backupCatalog.importSuccess",
					"已导入 {{archives}} 组备份、{{files}} 个压缩文件",
					{
						archives: result.preview.archiveCount,
						files: result.preview.recognizedFileCount,
					},
				),
			);
			setDialogOpen(false);
			await Promise.all([
				loadSources(),
				queryClient.invalidateQueries({
					queryKey: backupCatalogKeys.gameCounts(),
				}),
			]);
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Settings.backupCatalog.importFailed", "目录树导入失败"),
				),
			);
		} finally {
			setImporting(false);
		}
	};

	const handleDelete = async () => {
		if (!deleteTarget) return;
		setDeleting(true);
		try {
			await backupCatalogService.deleteSource(deleteTarget.id);
			snackbar.success(
				t("pages.Settings.backupCatalog.deleteSuccess", "目录来源已删除"),
			);
			setDeleteTarget(null);
			await Promise.all([
				loadSources(),
				queryClient.invalidateQueries({
					queryKey: backupCatalogKeys.gameCounts(),
				}),
			]);
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Settings.backupCatalog.deleteFailed", "删除目录来源失败"),
				),
			);
		} finally {
			setDeleting(false);
		}
	};

	const statItems = preview
		? [
				[t("pages.Settings.backupCatalog.archiveGroups", "逻辑备份"), preview.archiveCount],
				[t("pages.Settings.backupCatalog.archiveFiles", "压缩文件"), preview.recognizedFileCount],
				[t("pages.Settings.backupCatalog.volumeGroups", "分卷备份"), preview.volumeArchiveCount],
				[t("pages.Settings.backupCatalog.multiPartGroups", "多文件分卷"), preview.multiPartArchiveCount],
				[t("pages.Settings.backupCatalog.ignoredEntries", "忽略条目"), preview.ignoredEntryCount],
				[t("pages.Settings.backupCatalog.warnings", "需注意"), preview.warningCount],
			]
		: [];

	return (
		<Box>
			<Stack direction="row" alignItems="center" className="mb-2">
				<InputLabel className="font-semibold">
					{t("pages.Settings.backupCatalog.title", "115 游戏备份目录")}
				</InputLabel>
				<SettingsHelp
					text={t(
					"pages.Settings.backupCatalog.description",
					"导入 115 导出的目录树文本，只建立压缩包索引，不会连接网盘或修改游戏文件。",
				)}
				/>
			</Stack>

			<Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
				<Button
					variant="outlined"
					startIcon={<CloudUploadIcon />}
					onClick={() => void handleChooseTree(null)}
				>
					{t("pages.Settings.backupCatalog.addSource", "导入新的目录树")}
				</Button>
				<Button
					variant="contained"
					startIcon={<ManageSearchIcon />}
					onClick={() => setMatchingOpen(true)}
					disabled={loadingSources || sources.length === 0}
				>
					{t("pages.Settings.backupMatching.open", "管理压缩包匹配")}
				</Button>
			</Stack>

			{loadingSources ? (
				<Box className="py-3"><CircularProgress size={22} /></Box>
			) : sources.length === 0 ? (
				<Alert severity="info" className="mt-3">
					{t("pages.Settings.backupCatalog.empty", "尚未导入目录树。选择 TXT 后会先显示预览，不会直接写入。")}
				</Alert>
			) : (
				<Stack spacing={1.5} className="mt-3">
					{sources.map((source) => (
						<Paper key={source.id} variant="outlined" className="p-3">
							<Stack direction={{ xs: "column", md: "row" }} spacing={2} justifyContent="space-between">
								<Box sx={{ minWidth: 0 }}>
									<Typography variant="subtitle2">{source.name}</Typography>
									<Typography variant="body2" color="text.secondary">
										{t(
											"pages.Settings.backupCatalog.sourceSummary",
											"{{archives}} 组备份 · {{files}} 个文件 · {{warnings}} 项注意",
											{
												archives: source.archiveCount,
												files: source.partCount,
												warnings: source.warningCount,
											},
										)}
									</Typography>
									<Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
										{new Date(source.importedAt).toLocaleString()} · {source.originalFilePath}
									</Typography>
									{source.missingCount > 0 && (
										<Typography variant="caption" color="warning.main" className="block">
											{t(
												"pages.Settings.backupCatalog.missingFromLatest",
												"{{count}} 组历史备份未出现在最新清单中，记录仍保留",
												{ count: source.missingCount },
											)}
										</Typography>
									)}
								</Box>
								<Stack direction="row" spacing={1} alignSelf={{ md: "center" }}>
									<Button
										variant="outlined"
										size="small"
										startIcon={<RefreshIcon />}
										onClick={() => void handleChooseTree(source)}
									>
										{t("pages.Settings.backupCatalog.update", "更新")}
									</Button>
									<Button
										variant="text"
										color="error"
										size="small"
										startIcon={<DeleteOutlineIcon />}
										onClick={() => setDeleteTarget(source)}
									>
										{t("common.delete", "删除")}
									</Button>
								</Stack>
							</Stack>
						</Paper>
					))}
				</Stack>
			)}

			<Dialog open={dialogOpen} onClose={importing ? undefined : () => setDialogOpen(false)} maxWidth="md" fullWidth>
				<DialogTitle>
					{importTarget
						? t("pages.Settings.backupCatalog.updateTitle", "更新目录来源")
						: t("pages.Settings.backupCatalog.importTitle", "导入目录树")}
				</DialogTitle>
				<DialogContent>
					{previewing ? (
						<Box className="flex items-center justify-center py-10"><CircularProgress /></Box>
					) : preview ? (
						<Stack spacing={2} className="pt-1">
							<TextField
								label={t("pages.Settings.backupCatalog.sourceName", "目录来源名称")}
								value={sourceName}
								onChange={(event) => setSourceName(event.target.value)}
								inputProps={{ maxLength: 120 }}
								fullWidth
							/>
							<Stack direction="row" spacing={1} alignItems="center">
								<FolderOpenIcon color="action" fontSize="small" />
								<Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
									{filePath}
								</Typography>
							</Stack>
							<Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 1 }}>
								{statItems.map(([label, value]) => (
									<Paper key={String(label)} variant="outlined" className="p-2 text-center">
										<Typography variant="h6">{value}</Typography>
										<Typography variant="caption" color="text.secondary">{label}</Typography>
									</Paper>
								))}
							</Box>
							<Typography variant="body2" color="text.secondary">
								7z: {preview.formatCounts.sevenZip} · ZIP: {preview.formatCounts.zip} · RAR: {preview.formatCounts.rar}
							</Typography>
							{preview.warnings.length > 0 && (
								<Alert severity="warning">
									<Stack spacing={0.5}>
										{preview.warnings.map((warning, index) => (
											<Typography key={`${warning.code}-${index}`} variant="body2" sx={{ overflowWrap: "anywhere" }}>
												{warning.message}{warning.path ? `：${warning.path}` : ""}
											</Typography>
										))}
									</Stack>
								</Alert>
							)}
							<Alert severity="info">
								{t(
									"pages.Settings.backupCatalog.importNote",
									"确认后只保存目录索引，不会下载、解压或修改任何游戏。",
								)}
							</Alert>
						</Stack>
					) : null}
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDialogOpen(false)} disabled={importing}>
						{t("common.cancel", "取消")}
					</Button>
					<Button
						variant="contained"
						onClick={() => void handleImport()}
						disabled={!preview || !sourceName.trim() || importing}
						startIcon={importing ? <CircularProgress size={16} color="inherit" /> : <CloudUploadIcon />}
					>
						{importing
							? t("pages.Settings.backupCatalog.importing", "导入中...")
							: t("pages.Settings.backupCatalog.confirmImport", "确认导入")}
					</Button>
				</DialogActions>
			</Dialog>

			<Dialog open={Boolean(deleteTarget)} onClose={deleting ? undefined : () => setDeleteTarget(null)} maxWidth="xs" fullWidth>
				<DialogTitle>{t("pages.Settings.backupCatalog.deleteTitle", "删除目录来源？")}</DialogTitle>
				<DialogContent>
					<Typography>
						{t(
							"pages.Settings.backupCatalog.deleteConfirm",
							"将删除“{{name}}”及其压缩包索引，不会删除原 TXT、网盘文件或游戏。",
							{ name: deleteTarget?.name ?? "" },
						)}
					</Typography>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDeleteTarget(null)} disabled={deleting}>
						{t("common.cancel", "取消")}
					</Button>
					<Button color="error" variant="contained" onClick={() => void handleDelete()} disabled={deleting}>
						{deleting ? t("common.deleting", "删除中...") : t("common.delete", "删除")}
					</Button>
				</DialogActions>
			</Dialog>

			{matchingOpen && (
				<BackupMatchingDialog
					open={true}
					onClose={() => setMatchingOpen(false)}
				/>
			)}
		</Box>
	);
};
