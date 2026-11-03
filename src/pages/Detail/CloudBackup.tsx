import RefreshIcon from "@mui/icons-material/Refresh";
import SaveIcon from "@mui/icons-material/Save";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import {
	Alert,
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	CircularProgress,
	Divider,
	IconButton,
	Paper,
	Stack,
	TextField,
	Tooltip,
	Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { backupCatalogKeys } from "@/hooks/queries/useBackupCatalog";
import { useUpdateGame } from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";
import { backupCatalogService, type GameBackupArchiveRecord } from "@/services/invoke";
import type { GameData } from "@/types";
import { deriveBackupMatchName } from "@/utils/backupMatchName";
import { getUserErrorMessage } from "@/utils/errors";

interface CloudBackupProps {
	selectedGame: GameData;
}

export const CloudBackup: React.FC<CloudBackupProps> = ({ selectedGame }) => {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const updateGameMutation = useUpdateGame();
	const [backupMatchName, setBackupMatchName] = useState(
		selectedGame.custom_data?.backupMatchName ?? "",
	);
	const [archives, setArchives] = useState<GameBackupArchiveRecord[]>([]);
	const [loadingArchives, setLoadingArchives] = useState(true);

	const loadArchives = useCallback(async () => {
		setLoadingArchives(true);
		try {
			setArchives(await backupCatalogService.listGameArchives(selectedGame.id));
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Detail.CloudBackup.loadArchivesFailed", "读取关联压缩包失败"),
				),
			);
		} finally {
			setLoadingArchives(false);
		}
	}, [selectedGame.id, t]);

	useEffect(() => {
		setBackupMatchName(selectedGame.custom_data?.backupMatchName ?? "");
	}, [selectedGame.id, selectedGame.custom_data?.backupMatchName]);

	useEffect(() => {
		void loadArchives();
	}, [loadArchives]);

	const sourcePath = useMemo(
		() =>
			selectedGame.localpath?.trim() ||
			[...(selectedGame.custom_data?.extraLocalPaths ?? [])].reverse().find((path) => path.trim()) ||
			"",
		[selectedGame.localpath, selectedGame.custom_data?.extraLocalPaths],
	);
	const normalizedName = backupMatchName.trim();
	const originalName = selectedGame.custom_data?.backupMatchName?.trim() ?? "";
	const hasChanges = normalizedName !== originalName;

	const handleDerive = () => {
		const derivedName = deriveBackupMatchName(
			selectedGame.localpath,
			selectedGame.custom_data?.extraLocalPaths,
		);
		if (!derivedName) {
			snackbar.warning(
				t(
					"pages.Detail.CloudBackup.matchNameUnavailable",
					"当前没有可用于获取目录名的游戏路径",
				),
			);
			return;
		}
		setBackupMatchName(derivedName);
	};

	const handleSave = async () => {
		if (!hasChanges) return;
		try {
			await updateGameMutation.mutateAsync({
				gameId: selectedGame.id,
				updates: {
					custom_data: {
						...selectedGame.custom_data,
						backupMatchName: normalizedName || null,
						backupMatchNameManual: true,
					},
				},
			});
			snackbar.success(
				t("pages.Detail.CloudBackup.saveSuccess", "备份匹配目录名已保存"),
			);
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Detail.CloudBackup.saveFailed", "保存备份匹配目录名失败"),
				),
			);
		}
	};

	const copyText = async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			snackbar.success(t("pages.Detail.CloudBackup.copied", "已复制"));
		} catch {
			snackbar.error(t("pages.Detail.CloudBackup.copyFailed", "复制失败"));
		}
	};

	const unlinkArchive = async (archiveId: number) => {
		try {
			await backupCatalogService.setArchiveMatch(archiveId, null);
			await Promise.all([
				loadArchives(),
				queryClient.invalidateQueries({
					queryKey: backupCatalogKeys.gameCounts(),
				}),
			]);
			snackbar.success(t("pages.Detail.CloudBackup.unlinked", "压缩包关联已清除"));
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Detail.CloudBackup.unlinkFailed", "清除压缩包关联失败"),
				),
			);
		}
	};

	return (
		<Box sx={{ maxWidth: 900 }}>
			<Card>
				<CardContent>
					<Stack spacing={2}>
						<Box>
							<Typography variant="h6">
								{t("pages.Detail.CloudBackup.title", "网盘备份匹配")}
							</Typography>
							<Typography variant="body2" color="text.secondary">
								{t(
									"pages.Detail.CloudBackup.description",
									"用于将目录树中的压缩包与这个游戏关联。目录层级特殊时可以手动修改。",
								)}
							</Typography>
						</Box>

						<TextField
							label={t(
								"pages.Detail.CloudBackup.matchName",
								"备份匹配目录名",
							)}
							value={backupMatchName}
							onChange={(event) => setBackupMatchName(event.target.value)}
							placeholder={t(
								"pages.Detail.CloudBackup.matchNamePlaceholder",
								"例如：Monster Hunter World",
							)}
							fullWidth
							disabled={updateGameMutation.isPending}
						/>

						{sourcePath ? (
							<Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
								{t("pages.Detail.CloudBackup.pathSource", "当前取名路径")}: {sourcePath}
							</Typography>
						) : (
							<Alert severity="info">
								{t(
									"pages.Detail.CloudBackup.noPath",
									"这个游戏没有主路径或备用路径，请手动输入匹配目录名。",
								)}
							</Alert>
						)}

						<Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
							<Button
								variant="outlined"
								startIcon={<RefreshIcon />}
								onClick={handleDerive}
								disabled={updateGameMutation.isPending || !sourcePath}
							>
								{t("pages.Detail.CloudBackup.derive", "从当前路径获取")}
							</Button>
							<Button
								variant="contained"
								startIcon={
									updateGameMutation.isPending ? (
										<CircularProgress size={16} color="inherit" />
									) : (
										<SaveIcon />
									)
								}
								onClick={() => void handleSave()}
								disabled={updateGameMutation.isPending || !hasChanges}
							>
								{t("pages.Detail.CloudBackup.save", "保存匹配名")}
							</Button>
						</Stack>

						<Divider />
						<Box>
							<Typography variant="h6">
								{t("pages.Detail.CloudBackup.linkedArchives", "已关联压缩包")}
							</Typography>
							<Typography variant="body2" color="text.secondary">
								{t("pages.Detail.CloudBackup.linkedDescription", "不同版本可以同时关联到这个游戏；分卷仍显示为一组逻辑备份。")}
							</Typography>
						</Box>

						{loadingArchives ? (
							<Box><CircularProgress size={22} /></Box>
						) : archives.length === 0 ? (
							<Alert severity="info">
								{t("pages.Detail.CloudBackup.noLinkedArchives", "尚未关联目录树中的压缩包")}
							</Alert>
						) : (
							<Stack spacing={1}>
								{archives.map((archive) => {
									const fullPath = archive.parts[0]?.relativePath ?? archive.baseName;
									const fileName = archive.parts[0]?.fileName ?? archive.baseName;
									return (
										<Paper key={archive.id} variant="outlined" className="p-3">
											<Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1}>
												<Box sx={{ minWidth: 0 }}>
													<Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
														<Typography variant="subtitle2" sx={{ overflowWrap: "anywhere" }}>{archive.baseName}</Typography>
														<Chip size="small" label={archive.archiveFormat.toUpperCase()} />
														<Chip size="small" label={`${archive.partCount} ${t("pages.Detail.CloudBackup.files", "个文件")}`} />
														{!archive.matchConfirmed && <Chip size="small" color="warning" label={t("pages.Detail.CloudBackup.awaitingConfirmation", "待确认")} />}
														{!archive.isPresent && <Chip size="small" color="warning" label={t("pages.Detail.CloudBackup.historical", "历史记录")} />}
													</Stack>
													<Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{fullPath}</Typography>
												</Box>
												<Stack direction="row">
													<Tooltip title={t("pages.Detail.CloudBackup.copyName", "复制压缩包名")}><IconButton onClick={() => void copyText(fileName)}><ContentCopyIcon /></IconButton></Tooltip>
													<Tooltip title={t("pages.Detail.CloudBackup.copyPath", "复制网盘路径")}><IconButton onClick={() => void copyText(fullPath)}><ContentCopyIcon color="primary" /></IconButton></Tooltip>
													<Tooltip title={t("pages.Detail.CloudBackup.unlink", "清除关联")}><IconButton color="warning" onClick={() => void unlinkArchive(archive.id)}><LinkOffIcon /></IconButton></Tooltip>
												</Stack>
											</Stack>
										</Paper>
									);
								})}
							</Stack>
						)}
					</Stack>
				</CardContent>
			</Card>
		</Box>
	);
};
