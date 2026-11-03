import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import SportsEsportsIcon from "@mui/icons-material/SportsEsports";
import TuneIcon from "@mui/icons-material/Tune";
import {
	Alert,
	Box,
	Button,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	FormControl,
	FormControlLabel,
	IconButton,
	InputLabel,
	MenuItem,
	Popover,
	Radio,
	RadioGroup,
	Select,
	Stack,
	TextField,
	Tooltip,
	Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { gameMetadataService } from "@/api";
import { useMetadataSearchFlow } from "@/hooks/common/useMetadataSearchFlow";
import { useGameCategorySourceAssignment } from "@/hooks/features/games/useGameCategorySourceAssignment";
import {
	type BulkImportMode,
	useBulkGameAddActions,
} from "@/hooks/features/games/useGameMetadataFacade";
import { useAllSettings } from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { fileService } from "@/services/invoke";
import { getEnabledMixedSources, useStore } from "@/store/appStore";
import { useModStore } from "@/store/modStore";
import type { apiSourceType, GameCandidateData, ScanResult, SourceType } from "@/types";
import {
	createAbortableRunner,
	handleGetFolder,
	isAbortError,
} from "@/utils/appUtils";
import { isBgmAuthExpiredError, withBgmAuth } from "@/utils/bgmAuthSession";
import { getUserErrorMessage } from "@/utils/errors";
import BulkImportResultTable from "./BulkImportResultTable";
import GameSelectDialog from "./GameSelectDialog";
import MixedSourceConfirmDialog from "./MixedSourceConfirmDialog";

export interface ImportItem extends ScanResult {
	status:
		| "pending"
		| "matched"
		| "imported"
		| "error"
		| "not found"
		| "duplicate";
	matchedData?: GameCandidateData;
	selectedExe?: string;
	duplicateMessage?: string;
	duplicateGroupId?: string;
	errorMessage?: string;
	errorPhase?: "preparation" | "insertion" | "request";
	importMode?: BulkImportMode;
	launch_type?: "steam";
	steam_launch_id?: string;
	steam_monitor_path?: string;
}

export interface BulkDropBatch {
	id: number;
	paths: string[];
}

function getBulkItemIdentities(item: ImportItem): string[] {
	const identities: string[] = [];
	if (item.steam_launch_id) {
		identities.push(`steam:${item.steam_launch_id}`);
	}
	if (item.path && !item.path.startsWith("steam:")) {
		const normalizedPath = item.path
			.trim()
			.replace(/[\\/]+/g, "/")
			.replace(/\/$/, "")
			.toLocaleLowerCase();
		if (normalizedPath) identities.push(`local:${normalizedPath}`);
	}
	return identities;
}

function normalizeScanPath(path: string) {
	return path.trim().replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();
}

function resetBatchDuplicateGroup(
	items: ImportItem[],
	groupId: string | undefined,
): ImportItem[] {
	if (!groupId) return items;
	return items.map((item) =>
		item.duplicateGroupId === groupId && item.status === "duplicate"
			? {
					...item,
					status: item.matchedData ? "matched" : "pending",
					duplicateMessage: undefined,
					duplicateGroupId: undefined,
				}
			: item,
	);
}

interface BulkImportTabProps {
	open: boolean;
	// 控制此 tab 是否隐藏（通过 CSS display:none 而非卸载）
	hidden: boolean;
	onClose: () => void;
	dropBatch?: BulkDropBatch;
	onDropBatchHandled?: (batchId: number) => void;
}

const BulkImportTab = ({
	open,
	hidden,
	onClose,
	dropBatch,
	onDropBatchHandled,
}: BulkImportTabProps) => {
	const { t } = useTranslation();
	const defaultScanRoots = useModStore((state) => state.gameScanRoots);
	const { data: settings } = useAllSettings();
	const hasBgmAuth = Boolean(settings?.bgm_auth);
	const { mixedEnableYmgal, mixedEnableKun, mixedEnableDlsite } = useStore(
		useShallow((s) => ({
			mixedEnableYmgal: s.mixedEnableYmgal,
			mixedEnableKun: s.mixedEnableKun,
			mixedEnableDlsite: s.mixedEnableDlsite,
		})),
	);
	const {
		addGamesFromBulkImport,
		findBulkImportDuplicates,
		isAddingGames,
	} = useBulkGameAddActions();
	const { assignImportedGames } = useGameCategorySourceAssignment();
	const preferredApiSource = hasBgmAuth ? "bgm" : "vndb";
	const enabledMixedSources = getEnabledMixedSources({
		mixedEnableYmgal,
		mixedEnableKun,
		mixedEnableDlsite,
	});

	const [isScanningDirectories, setIsScanningDirectories] = useState(false);
	const [isScanningSteam, setIsScanningSteam] = useState(false);
	const [isMatchingMetadata, setIsMatchingMetadata] = useState(false);
	const [rootPath, setRootPath] = useState("");
	const [activeScanRoots, setActiveScanRoots] = useState<string[]>([]);
	const [activeScanContextRoots, setActiveScanContextRoots] = useState<string[]>([]);
	const [isLocalDirectoryScan, setIsLocalDirectoryScan] = useState(false);
	const [scanMode, setScanMode] = useState<
		"executable" | "first_level_directory"
	>("executable");
	const [scanDepth, setScanDepth] = useState(5);
	const [scanSettingsAnchorEl, setScanSettingsAnchorEl] =
		useState<HTMLElement | null>(null);
	const [items, setItems] = useState<ImportItem[]>([]);
	const [unscannedDirectories, setUnscannedDirectories] = useState<
		Array<{ name: string; path: string; reason?: string }>
	>([]);
	const [scanWarnings, setScanWarnings] = useState<string[]>([]);
	const [dropIssues, setDropIssues] = useState<
		Array<{ path: string; message: string }>
	>([]);
	const [editItemPath, setEditItemPath] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [editApiSource, setEditApiSource] = useState<apiSourceType>("bgm");
	const [batchApiSource, setBatchApiSource] = useState<SourceType>(preferredApiSource);
	const [customImportConfirmOpen, setCustomImportConfirmOpen] = useState(false);
	const wasOpenRef = useRef(open);
	const editSearchAbortControllerRef = useRef<AbortController | null>(null);
	const matchAbortControllerRef = useRef<AbortController | null>(null);
	const itemsRef = useRef(items);
	const processingDropBatchIdRef = useRef<number | null>(null);
	const dropSessionRef = useRef(0);
	const activeOpenRef = useRef(open);
	const defaultRootsScanSessionRef = useRef(0);
	const loading =
		isMatchingMetadata || isScanningDirectories || isScanningSteam || isAddingGames;
	const matchedImportCount = items.filter(
		(item) =>
			item.status !== "imported" &&
			item.status !== "duplicate" &&
			Boolean(item.matchedData),
	).length;
	const customImportCount = items.filter(
		(item) =>
			item.status !== "imported" &&
			item.status !== "duplicate" &&
			(!item.matchedData || item.importMode === "custom"),
	).length;

	useEffect(() => {
		itemsRef.current = items;
	}, [items]);

	useEffect(() => {
		if (!hasBgmAuth && batchApiSource === "bgm") {
			setBatchApiSource("vndb");
		}
	}, [batchApiSource, hasBgmAuth]);

	useEffect(() => {
		activeOpenRef.current = open;
		if (!open) {
			dropSessionRef.current++;
			processingDropBatchIdRef.current = null;
		}
	}, [open]);

	const handleResolvedEditMetadata = useCallback(
		async (resolvedData: GameCandidateData) => {
			if (!editItemPath) return;

			setItems((prevItems) => {
				let nextItems = [...prevItems];
				const itemIndex = nextItems.findIndex(
					(item) => item.path === editItemPath,
				);
				if (itemIndex !== -1) {
					nextItems = resetBatchDuplicateGroup(
						nextItems,
						nextItems[itemIndex].duplicateGroupId,
					);
					const refreshedItemIndex = nextItems.findIndex(
						(item) => item.path === editItemPath,
					);
					if (refreshedItemIndex === -1) return nextItems;
					nextItems[refreshedItemIndex].name = editName;
					nextItems[refreshedItemIndex].matchedData = resolvedData;
					nextItems[refreshedItemIndex].status = "matched";
					nextItems[refreshedItemIndex].duplicateMessage = undefined;
					nextItems[refreshedItemIndex].duplicateGroupId = undefined;
					nextItems[refreshedItemIndex].errorMessage = undefined;
					nextItems[refreshedItemIndex].errorPhase = undefined;
					nextItems[refreshedItemIndex].importMode = undefined;
				}
				return nextItems;
			});
			setEditItemPath(null);
		},
		[editItemPath, editName],
	);

	const metadataSearchFlow = useMetadataSearchFlow({
		mixedEnabledSources: enabledMixedSources,
		t,
		onResolved: handleResolvedEditMetadata,
		onError: (message) => snackbar.error(message),
		getNoResultsMessage: () =>
			t("components.AddModal.noResults", "没有找到结果"),
	});
	const searchResultLoading = metadataSearchFlow.isSearching;

	const resetState = useCallback(() => {
		if (editSearchAbortControllerRef.current) {
			editSearchAbortControllerRef.current.abort();
			editSearchAbortControllerRef.current = null;
		}
		if (matchAbortControllerRef.current) {
			matchAbortControllerRef.current.abort();
			matchAbortControllerRef.current = null;
		}
		setIsMatchingMetadata(false);
		setIsScanningSteam(false);
		setRootPath("");
		setActiveScanRoots([]);
		setActiveScanContextRoots([]);
		setIsLocalDirectoryScan(false);
		setScanMode("executable");
		setScanDepth(5);
		setScanSettingsAnchorEl(null);
		setItems([]);
		setUnscannedDirectories([]);
		setScanWarnings([]);
		setDropIssues([]);
		setEditItemPath(null);
		setEditName("");
		setEditApiSource(preferredApiSource);
		setCustomImportConfirmOpen(false);
		metadataSearchFlow.reset();
	}, [metadataSearchFlow, preferredApiSource]);

	useEffect(() => {
		if (wasOpenRef.current && !open) {
			resetState();
		}
		wasOpenRef.current = open;
	}, [open, resetState]);

	const handleCloseEditDialog = useCallback(() => {
		if (editSearchAbortControllerRef.current) {
			editSearchAbortControllerRef.current.abort();
			editSearchAbortControllerRef.current = null;
		}

		metadataSearchFlow.reset();
		setEditItemPath(null);
	}, [metadataSearchFlow]);

	const handleCancel = useCallback(() => {
		if (isMatchingMetadata && matchAbortControllerRef.current) {
			matchAbortControllerRef.current.abort();
			snackbar.info(
				t("components.BulkImportModal.matchCancelled", "已取消匹配任务"),
			);
			return;
		}

		onClose();
	}, [isMatchingMetadata, onClose, t]);

	const scanRoots = async (
		roots: string[],
		label: string,
		scanContextRoots: string[] = [],
	) => {
		if (!roots.length) return;
		setRootPath(label);
		setActiveScanRoots(roots);
		setActiveScanContextRoots(scanContextRoots);
		setIsLocalDirectoryScan(true);
		setDropIssues([]);
		setScanWarnings([]);
		setIsScanningDirectories(true);
		try {
			const settled = await Promise.allSettled(
				roots.map((path) =>
					fileService.scanDirectoryForGames(
						path,
						scanDepth,
						scanMode,
						scanContextRoots,
					),
				),
			);
			const candidates = settled.flatMap((entry) => entry.status === "fulfilled" ? entry.value.candidates : []);
			const unscanned = settled.flatMap((entry) => entry.status === "fulfilled" ? entry.value.unscanned_directories : []);
			const warnings = settled.flatMap((entry, index) => entry.status === "rejected" ? [`${roots[index]}：${getUserErrorMessage(entry.reason, t)}`] : []);
			const seenCandidates = new Set<string>();
			const uniqueCandidates = candidates.filter((candidate) => {
				const key = normalizeScanPath(candidate.path);
				if (seenCandidates.has(key)) return false;
				seenCandidates.add(key);
				return true;
			});
			const seenDirectories = new Set<string>();
			const uniqueUnscanned = unscanned.filter((directory) => {
				const key = normalizeScanPath(directory.path);
				if (seenDirectories.has(key) || seenCandidates.has(key)) return false;
				seenDirectories.add(key);
				return true;
			});
			setItems(
				uniqueCandidates.map((dir) => ({
					...dir,
					status: "pending",
					selectedExe:
						dir.executables.length > 0 ? dir.executables[0] : undefined,
				})),
			);
			setUnscannedDirectories(uniqueUnscanned);
			setScanWarnings(warnings);
			if (!uniqueCandidates.length && warnings.length === roots.length) {
				snackbar.error("默认扫描根目录均无法读取");
			}
		} finally {
			setIsScanningDirectories(false);
		}
	};

	const scanFolder = async () => {
		const result = await handleGetFolder();
		if (!result) return;
		await scanRoots([result], result);
	};

	useEffect(() => {
		if (!open || hidden || !defaultScanRoots.length || defaultRootsScanSessionRef.current) return;
		defaultRootsScanSessionRef.current = 1;
		const roots = defaultScanRoots.map((root) => root.path);
		void scanRoots(roots, `默认扫描根目录（${roots.length} 个）`, roots);
	}, [defaultScanRoots, hidden, open]);

	useEffect(() => {
		if (!open) defaultRootsScanSessionRef.current = 0;
	}, [open]);

	const scanSteamLibrary = async () => {
		setIsScanningSteam(true);
		try {
			const result = await fileService.scanSteamLaunchTargets(true);
			setRootPath("Steam");
			setActiveScanRoots([]);
			setActiveScanContextRoots([]);
			setIsLocalDirectoryScan(false);
			setUnscannedDirectories([]);
			setScanWarnings([]);
			setDropIssues([]);
			setItems(
				result.targets.map((target) => ({
					name: target.name,
					path: target.localpath || `steam:${target.steam_launch_id}`,
					executables: [],
					status: "pending",
					launch_type: "steam",
					steam_launch_id: target.steam_launch_id,
					steam_monitor_path: target.localpath,
				})),
			);
			if (result.warnings.length > 0) {
				snackbar.warning(result.warnings[0]);
			}
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		} finally {
			setIsScanningSteam(false);
		}
	};

	useEffect(() => {
		if (
			!open ||
			!dropBatch ||
			loading ||
			processingDropBatchIdRef.current !== null
		) {
			return;
		}

		processingDropBatchIdRef.current = dropBatch.id;
		const dropSession = dropSessionRef.current;
		const resolveDroppedPaths = async () => {
			setIsScanningDirectories(true);
			try {
				const result = await fileService.resolveBulkImportPaths(dropBatch.paths);
				if (
					!activeOpenRef.current ||
					dropSessionRef.current !== dropSession
				) {
					return;
				}
				const currentItems = itemsRef.current;
				const existingIdentities = new Set(
					currentItems.flatMap(getBulkItemIdentities),
				);
				const duplicateIssues: Array<{ path: string; message: string }> = [];
				const addedItems: ImportItem[] = [];

				for (const candidate of result.candidates) {
					const item: ImportItem = {
						name: candidate.name,
						path: candidate.path,
						executables: candidate.executables,
						selectedExe: candidate.selected_exe,
						status: "pending",
						launch_type: candidate.launch_type,
						steam_launch_id: candidate.steam_launch_id,
						steam_monitor_path: candidate.steam_monitor_path,
					};
					const identities = getBulkItemIdentities(item);
					if (identities.some((identity) => existingIdentities.has(identity))) {
						duplicateIssues.push({
							path: candidate.path,
							message: t(
								"components.BulkImportModal.duplicateInCurrentList",
								"该游戏已在当前批量列表中",
							),
						});
						continue;
					}
					identities.forEach((identity) => existingIdentities.add(identity));
					addedItems.push(item);
				}

				if (addedItems.length > 0) {
					const nextItems = [...currentItems, ...addedItems];
					itemsRef.current = nextItems;
					setItems(nextItems);
					if (!rootPath) {
						setRootPath(
							t("components.BulkImportModal.draggedPaths", "已拖入 {{count}} 项", {
								count: dropBatch.paths.length,
							}),
						);
					}
				}

				const issues = [...result.issues, ...duplicateIssues];
				if (issues.length > 0) {
					setDropIssues((current) => [...current, ...issues]);
					snackbar.warning(
						t(
							"components.BulkImportModal.dropIssuesSummary",
							"已跳过 {{count}} 项，请查看列表中的原因",
							{ count: issues.length },
						),
					);
				} else if (addedItems.length > 0) {
					snackbar.success(
						t(
							"components.BulkImportModal.dropAddedSummary",
							"已添加 {{count}} 个批量导入候选",
							{ count: addedItems.length },
						),
					);
				}
			} catch (error) {
				if (
					activeOpenRef.current &&
					dropSessionRef.current === dropSession
				) {
					snackbar.error(getUserErrorMessage(error, t));
				}
			} finally {
				if (dropSessionRef.current === dropSession) {
					setIsScanningDirectories(false);
					onDropBatchHandled?.(dropBatch.id);
					processingDropBatchIdRef.current = null;
				}
			}
		};
		void resolveDroppedPaths();
	}, [dropBatch, loading, onDropBatchHandled, open, rootPath, t]);

	const handleMatchMetadata = async () => {
		if (batchApiSource === "bgm" && !hasBgmAuth) {
			snackbar.warning(t("components.BulkImportModal.bgmAuthRequired", "请先登录 Bangumi 后再匹配"));
			return;
		}
		if (matchAbortControllerRef.current) {
			matchAbortControllerRef.current.abort();
		}

		const { controller, withAbort } = createAbortableRunner();
		matchAbortControllerRef.current = controller;

		setIsMatchingMetadata(true);
		const nextItems = [...items];

		try {
			for (let index = 0; index < nextItems.length; index++) {
				if (controller.signal.aborted) {
					break;
				}

				if (
					nextItems[index].matchedData ||
					nextItems[index].status === "imported" ||
					nextItems[index].status === "duplicate"
				) continue;

				try {
					const searchResults =
						batchApiSource === "bgm"
							? await withBgmAuth(
									(token) =>
										withAbort(
											gameMetadataService.searchGames({
												query: nextItems[index].name,
												source: batchApiSource,
												bgmToken: token,
											}),
										),
									{ required: true },
								)
							: await withAbort(
									gameMetadataService.searchGames({
										query: nextItems[index].name,
									source: batchApiSource,
									}),
								);

					if (searchResults.length > 0) {
						let matchedData = searchResults[0];
						// DLsite 的名称搜索只返回列表缩略信息；批量匹配也必须取详情，
						// 否则导入后的封面会和手动匹配不一致。
						if (batchApiSource === "dlsite" && matchedData.dlsite_id) {
							const detailedData = await withAbort(
								gameMetadataService.getGameById(matchedData.dlsite_id, "dlsite"),
							);
							matchedData = { ...matchedData, ...detailedData };
						}
						nextItems[index].matchedData = matchedData;
						nextItems[index].status = "matched";
					} else {
						nextItems[index].status = "not found";
					}
				} catch (error) {
					if (isAbortError(error)) {
						break;
					}
					if (isBgmAuthExpiredError(error)) {
						break;
					}

					snackbar.warning(
						`${nextItems[index].name}: ${getUserErrorMessage(error, t)}`,
					);
					nextItems[index].status = "not found";
				}

				setItems([...nextItems]);
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
		} finally {
			if (matchAbortControllerRef.current === controller) {
				matchAbortControllerRef.current = null;
			}
			setIsMatchingMetadata(false);
		}
	};

	const importBulkItems = async (mode: BulkImportMode) => {
		if (loading) return;
		let nextItems = [...items];
		const requestedItemIndexes = nextItems
			.map((item, index) => ({ item, index }))
			.filter(({ item }) => {
				if (item.status === "imported" || item.status === "duplicate") {
					return false;
				}
				if (mode === "metadata") {
					return Boolean(item.matchedData);
				}
				return !item.matchedData || item.importMode === "custom";
			})
			.map(({ index }) => index);

		if (requestedItemIndexes.length === 0) return;

		let skipped = 0;
		if (mode === "metadata") {
			const requestedItems = requestedItemIndexes.map((index) => nextItems[index]);
			for (const duplicate of findBulkImportDuplicates(requestedItems)) {
				const itemIndex = requestedItemIndexes[duplicate.itemIndex];
				const groupItemIndexes = duplicate.groupItemIndices?.map(
					(index) => requestedItemIndexes[index],
				);
				const groupId = groupItemIndexes?.join(",");
				nextItems[itemIndex] = {
					...nextItems[itemIndex],
					status: "duplicate",
					duplicateGroupId: groupId,
					duplicateMessage: duplicate.kind === "library"
						? t(
								"components.BulkImportModal.duplicateInLibrary",
								"游戏库中已存在",
							)
						: duplicate.itemIndex === duplicate.duplicateOfItemIndex
							? t(
									"components.BulkImportModal.duplicateInBatchGroup",
									"与本次列表中的其它项目重复",
								)
							: t(
									"components.BulkImportModal.duplicateInBatch",
									"与本次列表第 {{index}} 项重复",
									{
										index:
											(requestedItemIndexes[
												duplicate.duplicateOfItemIndex ?? 0
											] ?? 0) + 1,
									},
								),
					errorMessage: undefined,
					errorPhase: undefined,
				};
				skipped++;
			}
		}

		const submittedItemIndexes = requestedItemIndexes.filter(
			(index) => nextItems[index].status !== "duplicate",
		);
		if (submittedItemIndexes.length === 0) {
			setItems(nextItems);
			snackbar.info(
				t(
					"components.BulkImportModal.importOutcomeSummary",
					"成功 {{success}} 项、跳过重复 {{skipped}} 项、失败 {{failed}} 项",
					{ success: 0, skipped, failed: 0 },
				),
			);
			return;
		}

		const submittedItems = submittedItemIndexes.map((index) => ({
			...nextItems[index],
			matchedData:
				mode === "custom" ? undefined : nextItems[index].matchedData,
			importMode: mode,
			duplicateMessage: undefined,
			duplicateGroupId: undefined,
			errorMessage: undefined,
			errorPhase: undefined,
		}));
		for (let index = 0; index < submittedItemIndexes.length; index++) {
			nextItems[submittedItemIndexes[index]] = submittedItems[index];
		}

		const result = await addGamesFromBulkImport(submittedItems);
		const categoryAssignment = await assignImportedGames(
			result.completedGames.map((completed) => ({
				gameId: completed.gameId,
				path: submittedItems[completed.itemIndex]?.launch_type === "steam"
					? undefined
					: submittedItems[completed.itemIndex]?.path,
			})),
		);
		let success = 0;
		let failed = 0;

		for (const preparationError of result.preparationErrors) {
			const itemIndex = submittedItemIndexes[preparationError.itemIndex];
			nextItems[itemIndex] = {
				...nextItems[itemIndex],
				status: "error",
				errorPhase: "preparation",
				errorMessage: preparationError.message,
			};
			failed++;
		}

		for (const restorationError of result.restorationErrors) {
			const itemIndex = submittedItemIndexes[restorationError.itemIndex];
			nextItems[itemIndex] = {
				...nextItems[itemIndex],
				status: "error",
				errorPhase: "insertion",
				errorMessage: restorationError.message,
			};
			failed++;
		}

		for (const itemIndex of result.restoredItemIndices) {
			const sourceItemIndex = submittedItemIndexes[itemIndex];
			nextItems[sourceItemIndex] = {
				...nextItems[sourceItemIndex],
				status: "imported",
				errorMessage: undefined,
				errorPhase: undefined,
			};
			success++;
		}

		if (result.batchResult) {
			const failedMessages = new Map(
				result.batchResult.errors.map((error) => [error.index, error.message]),
			);
			for (const { itemIndex, payloadIndex } of result.pendingPayloads) {
				const sourceItemIndex = submittedItemIndexes[itemIndex];
				if (failedMessages.has(payloadIndex)) {
					nextItems[sourceItemIndex] = {
						...nextItems[sourceItemIndex],
						status: "error",
						errorPhase: "insertion",
						errorMessage:
							failedMessages.get(payloadIndex) ||
							t("errors.unknownError", "未知错误"),
					};
					failed++;
				} else {
					nextItems[sourceItemIndex] = {
						...nextItems[sourceItemIndex],
						status: "imported",
						errorMessage: undefined,
						errorPhase: undefined,
					};
					success++;
				}
			}
		}

		if (result.mutationError) {
			for (const { itemIndex } of result.pendingPayloads) {
				const sourceItemIndex = submittedItemIndexes[itemIndex];
				nextItems[sourceItemIndex] = {
					...nextItems[sourceItemIndex],
					status: "error",
					errorPhase: "request",
					errorMessage: result.mutationError,
				};
				failed++;
			}
		}

		setItems(nextItems);
		const summary = t(
			"components.BulkImportModal.importOutcomeSummary",
			"成功 {{success}} 项、跳过重复 {{skipped}} 项、失败 {{failed}} 项",
			{ success, skipped, failed },
		);
		if (failed > 0) snackbar.warning(summary);
		else if (success > 0) snackbar.success(summary);
		else snackbar.info(summary);
		if (categoryAssignment.failed) {
			snackbar.warning(`${categoryAssignment.failed} 个游戏已导入，但未能加入已绑定的分类`);
		}
	};

	const handleEditRowSearch = async () => {
		if (!editName) return;

		if (editSearchAbortControllerRef.current) {
			editSearchAbortControllerRef.current.abort();
		}

		const { controller, withAbort } = createAbortableRunner();
		editSearchAbortControllerRef.current = controller;

		try {
			await metadataSearchFlow.searchMetadata({
				query: editName,
				source: editApiSource,
				withAbort,
			});
		} catch (error) {
			if (isAbortError(error)) {
				return;
			}

			snackbar.error(getUserErrorMessage(error, t));
			metadataSearchFlow.closeSearchResult();
		} finally {
			if (editSearchAbortControllerRef.current === controller) {
				editSearchAbortControllerRef.current = null;
			}
		}
	};

	const handleDeleteItem = (path: string) => {
		setItems((prevItems) => {
			const removedItem = prevItems.find((item) => item.path === path);
			const remainingItems = prevItems.filter((item) => item.path !== path);
			return resetBatchDuplicateGroup(
				remainingItems,
				removedItem?.duplicateGroupId,
			);
		});
	};

	const handleClearMatchedData = (path: string) => {
		setItems((previousItems) => {
			const currentItem = previousItems.find((item) => item.path === path);
			const nextItems = resetBatchDuplicateGroup(
				[...previousItems],
				currentItem?.duplicateGroupId,
			);
			return nextItems.map((item) =>
				item.path === path
					? {
							...item,
							matchedData: undefined,
							status: "pending",
							importMode: undefined,
							duplicateMessage: undefined,
							duplicateGroupId: undefined,
							errorMessage: undefined,
							errorPhase: undefined,
						}
					: item,
			);
		});
	};

	const handleEditRowSaveNameOnly = () => {
		if (!editItemPath) return;

		let nextItems = [...items];
		const itemIndex = nextItems.findIndex((item) => item.path === editItemPath);
		if (itemIndex !== -1) {
			nextItems = resetBatchDuplicateGroup(
				nextItems,
				nextItems[itemIndex].duplicateGroupId,
			);
			const refreshedItemIndex = nextItems.findIndex(
				(item) => item.path === editItemPath,
			);
			if (refreshedItemIndex === -1) return;
			nextItems[refreshedItemIndex].name = editName;
			if (
				nextItems[refreshedItemIndex].status === "not found" ||
				nextItems[refreshedItemIndex].status === "duplicate" ||
				nextItems[refreshedItemIndex].status === "error"
			) {
				nextItems[refreshedItemIndex].status = "pending";
			}
			nextItems[refreshedItemIndex].duplicateMessage = undefined;
			nextItems[refreshedItemIndex].duplicateGroupId = undefined;
			nextItems[refreshedItemIndex].errorMessage = undefined;
			nextItems[refreshedItemIndex].errorPhase = undefined;
			nextItems[refreshedItemIndex].importMode = undefined;
			setItems(nextItems);
		}

		setEditItemPath(null);
	};

	return (
		<>
			<Stack
				spacing={1.25}
					sx={{
					pt: 0.5,
					width: "100%",
					minWidth: 0,
					flex: "1 1 auto",
					height: "100%",
					minHeight: 0,
					overflow: "hidden",
					// 通过 CSS 控制显隐而非卸载，保持状态在 tab 切换时不丢失
					display: hidden ? "none" : undefined,
				}}
			>
				<Stack
					direction={{ xs: "column", sm: "row" }}
					spacing={1}
					alignItems={{ xs: "stretch", sm: "center" }}
				>
					<Button
						variant="contained"
						startIcon={<FolderOpenIcon />}
						onClick={() => void scanFolder()}
						disabled={loading}
						sx={{ flexShrink: 0 }}
					>
						{t("components.BulkImportModal.selectRootFolder", "选择根文件夹")}
					</Button>
					<Button
						variant="outlined"
						startIcon={<SportsEsportsIcon />}
						onClick={scanSteamLibrary}
						disabled={loading}
						sx={{ flexShrink: 0 }}
					>
						{t("components.BulkImportModal.scanSteam", "扫描 Steam 游戏")}
					</Button>
					<Tooltip title={rootPath || ""}>
						<Typography
							variant="body2"
							sx={{ flex: "1 1 180px", minWidth: 0, maxWidth: { sm: 320 } }}
							noWrap
						>
							{rootPath ||
								t("components.BulkImportModal.noFolderSelected", "未选择文件夹")}
						</Typography>
					</Tooltip>
					{items.length > 0 && (
						<Typography
							variant="body2"
							color="text.secondary"
							sx={{
								whiteSpace: "nowrap",
								alignSelf: { xs: "flex-start", sm: "auto" },
							}}
						>
							{t(
								"components.BulkImportModal.gamesCount",
								"共 {{count}} 个游戏",
								{
									count: items.length,
								},
							)}
						</Typography>
					)}
					{isLocalDirectoryScan && (
						<>
							<Tooltip title={t("components.BulkImportModal.scanSettings", "扫描设置")}>
								<IconButton
									aria-label={t("components.BulkImportModal.scanSettings", "扫描设置")}
									disabled={loading}
									onClick={(event) => setScanSettingsAnchorEl(event.currentTarget)}
								>
									<TuneIcon />
								</IconButton>
							</Tooltip>
							<Tooltip title={t("components.BulkImportModal.rescan", "重新扫描")}>
								<span>
									<IconButton
										aria-label={t("components.BulkImportModal.rescan", "重新扫描")}
										disabled={loading || activeScanRoots.length === 0}
										onClick={() =>
											void scanRoots(
												activeScanRoots,
												rootPath,
												activeScanContextRoots,
											)
										}
									>
										<RefreshIcon />
									</IconButton>
								</span>
							</Tooltip>
						</>
					)}
				</Stack>

				{isLocalDirectoryScan && (
					<Popover
						open={Boolean(scanSettingsAnchorEl)}
						anchorEl={scanSettingsAnchorEl}
						onClose={() => setScanSettingsAnchorEl(null)}
						anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
						transformOrigin={{ vertical: "top", horizontal: "left" }}
					>
						<Stack spacing={1.25} sx={{ p: 1.5, minWidth: 260 }}>
							<Stack direction="row" alignItems="center" justifyContent="space-between">
								<Typography variant="subtitle2">
									{t("components.BulkImportModal.scanSettings", "扫描设置")}
								</Typography>
								<Tooltip
									title={
										scanMode === "first_level_directory"
											? t(
												"components.BulkImportModal.firstLevelScanHint",
												"一级模式只列出含直属可用启动程序的文件夹。",
											)
											: t(
												"components.BulkImportModal.executableScanHint",
												"调整设置后，使用重新扫描生效。",
											)
									}
								>
									<IconButton size="small" aria-label={t("common.help", "帮助")}>
										<HelpOutlineIcon fontSize="small" />
									</IconButton>
								</Tooltip>
							</Stack>
						<FormControl size="small" disabled={loading} sx={{ minWidth: 172 }}>
							<InputLabel id="bulk-import-scan-mode-label">
								{t("components.BulkImportModal.scanMode", "扫描方式")}
							</InputLabel>
							<Select
								labelId="bulk-import-scan-mode-label"
								value={scanMode}
								label={t("components.BulkImportModal.scanMode", "扫描方式")}
								onChange={(event) =>
									setScanMode(
										event.target.value as
											| "executable"
											| "first_level_directory",
									)
								}
							>
								<MenuItem value="executable">
									{t(
										"components.BulkImportModal.scanModeExecutable",
										"深层扫描启动程序",
									)}
								</MenuItem>
								<MenuItem value="first_level_directory">
									{t(
										"components.BulkImportModal.scanModeFirstLevel",
										"一级目录扫描",
									)}
								</MenuItem>
							</Select>
						</FormControl>
						{scanMode === "executable" && (
							<FormControl size="small" disabled={loading} sx={{ minWidth: 140 }}>
								<InputLabel id="bulk-import-scan-depth-label">
									{t("components.BulkImportModal.scanDepth", "扫描深度")}
								</InputLabel>
								<Select
									labelId="bulk-import-scan-depth-label"
									value={scanDepth}
									label={t("components.BulkImportModal.scanDepth", "扫描深度")}
									onChange={(event) => setScanDepth(Number(event.target.value))}
								>
									{[2, 3, 4, 5].map((depth) => (
										<MenuItem key={depth} value={depth}>
											{t(
												"components.BulkImportModal.scanDepthValue",
												"{{depth}} 层",
												{ depth },
											)}
										</MenuItem>
									))}
								</Select>
							</FormControl>
						)}
						</Stack>
					</Popover>
				)}

				{unscannedDirectories.length > 0 && (
					<Alert severity="warning" variant="outlined">
						<Typography variant="body2" fontWeight={600}>
							{t(
								"components.BulkImportModal.unscannedDirectoriesTitle",
								"待核对文件夹（{{count}} 个）",
								{ count: unscannedDirectories.length },
							)}
						</Typography>
						<Typography variant="caption" color="text.secondary">
							{t(
								"components.BulkImportModal.unscannedDirectoriesHint",
								"这些一级文件夹没有已导入游戏，也没有扫描出可导入候选；它们不会被本次导入修改。",
							)}
						</Typography>
						<Box
							component="ul"
							sx={{
								m: "6px 0 0",
								pl: 2.5,
								maxHeight: 112,
								overflowY: "auto",
							}}
						>
							{unscannedDirectories.map((directory) => (
								<li key={directory.path} title={directory.path}>
									<Typography variant="caption">{directory.name}：{directory.reason ?? "未找到可用启动程序"}</Typography>
								</li>
							))}
						</Box>
					</Alert>
				)}

				{scanWarnings.length > 0 && (
					<Alert severity="warning" variant="outlined">
						<Typography variant="body2" fontWeight={600}>部分扫描根目录未完成</Typography>
						{scanWarnings.map((warning) => <Typography key={warning} variant="caption" display="block">{warning}</Typography>)}
					</Alert>
				)}

				{dropIssues.length > 0 && (
					<Alert severity="warning" variant="outlined">
						<Typography variant="body2" fontWeight={600}>
							{t(
								"components.BulkImportModal.dropIssuesTitle",
								"已跳过的拖入项（{{count}} 项）",
								{ count: dropIssues.length },
							)}
						</Typography>
						<Typography variant="caption" color="text.secondary">
							{t(
								"components.BulkImportModal.dropIssuesHint",
								"以下项目未加入候选列表，也没有写入游戏库。",
							)}
						</Typography>
						<Box
							component="ul"
							sx={{
								m: "6px 0 0",
								pl: 2.5,
								maxHeight: 128,
								overflowY: "auto",
							}}
						>
							{dropIssues.map((issue, index) => (
								<li key={`${issue.path}-${index}`} title={issue.path}>
									<Typography variant="caption" sx={{ wordBreak: "break-word" }}>
										{issue.message}
										{": "}
										{issue.path}
									</Typography>
								</li>
							))}
						</Box>
					</Alert>
				)}

				<BulkImportResultTable
					items={items}
					loading={loading}
					emptyMessage={
						isScanningDirectories
							? t("components.BulkImportModal.scanningFolders", "正在扫描游戏目录...")
							: isScanningSteam
								? t("components.BulkImportModal.scanningSteam", "正在扫描 Steam 游戏...")
								: t(
										"components.BulkImportModal.noGamesFound",
										"未找到可导入的游戏",
									)
					}
					onDeleteItem={handleDeleteItem}
					onEditItem={(item) => {
						setEditItemPath(item.path);
						setEditName(item.name);
						setEditApiSource(batchApiSource);
					}}
					onClearMatchedData={handleClearMatchedData}
					onExecutableChange={(path, selectedExe) => {
						setItems((currentItems) =>
							currentItems.map((item) =>
								item.path === path ? { ...item, selectedExe } : item,
							),
						);
					}}
					onOpenDirectory={(path) => {
						void fileService.openDirectory(path).catch((error) => {
							snackbar.error(
								t(
									"components.Snackbar.failedOpenGameFolder",
									"打开游戏文件夹失败",
								),
							);
							console.error("打开批量导入游戏目录失败:", error);
						});
					}}
				/>

				<Stack
					direction={{ xs: "column", md: "row" }}
					justifyContent="space-between"
					alignItems={{ xs: "stretch", md: "center" }}
					spacing={1.5}
				>
					<Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
						<Button
							onClick={resetState}
							disabled={loading || items.length === 0}
						>
							{t("components.BulkImportModal.reset", "重置")}
						</Button>
					</Stack>
					<Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
						<Button variant="outlined" onClick={handleCancel}>
							{t("components.BulkImportModal.cancel", "取消")}
						</Button>
						<FormControl size="small" sx={{ minWidth: 116 }} disabled={loading}>
							<Select
								value={batchApiSource}
								onChange={(event) => setBatchApiSource(event.target.value as SourceType)}
								inputProps={{ "aria-label": t("components.BulkImportModal.matchSource", "匹配数据源") }}
							>
								<MenuItem value="bgm" disabled={!hasBgmAuth}>Bangumi</MenuItem>
								<MenuItem value="vndb">VNDB</MenuItem>
								<MenuItem value="ymgal">YMGal</MenuItem>
								<MenuItem value="kun">Kun</MenuItem>
								<MenuItem value="dlsite">DLsite</MenuItem>
							</Select>
						</FormControl>
						<Button startIcon={<SearchIcon />} onClick={handleMatchMetadata} disabled={items.length === 0 || loading}>
							{t("components.BulkImportModal.matchMetadata", "匹配元数据")}
						</Button>
						<Button
							variant="contained"
							onClick={() => void importBulkItems("metadata")}
							disabled={matchedImportCount === 0 || loading}
							startIcon={loading ? <CircularProgress size={20} /> : undefined}
						>
							{t(
								"components.BulkImportModal.importMatched",
								"导入已匹配（{{count}}）",
								{ count: matchedImportCount },
							)}
						</Button>
						<Button
							variant="outlined"
							onClick={() => setCustomImportConfirmOpen(true)}
							disabled={customImportCount === 0 || loading}
						>
							{t(
								"components.BulkImportModal.importAsCustom",
								"导入为自定义（{{count}}）",
								{ count: customImportCount },
							)}
						</Button>
					</Stack>
				</Stack>
			</Stack>

			<Dialog
				open={!!editItemPath}
				onClose={handleCloseEditDialog}
				maxWidth="sm"
				fullWidth
			>
				<DialogTitle>
					{t("components.BulkImportModal.editMetadata", "编辑游戏信息")}
				</DialogTitle>
				<DialogContent>
					<Stack spacing={2} sx={{ mt: 1 }}>
						<TextField
							label={
								editApiSource === "mixed"
									? t("components.AddModal.gameName", "游戏名称")
									: `${t("components.AddModal.gameName", "游戏名称")} / ${t(
											"components.AddModal.gameIDTips",
											"游戏ID",
										)}`
							}
							value={editName}
							onChange={(event) => setEditName(event.target.value)}
							fullWidth
							size="small"
							disabled={searchResultLoading}
							onKeyDown={(event) => {
								if (
									event.key === "Enter" &&
									!event.nativeEvent.isComposing &&
									!searchResultLoading &&
									editName.trim()
								) {
									event.preventDefault();
									handleEditRowSearch();
								}
							}}
						/>
						<FormControl component="fieldset">
							<RadioGroup
								row
								value={editApiSource}
								onChange={(event) =>
									setEditApiSource(event.target.value as apiSourceType)
								}
							>
								<FormControlLabel
									value="bgm"
									control={<Radio />}
									label="Bangumi"
									disabled={searchResultLoading}
								/>
								<FormControlLabel
									value="vndb"
									control={<Radio />}
									label="VNDB"
									disabled={searchResultLoading}
								/>
								<FormControlLabel
									value="ymgal"
									control={<Radio />}
									label="YMGal"
									disabled={searchResultLoading}
								/>
								<FormControlLabel
									value="kun"
									control={<Radio />}
									label="Kun"
									disabled={searchResultLoading}
								/>
								<FormControlLabel
									value="dlsite"
									control={<Radio />}
									label="DLsite"
									disabled={searchResultLoading}
								/>
								<FormControlLabel
									value="mixed"
									control={<Radio />}
									label="Mixed"
									disabled={searchResultLoading}
								/>
							</RadioGroup>
						</FormControl>
					</Stack>
				</DialogContent>
				<DialogActions>
					<Button onClick={handleCloseEditDialog}>
						{t("components.BulkImportModal.cancel", "取消")}
					</Button>
					<Button
						onClick={handleEditRowSaveNameOnly}
						disabled={searchResultLoading}
					>
						{t("components.BulkImportModal.saveNameOnly", "仅保存名称")}
					</Button>
					<Button
						variant="contained"
						startIcon={
							searchResultLoading ? (
								<CircularProgress size={20} color="inherit" />
							) : (
								<SearchIcon />
							)
						}
						onClick={handleEditRowSearch}
						disabled={!editName || searchResultLoading}
					>
						{searchResultLoading
							? t("components.AddModal.processing", "处理中...")
							: t("components.BulkImportModal.search", "搜索")}
					</Button>
				</DialogActions>
			</Dialog>

			<GameSelectDialog
				open={metadataSearchFlow.searchResultState.open}
				onClose={metadataSearchFlow.closeSearchResult}
				results={metadataSearchFlow.searchResultState.results}
				onSelect={metadataSearchFlow.selectGame}
				loading={searchResultLoading}
				title={t("components.AddModal.selectGame", "选择游戏")}
				apiSource={metadataSearchFlow.searchResultState.apiSource}
			/>
			{metadataSearchFlow.mixedCandidateState.open && (
				<MixedSourceConfirmDialog
					open
					onClose={metadataSearchFlow.closeMixedCandidates}
					candidates={metadataSearchFlow.mixedCandidateState.candidates}
					onConfirm={metadataSearchFlow.confirmMixedSelection}
					loading={searchResultLoading}
					title={t("components.BulkImportModal.editMetadata", "编辑游戏信息")}
				/>
			)}
			<Dialog
				open={customImportConfirmOpen}
				onClose={() => setCustomImportConfirmOpen(false)}
				maxWidth="xs"
				fullWidth
			>
				<DialogTitle>
					{t(
						"components.BulkImportModal.importAsCustomConfirmTitle",
						"导入为自定义",
					)}
				</DialogTitle>
				<DialogContent>
					<Typography>
						{t(
							"components.BulkImportModal.importAsCustomConfirmMessage",
							"将把这 {{count}} 个项目作为自定义游戏导入，只保存名称和启动信息，不使用匹配元数据。是否继续？",
							{ count: customImportCount },
						)}
					</Typography>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setCustomImportConfirmOpen(false)}>
						{t("components.BulkImportModal.cancel", "取消")}
					</Button>
					<Button
						variant="contained"
						onClick={() => {
							setCustomImportConfirmOpen(false);
							void importBulkItems("custom");
						}}
						disabled={customImportCount === 0 || loading}
					>
						{t("common.confirm", "确认")}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
};

export default BulkImportTab;
