import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import SaveIcon from "@mui/icons-material/Save";
import {
	Alert,
	Box,
	Button,
	Chip,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Divider,
	FormControlLabel,
	IconButton,
	ListItemButton,
	MenuItem,
	Paper,
	Stack,
	Switch,
	Tab,
	Tabs,
	TextField,
	Tooltip,
	Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import { useAllGames, useUpdateGame } from "@/hooks/queries/useGames";
import { backupCatalogKeys } from "@/hooks/queries/useBackupCatalog";
import { snackbar } from "@/providers/snackBar";
import {
	backupCatalogService,
	type BackupArchiveRecord,
} from "@/services/invoke";
import {
	analyzeBackupMatching,
	searchBackupMatchingGames,
} from "@/utils/backupMatching";
import { getUserErrorMessage } from "@/utils/errors";

interface BackupMatchingDialogProps {
	open: boolean;
	onClose: () => void;
}

type MatchTab = "unmatched" | "doubtful" | "processed" | "no_game";

function archiveFullPath(archive: BackupArchiveRecord): string {
	return archive.parts[0]?.relativePath ??
		[archive.relativeDirectory, archive.baseName].filter(Boolean).join("/");
}

export const BackupMatchingDialog: React.FC<BackupMatchingDialogProps> = ({
	open,
	onClose,
}) => {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const gamesQuery = useAllGames();
	const updateGameMutation = useUpdateGame();
	const [archives, setArchives] = useState<BackupArchiveRecord[]>([]);
	const [loadingArchives, setLoadingArchives] = useState(false);
	const [tab, setTab] = useState<MatchTab>("unmatched");
	const [archiveSearch, setArchiveSearch] = useState("");
	const [sourceFilter, setSourceFilter] = useState("all");
	const [formatFilter, setFormatFilter] = useState("all");
	const [showHistorical, setShowHistorical] = useState(false);
	const [selectedArchiveId, setSelectedArchiveId] = useState<number | null>(null);
	const [gameSearch, setGameSearch] = useState("");
	const [selectedGameId, setSelectedGameId] = useState<number | null>(null);
	const [matchNameDraft, setMatchNameDraft] = useState("");
	const [savingMatch, setSavingMatch] = useState(false);
	const [autoPreviewOpen, setAutoPreviewOpen] = useState(false);
	const [applyingAuto, setApplyingAuto] = useState(false);

	const loadArchives = useCallback(async () => {
		setLoadingArchives(true);
		try {
			setArchives(await backupCatalogService.listArchives());
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Settings.backupMatching.loadFailed", "读取备份匹配数据失败"),
				),
			);
		} finally {
			setLoadingArchives(false);
		}
	}, [t]);

	useEffect(() => {
		if (open) void loadArchives();
	}, [open, loadArchives]);

	const analysis = useMemo(
		() => analyzeBackupMatching(archives, gamesQuery.data ?? []),
		[archives, gamesQuery.data],
	);
	const gamesById = useMemo(
		() => new Map(analysis.games.map((game) => [game.full.id, game])),
		[analysis.games],
	);
	const sourceNames = useMemo(
		() => [...new Set(archives.map((archive) => archive.sourceName))].toSorted(),
		[archives],
	);

	const counts = useMemo(() => {
		let unmatched = 0;
		let doubtful = 0;
		let processed = 0;
		let noGame = 0;
		for (const archive of archives) {
			if (!showHistorical && !archive.isPresent) continue;
			if (archive.matchStatus === "matched" && archive.matchConfirmed === false) doubtful += 1;
			else if (archive.matchStatus === "no_game") noGame += 1;
			else if (archive.matchStatus) processed += 1;
			else unmatched += 1;
		}
		return { unmatched, doubtful, processed, noGame };
	}, [archives, showHistorical]);

	const filteredArchives = useMemo(() => {
		const query = archiveSearch.trim().toLocaleLowerCase();
		return archives.filter((archive) => {
			if (!showHistorical && !archive.isPresent) return false;
			if (sourceFilter !== "all" && archive.sourceName !== sourceFilter) return false;
			if (formatFilter !== "all" && archive.archiveFormat !== formatFilter) return false;
			if (query && ![
				archive.baseName,
				archive.relativeDirectory,
				archive.sourceName,
				...archive.parts.map((part) => part.fileName),
			].join(" ").toLocaleLowerCase().includes(query)) return false;
			const doubtful =
				archive.matchStatus === "matched" && archive.matchConfirmed === false;
			if (tab === "doubtful") return doubtful;
			if (tab === "no_game") return archive.matchStatus === "no_game";
			if (tab === "processed") return archive.matchStatus === "matched" && !doubtful;
			return !archive.matchStatus;
		});
	}, [
		archives,
		archiveSearch,
		sourceFilter,
		formatFilter,
		showHistorical,
		tab,
	]);

	useEffect(() => {
		if (
			selectedArchiveId === null ||
			!filteredArchives.some((archive) => archive.id === selectedArchiveId)
		) {
			setSelectedArchiveId(filteredArchives[0]?.id ?? null);
		}
	}, [filteredArchives, selectedArchiveId]);

	const selectedArchive = useMemo(
		() => archives.find((archive) => archive.id === selectedArchiveId) ?? null,
		[archives, selectedArchiveId],
	);
	const gameCandidates = useMemo(
		() => searchBackupMatchingGames(analysis.games, gameSearch, 40),
		[analysis.games, gameSearch],
	);
	const selectedGame = selectedGameId === null ? null : gamesById.get(selectedGameId) ?? null;

	useEffect(() => {
		if (!selectedArchive) return;
		setGameSearch(selectedArchive.baseName);
		setSelectedGameId(
			selectedArchive.matchedGameId ??
				analysis.suggestedGameByArchive.get(selectedArchive.id) ??
				null,
		);
	}, [selectedArchive?.id, selectedArchive?.baseName, selectedArchive?.matchedGameId, analysis.suggestedGameByArchive]);

	useEffect(() => {
		setMatchNameDraft(selectedGame?.matchName ?? "");
	}, [selectedGame?.full.id, selectedGame?.matchName]);

	const chooseNextArchive = (currentId: number) => {
		const index = filteredArchives.findIndex((archive) => archive.id === currentId);
		const next = filteredArchives[index + 1] ?? filteredArchives[index - 1];
		setSelectedArchiveId(next?.id ?? null);
	};

	const saveArchiveMatch = async (status: "matched" | "no_game" | null) => {
		if (!selectedArchive) return;
		if (status === "matched" && selectedGameId === null) {
			snackbar.warning(t("pages.Settings.backupMatching.chooseGame", "请先选择一个游戏"));
			return;
		}
		setSavingMatch(true);
		try {
			// “关联并下一项”等动作也要先落盘当前右侧的目录名草稿，
			// 不能要求用户额外点击保存，否则切换条目会丢失修改。
			if (
				selectedGame &&
				matchNameDraft.trim() !==
					(selectedGame.full.custom_data?.backupMatchName?.trim() ?? "")
			) {
				await updateGameMutation.mutateAsync({
					gameId: selectedGame.full.id,
					updates: {
						custom_data: {
							...selectedGame.full.custom_data,
							backupMatchName: matchNameDraft.trim() || null,
							backupMatchNameManual: true,
						},
					},
				});
			}
			await backupCatalogService.setArchiveMatch(
				selectedArchive.id,
				status,
				selectedGameId ?? undefined,
			);
			if (status) chooseNextArchive(selectedArchive.id);
			await Promise.all([
				loadArchives(),
				queryClient.invalidateQueries({
					queryKey: backupCatalogKeys.gameCounts(),
				}),
			]);
			snackbar.success(
				status === null
					? t("pages.Settings.backupMatching.cleared", "关联已清除")
					: t("pages.Settings.backupMatching.saved", "匹配结果已保存"),
			);
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Settings.backupMatching.saveFailed", "保存匹配结果失败"),
				),
			);
		} finally {
			setSavingMatch(false);
		}
	};

	const saveSelectedGameMatchName = async () => {
		if (!selectedGame) return;
		try {
			await updateGameMutation.mutateAsync({
				gameId: selectedGame.full.id,
				updates: {
					custom_data: {
						...selectedGame.full.custom_data,
						backupMatchName: matchNameDraft.trim() || null,
						backupMatchNameManual: true,
					},
				},
			});
			snackbar.success(t("pages.Settings.backupMatching.nameSaved", "游戏匹配名已保存"));
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Settings.backupMatching.nameSaveFailed", "保存游戏匹配名失败"),
				),
			);
		}
	};

	const applyAutoMatches = async () => {
		setApplyingAuto(true);
		try {
			const result = await backupCatalogService.applyAutoMatches(
				analysis.nameFills,
				analysis.autoMatches,
			);
			setAutoPreviewOpen(false);
			await Promise.all([
				loadArchives(),
				gamesQuery.refetch(),
				queryClient.invalidateQueries({
					queryKey: backupCatalogKeys.gameCounts(),
				}),
			]);
			snackbar.success(
				t(
					"pages.Settings.backupMatching.autoApplied",
					"已补齐 {{names}} 个匹配名，并安全关联 {{archives}} 个压缩包",
					{
						names: result.filledNameCount,
						archives: result.confirmedArchiveCount,
					},
				),
			);
			if (result.doubtfulArchiveCount > 0) {
				snackbar.info(
					t(
					"pages.Settings.backupMatching.doubtfulCreated",
					"另有 {{count}} 个压缩包已临时关联，请在“存疑”中确认",
					{ count: result.doubtfulArchiveCount },
				),
				);
			}
		} catch (error) {
			snackbar.error(
				getUserErrorMessage(
					error,
					t,
					t("pages.Settings.backupMatching.autoFailed", "自动匹配失败，未应用更改"),
				),
			);
		} finally {
			setApplyingAuto(false);
		}
	};

	const copyText = async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			snackbar.success(t("pages.Settings.backupMatching.copied", "已复制"));
		} catch {
			snackbar.error(t("pages.Settings.backupMatching.copyFailed", "复制失败"));
		}
	};

	const busy = loadingArchives || gamesQuery.isLoading;

	return (
		<Dialog open={open} onClose={onClose} fullWidth maxWidth="xl" PaperProps={{ sx: { height: "90vh" } }}>
			<DialogTitle>
				<Stack direction={{ xs: "column", md: "row" }} gap={1} justifyContent="space-between">
					<Box>
						<Typography variant="h6">{t("pages.Settings.backupMatching.title", "压缩包与游戏匹配")}</Typography>
						<Typography variant="body2" color="text.secondary">
							{t("pages.Settings.backupMatching.description", "以压缩包为中心逐项确认；未打开本页时不会运行匹配分析。")}
						</Typography>
					</Box>
					<Button
						variant="outlined"
						startIcon={<AutoFixHighIcon />}
						onClick={() => setAutoPreviewOpen(true)}
						disabled={busy || (analysis.nameFills.length === 0 && analysis.autoMatches.length === 0)}
					>
						{t("pages.Settings.backupMatching.safeAuto", "安全自动匹配")}
					</Button>
				</Stack>
			</DialogTitle>
			<DialogContent dividers sx={{ p: 0, overflow: "hidden" }}>
				{busy ? (
					<Box className="h-full flex items-center justify-center"><CircularProgress /></Box>
				) : (
					<Box className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(22rem,42%)_minmax(0,1fr)]">
						<Box className="flex min-h-0 flex-col border-0 border-r border-solid border-[var(--mui-palette-divider)]">
							<Tabs value={tab} onChange={(_, value: MatchTab) => setTab(value)} variant="fullWidth">
								<Tab value="unmatched" label={`${t("pages.Settings.backupMatching.unmatched", "未匹配")} (${counts.unmatched})`} />
								<Tab value="doubtful" label={`${t("pages.Settings.backupMatching.doubtful", "存疑")} (${counts.doubtful})`} />
								<Tab value="processed" label={`${t("pages.Settings.backupMatching.processed", "已处理")} (${counts.processed})`} />
								<Tab value="no_game" label={`${t("pages.Settings.backupMatching.noGame", "无对应游戏")} (${counts.noGame})`} />
							</Tabs>
							<Stack spacing={1} className="p-2">
								<TextField size="small" value={archiveSearch} onChange={(event) => setArchiveSearch(event.target.value)} placeholder={t("pages.Settings.backupMatching.searchArchives", "搜索压缩包名或网盘路径")} />
								<Stack direction="row" spacing={1}>
									<TextField select size="small" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} label={t("pages.Settings.backupMatching.source", "来源")} fullWidth>
										<MenuItem value="all">{t("pages.Settings.backupMatching.all", "全部")}</MenuItem>
										{sourceNames.map((name) => <MenuItem key={name} value={name}>{name}</MenuItem>)}
									</TextField>
									<TextField select size="small" value={formatFilter} onChange={(event) => setFormatFilter(event.target.value)} label={t("pages.Settings.backupMatching.format", "格式")} fullWidth>
										<MenuItem value="all">{t("pages.Settings.backupMatching.all", "全部")}</MenuItem>
										{["7z", "zip", "rar"].map((format) => <MenuItem key={format} value={format}>{format.toUpperCase()}</MenuItem>)}
									</TextField>
								</Stack>
								<FormControlLabel control={<Switch size="small" checked={showHistorical} onChange={(_, checked) => setShowHistorical(checked)} />} label={t("pages.Settings.backupMatching.showHistorical", "显示最新目录树中已消失的历史记录")} />
							</Stack>
							<Divider />
							<Box className="min-h-0 flex-1">
								{filteredArchives.length === 0 ? (
									<Box className="p-4"><Alert severity="info">{t("pages.Settings.backupMatching.emptyList", "当前分区没有符合条件的压缩包")}</Alert></Box>
								) : (
									<Virtuoso
										data={filteredArchives}
										itemContent={(_, archive) => {
											const matchedGame = archive.matchedGameId ? gamesById.get(archive.matchedGameId) : null;
											const suggestedGameId = analysis.suggestedGameByArchive.get(archive.id);
											return (
												<ListItemButton selected={archive.id === selectedArchiveId} onClick={() => setSelectedArchiveId(archive.id)} divider alignItems="flex-start">
													<Box sx={{ minWidth: 0, width: "100%" }}>
														<Stack direction="row" gap={0.75} alignItems="center">
															<Typography variant="subtitle2" noWrap>{archive.baseName}</Typography>
															<Chip size="small" label={archive.archiveFormat.toUpperCase()} />
															{archive.partCount > 1 && <Chip size="small" label={`${archive.partCount} ${t("pages.Settings.backupMatching.parts", "卷")}`} />}
														</Stack>
														<Typography variant="caption" color="text.secondary" noWrap>{archiveFullPath(archive)}</Typography>
														{archive.matchStatus === "no_game" ? (
															<Typography variant="caption" color="text.secondary" className="block">{t("pages.Settings.backupMatching.noGame", "无对应游戏")}</Typography>
														) : matchedGame ? (
															<Typography variant="caption" color={archive.matchConfirmed === false ? "warning.main" : "success.main"} className="block">
																{archive.matchConfirmed === false ? t("pages.Settings.backupMatching.awaitingConfirmation", "待确认") : t("pages.Settings.backupMatching.confirmed", "已确认")} → {matchedGame.displayName}
															</Typography>
														) : suggestedGameId ? (
															<Typography variant="caption" color="primary.main" className="block">{t("pages.Settings.backupMatching.autoCandidate", "自动匹配候选")}: {gamesById.get(suggestedGameId)?.displayName}</Typography>
														) : null}
													</Box>
												</ListItemButton>
											);
										}}
									/>
								)}
							</Box>
						</Box>

						<Box className="min-h-0 overflow-y-auto p-3 md:p-4">
							{!selectedArchive ? (
								<Alert severity="info">{t("pages.Settings.backupMatching.chooseArchive", "请从左侧选择一个压缩包")}</Alert>
							) : (
								<Stack spacing={2}>
									<Paper variant="outlined" className="p-3">
										<Stack direction="row" justifyContent="space-between" gap={1}>
											<Box sx={{ minWidth: 0 }}>
												<Typography variant="h6" sx={{ overflowWrap: "anywhere" }}>{selectedArchive.baseName}</Typography>
												<Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{archiveFullPath(selectedArchive)}</Typography>
											</Box>
											<Stack direction="row">
												<Tooltip title={t("pages.Settings.backupMatching.copyName", "复制压缩包名")}><IconButton onClick={() => void copyText(selectedArchive.parts[0]?.fileName ?? selectedArchive.baseName)}><ContentCopyIcon /></IconButton></Tooltip>
												<Tooltip title={t("pages.Settings.backupMatching.copyPath", "复制网盘路径")}><IconButton onClick={() => void copyText(archiveFullPath(selectedArchive))}><ContentCopyIcon color="primary" /></IconButton></Tooltip>
											</Stack>
										</Stack>
										<Stack direction="row" spacing={1} className="mt-2" flexWrap="wrap" useFlexGap>
											<Chip size="small" label={selectedArchive.sourceName} />
											<Chip size="small" label={`${selectedArchive.archiveFormat.toUpperCase()} · ${selectedArchive.partCount} ${t("pages.Settings.backupMatching.files", "个文件")}`} />
											<Chip size="small" color={selectedArchive.sequenceStatus === "complete" || selectedArchive.sequenceStatus === "continuous" ? "success" : "warning"} label={selectedArchive.sequenceStatus} />
											{!selectedArchive.isPresent && <Chip size="small" color="warning" label={t("pages.Settings.backupMatching.historical", "历史记录")} />}
										</Stack>
									</Paper>

									<TextField fullWidth size="small" label={t("pages.Settings.backupMatching.searchGame", "搜索游戏（名称、匹配名或路径）")} value={gameSearch} onChange={(event) => setGameSearch(event.target.value)} />
									<Paper variant="outlined" sx={{ maxHeight: 250, overflowY: "auto" }}>
										{gameCandidates.map((game) => (
											<ListItemButton key={game.full.id} selected={game.full.id === selectedGameId} onClick={() => setSelectedGameId(game.full.id)} divider>
												<Box sx={{ minWidth: 0 }}>
													<Typography variant="subtitle2" noWrap>{game.displayName}</Typography>
													<Typography variant="caption" color="primary.main" className="block" noWrap>{game.matchName || t("pages.Settings.backupMatching.noMatchName", "未设置匹配名")}</Typography>
													<Typography variant="caption" color="text.secondary" className="block" noWrap>{game.full.localpath || [...(game.full.custom_data?.extraLocalPaths ?? [])].reverse().find((path) => path.trim()) || t("pages.Settings.backupMatching.noPath", "无游戏路径")}</Typography>
												</Box>
											</ListItemButton>
										))}
									</Paper>

									{selectedGame && (
										<Paper variant="outlined" className="p-3">
											<Typography variant="subtitle2">{t("pages.Settings.backupMatching.editMatchName", "直接修改所选游戏的匹配目录名")}</Typography>
											<Stack direction={{ xs: "column", sm: "row" }} spacing={1} className="mt-2">
												<TextField size="small" value={matchNameDraft} onChange={(event) => setMatchNameDraft(event.target.value)} fullWidth />
												<Button startIcon={<SaveIcon />} variant="outlined" onClick={() => void saveSelectedGameMatchName()} disabled={updateGameMutation.isPending || matchNameDraft.trim() === (selectedGame.full.custom_data?.backupMatchName?.trim() ?? "")}>{t("pages.Settings.backupMatching.save", "保存")}</Button>
											</Stack>
										</Paper>
									)}

									<Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
										<Button variant="contained" startIcon={<LinkIcon />} onClick={() => void saveArchiveMatch("matched")} disabled={savingMatch || !selectedGame}>
											{selectedArchive.matchConfirmed === false
												? selectedGameId === selectedArchive.matchedGameId
													? t("pages.Settings.backupMatching.confirmAndNext", "确认当前匹配并下一项")
													: t("pages.Settings.backupMatching.replaceAndConfirm", "改为所选游戏并确认")
												: t("pages.Settings.backupMatching.linkAndNext", "关联并下一项")}
										</Button>
										<Button variant="outlined" onClick={() => void saveArchiveMatch("no_game")} disabled={savingMatch}>{t("pages.Settings.backupMatching.noGameAndNext", "无对应游戏并下一项")}</Button>
										{selectedArchive.matchStatus && <Button color="warning" startIcon={<LinkOffIcon />} onClick={() => void saveArchiveMatch(null)} disabled={savingMatch}>{t("pages.Settings.backupMatching.clearLink", "清除关联")}</Button>}
									</Stack>
								</Stack>
							)}
						</Box>
					</Box>
				)}
			</DialogContent>
			<DialogActions><Button onClick={onClose}>{t("pages.Settings.backupMatching.close", "关闭")}</Button></DialogActions>

			<Dialog open={autoPreviewOpen} onClose={applyingAuto ? undefined : () => setAutoPreviewOpen(false)} maxWidth="sm" fullWidth>
				<DialogTitle>{t("pages.Settings.backupMatching.autoPreviewTitle", "确认安全自动匹配")}</DialogTitle>
				<DialogContent>
					<Alert severity="info" className="mb-3">{t("pages.Settings.backupMatching.autoRule", "只自动确认规范化后完全同名且唯一的游戏；相似的匹配目录名、游戏名或路径会进入“存疑”待确认。")}</Alert>
					<Stack spacing={1}>
						<Typography>{t("pages.Settings.backupMatching.namesToFill", "将补齐空白匹配名")}: {analysis.nameFills.length}</Typography>
						<Typography>{t("pages.Settings.backupMatching.archivesToMatch", "将直接确认的精确匹配")}: {analysis.confirmedAutoMatches.length}</Typography>
						<Typography>{t("pages.Settings.backupMatching.doubtfulToLink", "将临时关联为存疑")}: {analysis.doubtfulAutoMatches.length}</Typography>
						<Typography>{t("pages.Settings.backupMatching.doubtfulRemain", "当前已有待人工确认")}: {counts.doubtful}</Typography>
					</Stack>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setAutoPreviewOpen(false)} disabled={applyingAuto}>{t("common.cancel", "取消")}</Button>
					<Button variant="contained" onClick={() => void applyAutoMatches()} disabled={applyingAuto} startIcon={applyingAuto ? <CircularProgress size={16} color="inherit" /> : <AutoFixHighIcon />}>{t("pages.Settings.backupMatching.apply", "确认应用")}</Button>
				</DialogActions>
			</Dialog>
		</Dialog>
	);
};
