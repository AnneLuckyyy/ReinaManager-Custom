import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import {
	Box,
	CircularProgress,
	FormControl,
	IconButton,
	MenuItem,
	Select,
	Stack,
	Tooltip,
	Typography,
} from "@mui/material";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import type { ImportItem } from "./BulkImportTab";

interface BulkImportResultTableProps {
	items: ImportItem[];
	loading: boolean;
	emptyMessage: string;
	onDeleteItem: (path: string) => void;
	onClearMatchedData: (path: string) => void;
	onEditItem: (item: ImportItem) => void;
	onExecutableChange: (path: string, executable: string) => void;
	onOpenDirectory: (path: string) => void;
}

const gridTemplateColumns =
	"minmax(150px, 25fr) minmax(150px, 25fr) minmax(135px, 20fr) minmax(150px, 20fr) 120px";

const gridSx = {
	display: "grid",
	gridTemplateColumns,
	columnGap: 1.5,
	alignItems: "center",
	width: "100%",
	minWidth: 0,
} as const;

const cellSx = {
	minWidth: 0,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
} as const;

type DisplayRow =
	| { kind: "group"; key: string; count: number }
	| { kind: "item"; key: string; item: ImportItem; grouped: boolean };

function getMatchedGameName(item: ImportItem, language: string): string {
	const data = item.matchedData;
	if (!data) return "";
	const useChineseName = language === "zh-CN";
	return (
		(useChineseName
			? data.bgm_data?.name_cn ||
				data.vndb_data?.name_cn ||
				data.ymgal_data?.name_cn ||
				data.kun_data?.name_cn
			: undefined) ||
		data.bgm_data?.name ||
		data.vndb_data?.name ||
		data.ymgal_data?.name ||
		data.kun_data?.name ||
		data.dlsite_data?.name ||
		""
	);
}

function getFailurePhase(
	phase: ImportItem["errorPhase"],
	t: TFunction,
): string | undefined {
	if (phase === "preparation") {
		return t("components.BulkImportModal.failurePreparation", "准备游戏数据失败");
	}
	if (phase === "insertion") {
		return t("components.BulkImportModal.failureInsertion", "写入游戏失败");
	}
	if (phase === "request") {
		return t("components.BulkImportModal.failureRequest", "批量导入请求失败");
	}
	return undefined;
}

function getStatusLabel(item: ImportItem, t: TFunction): string {
	if (item.status === "pending") {
		return t("components.BulkImportModal.statusPending", "待处理");
	}
	if (item.status === "matched") {
		return t("components.BulkImportModal.statusMatched", "已匹配");
	}
	if (item.status === "not found") {
		return t("components.BulkImportModal.statusNotFound", "未找到");
	}
	if (item.status === "duplicate") {
		return item.duplicateMessage || t("components.BulkImportModal.statusDuplicate", "重复项");
	}
	if (item.status === "imported") {
		return t("components.BulkImportModal.statusImported", "已导入");
	}
	return t("components.BulkImportModal.statusError", "错误");
}

function buildDisplayRows(items: ImportItem[]): DisplayRow[] {
	const groupCounts = new Map<string, number>();
	for (const item of items) {
		if (item.duplicateGroupId) {
			groupCounts.set(
				item.duplicateGroupId,
				(groupCounts.get(item.duplicateGroupId) ?? 0) + 1,
			);
		}
	}

	const emittedGroups = new Set<string>();
	const rows: DisplayRow[] = [];
	for (const item of items) {
		const groupId = item.duplicateGroupId;
		const grouped = Boolean(groupId && (groupCounts.get(groupId) ?? 0) > 1);
		if (groupId && grouped && !emittedGroups.has(groupId)) {
			emittedGroups.add(groupId);
			rows.push({
				kind: "group",
				key: `group:${groupId}`,
				count: groupCounts.get(groupId) ?? 0,
			});
		}
		rows.push({ kind: "item", key: `item:${item.path}`, item, grouped });
	}
	return rows;
}

export default function BulkImportResultTable({
	items,
	loading,
	emptyMessage,
	onDeleteItem,
	onClearMatchedData,
	onEditItem,
	onExecutableChange,
	onOpenDirectory,
}: BulkImportResultTableProps) {
	const { t, i18n } = useTranslation();
	const rows = useMemo(() => buildDisplayRows(items), [items]);

	return (
		<Box
			sx={{
				alignSelf: "stretch",
				display: "flex",
				flex: "1 1 auto",
				flexDirection: "column",
				minHeight: 0,
				width: "100%",
			}}
		>
			<Box
				sx={{
					...gridSx,
					borderBottom: 1,
					borderColor: "divider",
					color: "text.primary",
					flexShrink: 0,
					fontWeight: 600,
				}}
				className="px-4 py-1.5"
			>
				<Typography variant="subtitle2" sx={cellSx}>
					{t("components.BulkImportModal.searchName", "搜索名称")}
				</Typography>
				<Typography variant="subtitle2" sx={cellSx}>
					{t("components.BulkImportModal.matchedGame", "匹配的游戏")}
				</Typography>
				<Typography variant="subtitle2" sx={cellSx}>
					{t("components.BulkImportModal.status", "状态")}
				</Typography>
				<Typography variant="subtitle2" sx={cellSx}>
					{t("components.BulkImportModal.executable", "启动程序")}
				</Typography>
				<Typography variant="subtitle2" align="center" sx={cellSx}>
					{t("components.BulkImportModal.actions", "操作")}
				</Typography>
			</Box>

			{rows.length === 0 ? (
				<Box
					sx={{
						alignItems: "center",
						display: "flex",
						flex: "1 1 auto",
						justifyContent: "center",
						minHeight: 120,
					}}
				>
					{loading ? (
						<Stack spacing={1.5} alignItems="center">
							<CircularProgress size={28} />
							<Typography color="text.secondary">{emptyMessage}</Typography>
						</Stack>
					) : (
						<Typography color="text.secondary">{emptyMessage}</Typography>
					)}
				</Box>
			) : (
				<Box sx={{ flex: "1 1 auto", minHeight: 0, width: "100%" }}>
					<Virtuoso
						style={{ height: "100%", width: "100%" }}
						data={rows}
						computeItemKey={(_, row) => row.key}
						overscan={300}
						itemContent={(_, row) => {
							if (row.kind === "group") {
								return (
									<Box
										className="px-4 py-1"
										sx={{
											bgcolor: "warning.lighter",
											borderLeft: 3,
											borderColor: "warning.main",
										}}
									>
										<Typography variant="caption" fontWeight={600}>
											{t(
												"components.BulkImportModal.inlineDuplicateGroup",
												"本批次重复项（{{count}} 项）",
												{ count: row.count },
											)}
										</Typography>
									</Box>
								);
							}

							const { item } = row;
							const matchedName = getMatchedGameName(item, i18n.language);
							const statusLabel = getStatusLabel(item, t);
							const failurePhase = getFailurePhase(item.errorPhase, t);
							const directoryPath =
								item.launch_type === "steam"
									? item.steam_monitor_path
									: item.path;
							return (
								<Box
									data-bulk-item-path={item.path}
									sx={{
										...gridSx,
										borderBottom: 1,
										borderColor: "divider",
										boxShadow: row.grouped
											? "inset 3px 0 var(--mui-palette-warning-main)"
											: undefined,
									}}
									className="min-h-11 px-4 py-1"
								>
									<Typography variant="body2" sx={cellSx} title={item.name}>
										{item.name}
									</Typography>
									<Typography variant="body2" sx={cellSx} title={matchedName}>
										{matchedName || "-"}
									</Typography>
									<Box sx={{ minWidth: 0 }} title={item.errorMessage}>
										<Typography
											variant="body2"
											noWrap
											color={item.status === "error" ? "error" : undefined}
										>
											{statusLabel}
										</Typography>
										{failurePhase && (
											<Typography variant="caption" color="error" noWrap title={failurePhase}>
												{failurePhase}
											</Typography>
										)}
										{item.errorMessage && (
											<Typography
												variant="caption"
												color="error"
												sx={{ display: "block", overflowWrap: "anywhere" }}
											>
												{item.errorMessage}
											</Typography>
										)}
									</Box>
									<Box sx={{ minWidth: 0 }}>
										{item.launch_type === "steam" ? (
											<Typography variant="body2" noWrap title={item.steam_launch_id}>
												Steam · {item.steam_launch_id}
											</Typography>
										) : item.executables.length === 1 ? (
											<Typography variant="body2" noWrap title={item.executables[0]}>
												{item.executables[0]}
											</Typography>
										) : (
											<FormControl size="small" fullWidth>
												<Select
													value={item.selectedExe || ""}
													onChange={(event) =>
														onExecutableChange(item.path, event.target.value)
													}
													displayEmpty
													disabled={item.status === "imported" || loading}
													renderValue={(selected) => (
														<Typography
															variant="body2"
															noWrap
															color={selected ? undefined : "text.secondary"}
															sx={{ maxWidth: "100%" }}
														>
															{selected ||
																t("components.BulkImportModal.selectExe", "请选择启动程序")}
														</Typography>
													)}
												>
													<MenuItem value="" disabled>
														{t("components.BulkImportModal.selectExe", "请选择启动程序")}
													</MenuItem>
													{item.executables.map((exe) => (
														<MenuItem key={exe} value={exe}>
															{exe}
														</MenuItem>
													))}
												</Select>
											</FormControl>
										)}
									</Box>
									<Stack direction="row" spacing={0.25} justifyContent="center">
										<Tooltip
											title={t(
												"components.BulkImportModal.openGameFolder",
												"打开游戏目录",
											)}
										>
											<span>
											<IconButton
												size="small"
												aria-label={t(
													"components.BulkImportModal.openGameFolder",
													"打开游戏目录",
												)}
												disabled={!directoryPath}
												onClick={() => directoryPath && onOpenDirectory(directoryPath)}
											>
												<FolderOpenIcon fontSize="small" />
											</IconButton>
											</span>
										</Tooltip>
										{item.status !== "imported" && (
											<>
												{item.matchedData && (
													<Tooltip title={t("components.BulkImportModal.clearMatchedMetadata", "去除匹配元数据")}>
														<span>
															<IconButton
																size="small"
																onClick={() => onClearMatchedData(item.path)}
																disabled={loading}
															>
																<LinkOffIcon fontSize="small" />
															</IconButton>
														</span>
													</Tooltip>
												)}
												<IconButton
													size="small"
													onClick={() => onEditItem(item)}
													disabled={loading}
												>
													<EditIcon fontSize="small" />
												</IconButton>
												<IconButton
													size="small"
													onClick={() => onDeleteItem(item.path)}
													disabled={loading}
												>
													<DeleteIcon fontSize="small" />
												</IconButton>
											</>
										)}
									</Stack>
								</Box>
							);
						}}
					/>
				</Box>
			)}
		</Box>
	);
}
