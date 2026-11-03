import ContentPasteIcon from "@mui/icons-material/ContentPaste";
import DeleteIcon from "@mui/icons-material/Delete";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PhotoCameraIcon from "@mui/icons-material/PhotoCamera";
import SaveIcon from "@mui/icons-material/Save";
import {
	Autocomplete,
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	FormControlLabel,
	IconButton,
	Stack,
	Switch,
	TextField,
	Typography,
} from "@mui/material";
import { basename } from "pathe";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useImagePreview } from "@/hooks/common/useImagePreview";
import { snackbar } from "@/providers/snackBar";
import { fileService } from "@/services/invoke";
import type { SteamLaunchTarget } from "@/services/invoke/fileService";
import type { GameData, UpdateGameParams } from "@/types";
import {
	cleanPathQuotes,
	getGameCover,
	getGameDisplayName,
	getGameNsfwStatus,
	handleExeFile,
} from "@/utils/appUtils";
import {
	deleteGameCustomCovers,
	selectImageFile,
	uploadSelectedImage,
} from "@/utils/customCover";
import { getUserErrorMessage, toError } from "@/utils/errors";
import { buildGameInfoUpdatePayload } from "@/utils/metadata";

// 公共样式常量
const CHIP_INPUT_BOX_SX = {
	display: "flex",
	flexWrap: "wrap",
	alignItems: "center",
	gap: 0.5,
	p: 1,
	border: "1px solid",
	borderColor: "divider",
	borderRadius: 1,
	minHeight: "42px",
	"&:focus-within": {
		borderWidth: "2px",
	},
} as const;

const CHIP_INPUT_STYLE = {
	border: "none",
	outline: "none",
	background: "transparent",
	flex: 1,
	minWidth: "120px",
	fontSize: "14px",
	padding: "4px",
	color: "inherit",
} as const;

function stringArraysEqual(
	current: string[],
	original: readonly string[] | null | undefined,
): boolean {
	const normalizedOriginal = original ?? [];
	if (current.length !== normalizedOriginal.length) {
		return false;
	}

	return current.every((value, index) => value === normalizedOriginal[index]);
}

interface GameInfoEditProps {
	selectedGame: GameData;
	onSave: (data: UpdateGameParams) => Promise<void>;
	disabled?: boolean;
}

export const GameInfoEdit: React.FC<GameInfoEditProps> = ({
	selectedGame,
	onSave,
	disabled = false,
}) => {
	const { t } = useTranslation();

	// 游戏信息编辑相关状态
	const [localPath, setLocalPath] = useState<string>("");
	const [launchType, setLaunchType] = useState<"local" | "steam">("local");
	const [steamLaunchId, setSteamLaunchId] = useState("");
	const [steamMonitorPath, setSteamMonitorPath] = useState("");
	const [steamTargets, setSteamTargets] = useState<SteamLaunchTarget[]>([]);
	const [steamDialogOpen, setSteamDialogOpen] = useState(false);
	const [isScanningSteam, setIsScanningSteam] = useState(false);
	const [gameNote, setGameNote] = useState<string>("");
	const [aliases, setAliases] = useState<string[]>([]);
	const [summary, setSummary] = useState<string>("");
	const [tags, setTags] = useState<string[]>([]);
	const [developer, setDeveloper] = useState<string>("");
	const [nsfw, setNsfw] = useState<boolean>(false);
	const [releaseDate, setReleaseDate] = useState<string>("");
	const [isLoading, setIsLoading] = useState(false);

	// 备用路径编辑状态
	const [extraLocalPaths, setExtraLocalPaths] = useState<string[]>([]);
	const [extraPathInput, setExtraPathInput] = useState<string>("");

	// 标签输入的临时状态
	const [aliasInput, setAliasInput] = useState<string>("");
	const [tagInput, setTagInput] = useState<string>("");

	// 使用自定义 Hook 管理图片预览
	const {
		selectedPath: selectedImagePath,
		previewUrl,
		selectImage,
		cleanup: cleanupPreview,
	} = useImagePreview();

	// 只删除由剪贴板导入生成的临时文件，绝不删除用户手动选择的原图。
	const [clipboardTempImagePath, setClipboardTempImagePathState] = useState<
		string | null
	>(null);
	const clipboardTempImagePathRef = useRef<string | null>(null);

	const setClipboardTempImagePath = useCallback((path: string | null) => {
		clipboardTempImagePathRef.current = path;
		setClipboardTempImagePathState(path);
	}, []);

	const cleanupClipboardTempImage = useCallback(async () => {
		const tempPath = clipboardTempImagePathRef.current;
		if (!tempPath) return;

		setClipboardTempImagePath(null);
		try {
			await fileService.deleteFile(tempPath);
		} catch (error) {
			console.warn("删除剪贴板临时封面失败:", error);
		}
	}, [setClipboardTempImagePath]);

	// 图片删除标记（不立即提交）
	const [shouldDeleteImage, setShouldDeleteImage] = useState(false);

	// 添加临时封面状态，用于平滑过渡
	const [tempCoverUrl, setTempCoverUrl] = useState<string | null>(null);
	// 保存后等待父级数据刷新期间，锁定新封面，避免闪回旧封面
	const [pendingCoverImage, setPendingCoverImage] = useState<string | null>(
		null,
	);

	// 1. 提取初始化函数 - 仅在切换游戏时调用，保存后不会触发
	const gameIdRef = useRef<number | null>(null);
	const initForm = useCallback(
		(game: GameData) => {
			setLocalPath(game.localpath ?? "");
			setLaunchType(game.launch_type === "steam" ? "steam" : "local");
			setSteamLaunchId(game.steam_launch_id ?? "");
			setSteamMonitorPath(game.steam_monitor_path ?? "");
			setGameNote(getGameDisplayName(game));
			setAliases(game.custom_data?.aliases ?? []);
			setSummary(game.summary ?? "");
			setTags(game.custom_data?.tags ?? []);
			setDeveloper(game.developer ?? "");
			setNsfw(getGameNsfwStatus(game) ?? false);
			setReleaseDate(game.date ?? "");
			setExtraLocalPaths(game.custom_data?.extraLocalPaths ?? []);
			setExtraPathInput("");
			setShouldDeleteImage(false);
			cleanupPreview();
		},
		[cleanupPreview],
	);

	// 仅在切换游戏时重置所有表单状态，不因保存后的 prop 变化而重置
	// 首次挂载时 gameIdRef 为 null，确保 initForm 执行
	useEffect(() => {
		if (gameIdRef.current !== selectedGame.id) {
			void cleanupClipboardTempImage();
			gameIdRef.current = selectedGame.id;
			initForm(selectedGame);
		}
	}, [selectedGame.id, initForm, cleanupClipboardTempImage]);

	useEffect(
		() => () => {
			void cleanupClipboardTempImage();
		},
		[cleanupClipboardTempImage],
	);

	// 当父级数据（selectedGame）已经更新到最新封面时，解除临时封面锁定
	useEffect(() => {
		if (!pendingCoverImage) return;
		if (selectedGame.custom_data?.image === pendingCoverImage) {
			setPendingCoverImage(null);
			setTempCoverUrl(null);
		}
	}, [pendingCoverImage, selectedGame.custom_data?.image]);

	// 检查是否有任何更改
	// 重要：比较时必须使用"展平后的原始值"作为基准，与初始化时一致
	const hasChanges = () => {
		// 获取展平后的原始值（与 useEffect 初始化时一致）
		const currentDisplayName = getGameDisplayName(selectedGame);
		const currentCustomName =
			selectedGame.custom_data?.name || currentDisplayName;
		const originalSummary = selectedGame.summary ?? "";
		const originalDeveloper = selectedGame.developer ?? "";
		const originalNsfw = getGameNsfwStatus(selectedGame) ?? false;
		const originalDate = selectedGame.date ?? "";

		return (
			localPath !== (selectedGame.localpath ?? "") ||
			launchType !== (selectedGame.launch_type ?? "local") ||
			(launchType === "steam" &&
				(steamLaunchId !== (selectedGame.steam_launch_id ?? "") ||
					steamMonitorPath !== (selectedGame.steam_monitor_path ?? ""))) ||
			gameNote !== currentCustomName ||
			selectedImagePath !== null || // 有选择的图片但未保存
			shouldDeleteImage ||
			!stringArraysEqual(aliases, selectedGame.custom_data?.aliases) ||
			summary !== originalSummary ||
			!stringArraysEqual(tags, selectedGame.custom_data?.tags) ||
			developer !== originalDeveloper ||
			nsfw !== originalNsfw ||
			releaseDate !== originalDate ||
			!stringArraysEqual(extraLocalPaths, selectedGame.custom_data?.extraLocalPaths) ||
			extraPathInput.trim() !== "" // 备用路径输入框有未添加的内容
		);
	};

	// 处理选择可执行文件路径
	const handleSelectLocalPath = async () => {
		try {
			const selectedPath = await handleExeFile();
			if (selectedPath) {
				setLocalPath(cleanPathQuotes(selectedPath));
			}
		} catch (error) {
			snackbar.error(
				`${t("pages.Detail.GameInfoEdit.selectPathFailed", "选择路径失败")}: ${getUserErrorMessage(error, t)}`,
			);
		}
	};

	const handleOpenSteamAssociation = async () => {
		setIsScanningSteam(true);
		try {
			const result = await fileService.scanSteamLaunchTargets(false);
			setSteamTargets(result.targets);
			setSteamDialogOpen(true);
			if (result.warnings.length > 0) snackbar.warning(result.warnings[0]);
		} catch (error) {
			snackbar.error(
				`${t("pages.Detail.GameInfoEdit.scanSteamFailed", "扫描 Steam 游戏失败")}: ${getUserErrorMessage(error, t)}`,
			);
		} finally {
			setIsScanningSteam(false);
		}
	};

	// 处理自定义封面文件选择 - 只选择，不立即上传
	const handleCustomCoverSelect = async () => {
		try {
			// 选择图片文件
			const imagePath = await selectImageFile();
			if (!imagePath) return;
			await cleanupClipboardTempImage();

			// 重置删除标记，因为用户选择了新图片
			setShouldDeleteImage(false);

			// 使用 Hook 提供的方法加载预览（现在是同步的）
			selectImage(imagePath);
		} catch (error) {
			snackbar.error(
				`${t("pages.Detail.GameInfoEdit.selectImageFailed", "选择图片失败")}: ${getUserErrorMessage(error, t)}`,
			);
		}
	};

	const getClipboardImageImportErrorMessage = (error: unknown) => {
		const rawMessage = toError(error).message;
		if (rawMessage.includes("CLIPBOARD_IMAGE_NOT_FOUND")) {
			return t(
				"pages.Detail.GameInfoEdit.clipboardImageNotFound",
				"剪贴板中没有可用图片",
			);
		}
		if (rawMessage.includes("CLIPBOARD_IMAGE_WRITE_FAILED")) {
			return t(
				"pages.Detail.GameInfoEdit.clipboardImageProcessFailed",
				"处理剪贴板图片失败",
			);
		}
		return `${t(
			"pages.Detail.GameInfoEdit.clipboardImageReadFailed",
			"读取剪贴板图片失败",
		)}: ${getUserErrorMessage(error, t)}`;
	};

	const handleClipboardImageImport = async () => {
		try {
			const tempPath = await fileService.importClipboardImageToTemp(
				selectedGame.id,
			);
			await cleanupClipboardTempImage();
			setClipboardTempImagePath(tempPath);
			setShouldDeleteImage(false);
			selectImage(tempPath);
		} catch (error) {
			snackbar.error(getClipboardImageImportErrorMessage(error));
		}
	};

	// 获取当前要显示的封面URL
	const getCurrentCoverUrl = () => {
		// 如果标记为删除，显示原始默认封面（无自定义）
		if (shouldDeleteImage) {
			// 返回不含 custom_data.image 的封面
			return getGameCover({
				...selectedGame,
				custom_data: { ...selectedGame.custom_data, image: undefined },
			});
		}

		// 如果有临时封面，优先使用（用于平滑过渡）
		if (tempCoverUrl) {
			return tempCoverUrl;
		}

		// 如果有预览URL（选择了本地文件）
		if (previewUrl) return previewUrl;

		// 最后使用实际封面
		return getGameCover(selectedGame);
	};

	// 处理删除自定义封面（标记删除，不立即提交）
	const handleRemoveCustomCover = () => {
		void cleanupClipboardTempImage();
		setShouldDeleteImage(true);
		cleanupPreview();
	};

	// 添加别名
	const handleAddAlias = () => {
		const trimmed = aliasInput.trim();
		if (trimmed && !aliases.includes(trimmed)) {
			setAliases([...aliases, trimmed]);
			setAliasInput("");
		}
	};

	// 删除别名
	const handleDeleteAlias = (alias: string) => {
		setAliases(aliases.filter((a) => a !== alias));
	};

	// 别名输入键盘事件
	const handleAliasKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleAddAlias();
		} else if (
			e.key === "Backspace" &&
			aliasInput === "" &&
			aliases.length > 0
		) {
			// 退格键删除最后一个标签
			e.preventDefault();
			setAliases(aliases.toSpliced(-1));
		}
	};

	// 添加标签
	const handleAddTag = () => {
		const trimmed = tagInput.trim();
		if (trimmed && !tags.includes(trimmed)) {
			setTags([...tags, trimmed]);
			setTagInput("");
		}
	};

	// 删除标签
	const handleDeleteTag = (tag: string) => {
		setTags(tags.filter((t) => t !== tag));
	};

	// 标签输入键盘事件
	const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleAddTag();
		} else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
			// 退格键删除最后一个标签
			e.preventDefault();
			setTags(tags.toSpliced(-1));
		}
	};

	// 统一保存所有更改
	const handleSaveAll = async () => {
		if (!hasChanges()) return;
		if (launchType === "steam" && (!steamLaunchId || !steamMonitorPath)) {
			snackbar.error(
				t(
					"pages.Detail.GameInfoEdit.steamAssociationRequired",
					"请先选择一个可监控的 Steam 游戏",
				),
			);
			return;
		}

		setIsLoading(true);

		try {
			// 如果备用路径输入框有内容，先加入列表
			const trimmedExtraInput = cleanPathQuotes(extraPathInput.trim());
			const effectiveExtraPaths = trimmedExtraInput
				? [...extraLocalPaths, trimmedExtraInput]
				: extraLocalPaths;
			setExtraLocalPaths(effectiveExtraPaths);
			setExtraPathInput("");

			let uploadedImageExt: string | null | undefined;

			// 1. 先处理副作用：上传图片或删除图片
			if (shouldDeleteImage) {
				await deleteGameCustomCovers(selectedGame.id);
				uploadedImageExt = null; // 标记删除
			} else if (selectedImagePath) {
				// 上传本地选择的图片
				uploadedImageExt = await uploadSelectedImage(
					selectedGame.id,
					selectedImagePath,
				);
			}

			// 2. 纯逻辑：使用纯函数构建 Payload
			const updateData = buildGameInfoUpdatePayload(selectedGame, {
				newLocalPath: localPath,
				newLaunchType: launchType,
				newSteamLaunchId: steamLaunchId,
				newSteamMonitorPath: steamMonitorPath,
				newName: gameNote,
				newImageExt: uploadedImageExt,
				newAliases: aliases,
				newSummary: summary,
				newTags: tags,
				newDeveloper: developer,
				newNsfw: nsfw,
				newDate: releaseDate,
				newExtraLocalPaths: effectiveExtraPaths,
			});
			// 防御：没有任何字段需要更新时，不发请求
			if (Object.keys(updateData).length === 0) {
				return;
			}

			// 3. 执行保存
			await onSave(updateData);

			if (clipboardTempImagePath) {
				await cleanupClipboardTempImage();
			}

			// 4. 处理 UI 状态（乐观更新）
			if (uploadedImageExt && typeof uploadedImageExt === "string") {
				// 锁定新封面直到父级数据刷新，避免出现"旧图 -> 新图"的闪回
				setPendingCoverImage(uploadedImageExt);
				const newCoverUrl = getGameCover({
					...selectedGame,
					custom_data: {
						...selectedGame.custom_data,
						image: uploadedImageExt,
					},
				});
				setTempCoverUrl(newCoverUrl);
			} else if (uploadedImageExt === null) {
				// 删除了封面
				setPendingCoverImage(null);
				setTempCoverUrl(null);
			}

			// 延迟清理预览状态，给新封面时间加载
			setTimeout(() => {
				cleanupPreview();
			}, 100);
		} catch (error) {
			snackbar.error(
				`${t("pages.Detail.GameInfoEdit.saveGameInfoFailed", "保存游戏信息失败")}: ${getUserErrorMessage(error, t)}`,
			);
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Box className="flex flex-col gap-3">
			{/* 封面和基本信息区域 - 放在最上面 */}
			<Card>
				<CardContent>
					<Typography variant="h6" gutterBottom>
						{t("pages.Detail.GameInfoEdit.coverAndBasicInfo", "封面与基本信息")}
					</Typography>

					<Stack direction={{ xs: "column", md: "row" }} spacing={3}>
						{/* 左侧：封面预览和操作 */}
						<Box className="flex-shrink-0">
							<img
								src={getCurrentCoverUrl()}
								alt="Game Cover"
								className="w-70 h-100 object-cover rounded-2 border border-gray-300"
							/>

							{/* 封面操作按钮 */}
							<Stack spacing={1} className="mt-2">
								<Stack direction="row" spacing={1} flexWrap="wrap">
									<Button
										variant="outlined"
										onClick={handleCustomCoverSelect}
										startIcon={<PhotoCameraIcon />}
										disabled={isLoading || disabled}
										size="small"
									>
										{t("pages.Detail.GameInfoEdit.selectImage", "选择图片")}
									</Button>

									<Button
										variant="outlined"
										onClick={handleClipboardImageImport}
										startIcon={<ContentPasteIcon />}
										disabled={isLoading || disabled}
										size="small"
									>
										{t(
											"pages.Detail.GameInfoEdit.importFromClipboard",
											"粘贴图片",
										)}
									</Button>

									{selectedGame.custom_data?.image && !shouldDeleteImage && (
										<Button
											variant="outlined"
											onClick={handleRemoveCustomCover}
											startIcon={<DeleteIcon />}
											disabled={isLoading || disabled}
											color="error"
											size="small"
										>
											{t(
												"pages.Detail.GameInfoEdit.removeCustomCover",
												"移除自定义封面",
											)}
										</Button>
									)}
								</Stack>
								{selectedGame.custom_data?.image &&
									!shouldDeleteImage &&
									!selectedImagePath && (
										<Typography variant="caption" color="textSecondary">
											{t(
												"pages.Detail.GameInfoEdit.hasCustomCover",
												"已设置自定义封面",
											)}
											: {selectedGame.custom_data.image}
										</Typography>
									)}

								{selectedImagePath && (
									<Typography variant="caption" color="primary">
										{selectedImagePath === clipboardTempImagePath
											? t(
													"pages.Detail.GameInfoEdit.clipboardPreviewSelected",
													"已粘贴图片，保存后生效",
												)
											: `${t(
													"pages.Detail.GameInfoEdit.previewSelected",
													"已选择新图片，保存后生效",
												)}: ${basename(selectedImagePath)}`}
									</Typography>
								)}
							</Stack>
						</Box>

						{/* 右侧：基本信息 */}
						<Stack spacing={3} sx={{ flex: 1 }}>
							{/* 自定义游戏名称 */}
							<Autocomplete
								freeSolo
								openOnFocus
								clearOnBlur={false}
								options={[
									...new Set(
										[selectedGame.aliases, selectedGame.all_titles]
											.flat()
											.filter(Boolean),
									),
								]}
								inputValue={gameNote}
								onInputChange={(_, value) => setGameNote(value)}
								onChange={(_, value) => {
									if (typeof value === "string") {
										setGameNote(value);
									}
								}}
								filterOptions={(options) => options}
								disabled={isLoading || disabled}
								fullWidth
								renderInput={(params) => (
									<TextField
										{...params}
										label={t(
											"pages.Detail.GameInfoEdit.customGameName",
											"自定义游戏名称",
										)}
										variant="outlined"
										placeholder={getGameDisplayName(selectedGame)}
									/>
								)}
							/>

							{/* 别名标签 - 在输入框内显示 */}
							<Box>
								<Typography variant="subtitle2" gutterBottom>
									{t("pages.Detail.GameInfoEdit.aliases", "别名")}
								</Typography>
								<Box
									sx={{
										...CHIP_INPUT_BOX_SX,
										"&:focus-within": {
											...CHIP_INPUT_BOX_SX["&:focus-within"],
											borderColor: "primary.main",
										},
									}}
								>
									{aliases.map((alias) => (
										<Chip
											key={alias}
											label={alias}
											onDelete={() => handleDeleteAlias(alias)}
											disabled={isLoading || disabled}
											color="primary"
											variant="outlined"
											size="small"
										/>
									))}
									<input
										type="text"
										value={aliasInput}
										onChange={(e) => setAliasInput(e.target.value)}
										onKeyDown={handleAliasKeyDown}
										placeholder={
											aliases.length === 0
												? t(
														"pages.Detail.GameInfoEdit.addAliasPlaceholder",
														"输入别名后按回车添加，退格键删除",
													)
												: ""
										}
										disabled={isLoading || disabled}
										style={CHIP_INPUT_STYLE}
									/>
								</Box>
							</Box>

							{/* 开发商 */}
							<TextField
								label={t("pages.Detail.GameInfoEdit.developer", "开发商")}
								variant="outlined"
								fullWidth
								value={developer}
								onChange={(e) => setDeveloper(e.target.value)}
								disabled={isLoading || disabled}
								placeholder={t(
									"pages.Detail.GameInfoEdit.developerPlaceholder",
									"多个开发商请使用 / 分隔",
								)}
								helperText={t(
									"pages.Detail.GameInfoEdit.developerHelperText",
									"例如：开发商A / 开发商B",
								)}
							/>

							{/* 发行日期 */}
							<TextField
								label={t("pages.Detail.GameInfoEdit.releaseDate", "发行日期")}
								variant="outlined"
								fullWidth
								type="date"
								value={releaseDate}
								onChange={(e) => setReleaseDate(e.target.value)}
								disabled={isLoading || disabled}
								InputLabelProps={{ shrink: true }}
								helperText={t(
									"pages.Detail.GameInfoEdit.releaseDateHelperText",
									"游戏的发行日期",
								)}
							/>

							{/* NSFW 开关 */}
							<Box>
								<FormControlLabel
									control={
										<Switch
											checked={nsfw}
											onChange={(e) => setNsfw(e.target.checked)}
											disabled={isLoading || disabled}
											color="warning"
										/>
									}
									label={t("pages.Detail.GameInfoEdit.nsfw", "NSFW (18+)")}
								/>
							</Box>
						</Stack>
					</Stack>
				</CardContent>
			</Card>

			{/* 简介和标签区域 */}
			<Card>
				<CardContent>
					<Typography variant="h6" gutterBottom>
						{t("pages.Detail.GameInfoEdit.descriptionAndTags", "简介与标签")}
					</Typography>

					<Stack spacing={3}>
						{/* 简介 - 可调整大小 */}
						<TextField
							label={t("pages.Detail.GameInfoEdit.summary", "游戏简介")}
							variant="outlined"
							fullWidth
							multiline
							minRows={4}
							maxRows={12}
							value={summary}
							onChange={(e) => setSummary(e.target.value)}
							disabled={isLoading || disabled}
							placeholder={t(
								"pages.Detail.GameInfoEdit.summaryPlaceholder",
								"请输入游戏简介",
							)}
							helperText={t(
								"pages.Detail.GameInfoEdit.summaryHelperText",
								"游戏的详细介绍（可拖动右下角调整大小）",
							)}
							InputProps={{
								sx: {
									"& textarea": {
										resize: "vertical",
										overflow: "auto !important",
									},
								},
							}}
						/>

						{/* 标签 - 在输入框内显示 */}
						<Box>
							<Typography variant="subtitle2" gutterBottom>
								{t("pages.Detail.GameInfoEdit.tags", "标签")}
							</Typography>
							<Box
								sx={{
									...CHIP_INPUT_BOX_SX,
									"&:focus-within": {
										...CHIP_INPUT_BOX_SX["&:focus-within"],
										borderColor: "primary.main",
									},
								}}
							>
								{tags.map((tag) => (
									<Chip
										key={tag}
										label={tag}
										onDelete={() => handleDeleteTag(tag)}
										disabled={isLoading || disabled}
										color="primary"
										variant="outlined"
										size="small"
									/>
								))}
								<input
									type="text"
									value={tagInput}
									onChange={(e) => setTagInput(e.target.value)}
									onKeyDown={handleTagKeyDown}
									placeholder={
										tags.length === 0
											? t(
													"pages.Detail.GameInfoEdit.addTagPlaceholder",
													"输入标签后按回车添加，退格键删除",
												)
											: ""
									}
									disabled={isLoading || disabled}
									style={CHIP_INPUT_STYLE}
								/>
							</Box>
						</Box>
					</Stack>
				</CardContent>
			</Card>

			{/* 启动方式与本地路径区域 */}
			<Card>
				<CardContent>
					<Typography variant="h6" gutterBottom>
						{t("pages.Detail.GameInfoEdit.gamePath", "启动方式与游戏路径")}
					</Typography>
					<FormControlLabel
						control={
							<Switch
								checked={launchType === "steam"}
								onChange={(_, checked) =>
									setLaunchType(checked ? "steam" : "local")
								}
								disabled={isLoading || disabled}
							/>
						}
						label={t("pages.Detail.GameInfoEdit.useSteamLaunch", "通过 Steam 启动")}
					/>
					{launchType === "steam" ? (
						<Stack spacing={1}>
							<Typography variant="body2" color="text.secondary">
								{steamLaunchId
									? `${t("pages.Detail.GameInfoEdit.steamAssociated", "已关联 Steam 启动项")}: ${steamLaunchId}`
									: t("pages.Detail.GameInfoEdit.steamNotAssociated", "尚未关联 Steam 启动项")}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								{t("pages.Detail.GameInfoEdit.steamAssociationHint", "选择 Steam 游戏后，原有本地路径与备用路径会保留，切回本地启动时仍可使用。")}
							</Typography>
							<Button
								variant="outlined"
								onClick={handleOpenSteamAssociation}
								disabled={isLoading || disabled || isScanningSteam}
								startIcon={isScanningSteam ? <CircularProgress size={16} /> : <FolderOpenIcon />}
							>
								{t("pages.Detail.GameInfoEdit.chooseSteamGame", "选择 Steam 游戏")}
							</Button>
						</Stack>
					) : (
					<Box className="flex gap-1">
						<TextField
							label={t("pages.Detail.GameInfoEdit.localPath", "可执行文件路径")}
							variant="outlined"
							fullWidth
							value={localPath}
							onChange={(e) => setLocalPath(cleanPathQuotes(e.target.value))}
							disabled={isLoading || disabled}
						/>
						<Button
							variant="outlined"
							onClick={handleSelectLocalPath}
							disabled={isLoading || disabled}
							className="min-w-10 px-1"
						>
							<FolderOpenIcon />
						</Button>
						</Box>
					)}
				</CardContent>
			</Card>

			{/* 备用启动路径只影响本地启动，Steam 关联时保留但不参与启动。 */}
			{launchType === "local" && <Card>
				<CardContent>
					<Typography variant="h6" gutterBottom>
						{t("pages.Detail.GameInfoEdit.extraPaths", "备用启动路径")}
					</Typography>
					<Typography variant="caption" color="text.secondary" className="block mb-2">
						{t("pages.Detail.GameInfoEdit.extraPathsHint", "主路径启动失败时自动尝试备用路径")}
					</Typography>
					<Stack spacing={1}>
						{extraLocalPaths.map((p, index) => (
							<Box key={index} className="flex gap-1 items-center">
								<TextField
									size="small"
									fullWidth
									value={p}
									onChange={(e) => {
										const val = cleanPathQuotes(e.target.value);
										setExtraLocalPaths(prev => prev.map((v, i) => i === index ? val : v));
									}}
									disabled={isLoading || disabled}
								/>
								<IconButton
									size="small"
									color="error"
									disabled={isLoading || disabled}
									onClick={() => {
										setExtraLocalPaths(prev => prev.filter((_, i) => i !== index));
									}}
								>
									<DeleteIcon />
								</IconButton>
							</Box>
						))}
						<Stack direction="row" spacing={1}>
							<TextField
								size="small"
								fullWidth
								value={extraPathInput}
								onChange={(e) => setExtraPathInput(cleanPathQuotes(e.target.value))}
								placeholder={t("pages.Detail.GameInfoEdit.extraPathPlaceholder", "输入或选择备用路径")}
								disabled={isLoading || disabled}
							/>
							<Button
								variant="outlined"
								onClick={async () => {
									const selectedPath = await handleExeFile();
									if (selectedPath) {
										const cleaned = cleanPathQuotes(selectedPath);
										if (cleaned) {
											setExtraLocalPaths(prev => [...prev, cleaned]);
										}
									}
								}}
								disabled={isLoading || disabled}
								className="min-w-10 px-1"
							>
								<FolderOpenIcon />
							</Button>
							<Button
								variant="contained"
								size="small"
								disabled={isLoading || disabled || !extraPathInput.trim()}
								onClick={() => {
									const cleaned = cleanPathQuotes(extraPathInput.trim());
									if (cleaned) {
										setExtraLocalPaths(prev => [...prev, cleaned]);
										setExtraPathInput("");
									}
								}}
							>
								{t("pages.Detail.GameInfoEdit.addPath", "添加")}
							</Button>
						</Stack>
					</Stack>
				</CardContent>
			</Card>}

			{/* 统一保存按钮 */}
			<Button
				variant="contained"
				color="primary"
				size="large"
				fullWidth
				onClick={handleSaveAll}
				disabled={isLoading || disabled || !hasChanges()}
				startIcon={
					isLoading ? (
						<CircularProgress size={20} color="inherit" />
					) : (
						<SaveIcon />
					)
				}
				className="mt-2"
			>
				{isLoading
					? t("pages.Detail.GameInfoEdit.saving", "保存中...")
					: t("pages.Detail.GameInfoEdit.saveAllChanges", "保存所有更改")}
			</Button>

			<Dialog
				open={steamDialogOpen}
				onClose={() => setSteamDialogOpen(false)}
				fullWidth
				maxWidth="sm"
			>
				<DialogTitle>{t("pages.Detail.GameInfoEdit.chooseSteamGame", "选择 Steam 游戏")}</DialogTitle>
				<DialogContent>
					<Autocomplete
						autoHighlight
						options={steamTargets}
						getOptionLabel={(target) => `${target.name} · ${target.steam_launch_id}`}
						onChange={(_, target) => {
							if (!target) return;
							setSteamLaunchId(target.steam_launch_id);
							setSteamMonitorPath(target.localpath ?? "");
							setSteamDialogOpen(false);
						}}
						renderInput={(params) => (
							<TextField
								{...params}
								label={t("pages.Detail.GameInfoEdit.steamGame", "Steam 游戏")}
								placeholder={t("pages.Detail.GameInfoEdit.searchSteamGame", "输入名称或启动 ID 搜索")}
							/>
						)}
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setSteamDialogOpen(false)}>
						{t("common.cancel", "取消")}
					</Button>
				</DialogActions>
			</Dialog>
		</Box>
	);
};
