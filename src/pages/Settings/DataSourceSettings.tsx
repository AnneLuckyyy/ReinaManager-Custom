import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import UpdateIcon from "@mui/icons-material/Update";
import {
	Accordion,
	AccordionDetails,
	AccordionSummary,
	Checkbox,
	CircularProgress,
	Divider,
	FormControlLabel,
	Switch,
	Tooltip,
	Typography,
} from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { snackbar } from "@/providers/snackBar";
import { SettingsHelp } from "@/components/SettingsHelp";
import { useStore } from "@/store/appStore";
import { isBgmAuthExpiredError } from "@/utils/bgmAuthSession";
import { getUserErrorMessage } from "@/utils/errors";

export const MixedSearchSourceSettings = () => {
	const { t } = useTranslation();
	const {
		mixedEnableYmgal,
		setMixedEnableYmgal,
		mixedEnableKun,
		setMixedEnableKun,
		mixedEnableDlsite,
		setMixedEnableDlsite,
	} = useStore(
		useShallow((s) => ({
			mixedEnableYmgal: s.mixedEnableYmgal,
			setMixedEnableYmgal: s.setMixedEnableYmgal,
			mixedEnableKun: s.mixedEnableKun,
			setMixedEnableKun: s.setMixedEnableKun,
			mixedEnableDlsite: s.mixedEnableDlsite,
			setMixedEnableDlsite: s.setMixedEnableDlsite,
		})),
	);

	return (
		<Box>
			<Stack direction="row" alignItems="center" className="mb-2">
				<InputLabel className="font-semibold">
					{t("pages.Settings.mixedSearchSources.title", "Mixed 搜索源")}
				</InputLabel>
				<SettingsHelp
					text={t(
						"pages.Settings.mixedSearchSources.description",
						"该设置仅影响添加游戏时的 mixed 搜索请求。BGM 和 VNDB 始终启用，YMGal、Kungal 与 DLsite 可按需开启。",
					)}
				/>
			</Stack>
			<Box className="pl-1">
				<Stack
					direction="row"
					spacing={2}
					useFlexGap
					flexWrap="wrap"
					alignItems="center"
				>
					<FormControlLabel
						control={
							<Checkbox
								checked={mixedEnableYmgal}
								onChange={(e) => setMixedEnableYmgal(e.target.checked)}
								color="primary"
							/>
						}
						label="YMGal"
					/>
					<FormControlLabel
						control={
							<Checkbox
								checked={mixedEnableKun}
								onChange={(e) => setMixedEnableKun(e.target.checked)}
								color="primary"
							/>
						}
						label="Kungal"
					/>
					<FormControlLabel
						control={
							<Checkbox
								checked={mixedEnableDlsite}
								onChange={(e) => setMixedEnableDlsite(e.target.checked)}
								color="primary"
							/>
						}
						label="DLsite"
					/>
				</Stack>
			</Box>
		</Box>
	);
};

export const VndbDataSettings = () => {
	const { t } = useTranslation();

	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.vndbData.title", "VNDB 数据设置")}
			</InputLabel>
			<Box className="pl-1">
				<TagTranslationSettings />
				<Divider sx={{ my: 2 }} />
				<SpoilerLevelSettings />
			</Box>
		</Box>
	);
};

const TagTranslationSettings = () => {
	const { t } = useTranslation();
	const tagTranslation = useStore((s) => s.tagTranslation);
	const setTagTranslation = useStore((s) => s.setTagTranslation);

	return (
		<Stack
			direction="row"
			alignItems="center"
			justifyContent="flex-start"
			spacing={1}
		>
				<Box sx={{ width: { sm: 250 }, flexShrink: 0 }}>
					<Stack direction="row" alignItems="center">
						<InputLabel className="font-semibold">
							{t("pages.Settings.tagTranslation.title", "TAG翻译")}
						</InputLabel>
						<SettingsHelp
							text={t(
							"pages.Settings.tagTranslation.description",
							"开启后将使用中文翻译显示游戏标签",
						)}
						/>
					</Stack>
				</Box>
				<Switch
					checked={tagTranslation}
					onChange={(e) => setTagTranslation(e.target.checked)}
					color="primary"
				/>
		</Stack>
	);
};

const SpoilerLevelSettings = () => {
	const { t } = useTranslation();
	const spoilerLevel = useStore((s) => s.spoilerLevel);
	const setSpoilerLevel = useStore((s) => s.setSpoilerLevel);

	return (
		<Stack
			direction={{ xs: "column", sm: "row" }}
			alignItems={{ xs: "stretch", sm: "center" }}
			justifyContent="flex-start"
			spacing={1}
			sx={{ "& > :first-of-type": { width: { sm: 250 }, flexShrink: 0 } }}
		>
				<Box sx={{ width: { sm: 250 }, flexShrink: 0 }}>
					<Stack direction="row" alignItems="center">
						<InputLabel className="font-semibold">
							{t("pages.Settings.spoilerLevel.title", "TAG剧透等级")}
						</InputLabel>
						<SettingsHelp
							text={t(
							"pages.Settings.spoilerLevel.description",
							"选择剧透等级以获取合适的标签内容",
						)}
						/>
					</Stack>
				</Box>
				<Select
					value={spoilerLevel}
					onChange={(event) => setSpoilerLevel(event.target.value as number)}
					className="min-w-40"
					size="small"
				>
					<MenuItem value={0}>
						{t("pages.Settings.spoilerLevel.level0", "0 - 无剧透")}
					</MenuItem>
					<MenuItem value={1}>
						{t("pages.Settings.spoilerLevel.level1", "1 - 轻微剧透")}
					</MenuItem>
					<MenuItem value={2}>
						{t("pages.Settings.spoilerLevel.level2", "2 - 严重剧透")}
					</MenuItem>
				</Select>
		</Stack>
	);
};

export const DevSettings: React.FC = () => {
	const { t } = useTranslation();

	return (
		<Accordion>
			<AccordionSummary
				expandIcon={<ArrowDropDownIcon />}
				aria-controls="panel2-content"
				id="panel2-header"
			>
				<Tooltip
					title={t(
						"pages.Settings.dev.tooltip",
						"以下功能为实验性功能，请谨慎使用",
					)}
				>
					<Typography component="span">
						{t("pages.Settings.dev.title", "实验性功能")}
					</Typography>
				</Tooltip>
			</AccordionSummary>
			<AccordionDetails>
				<BatchUpdateSettings />
			</AccordionDetails>
		</Accordion>
	);
};

const BatchUpdateSettings: React.FC = () => {
	const { t } = useTranslation();
	const [isUpdatingVndb, setIsUpdatingVndb] = useState(false);
	const [isUpdatingBgm, setIsUpdatingBgm] = useState(false);
	const [updateStatus, setUpdateStatus] = useState<string>("");

	const handleBatchUpdateVndb = async () => {
		setIsUpdatingVndb(true);
		setUpdateStatus("");

		try {
			// 动态导入批量更新函数
			const { batchUpdateVndbData } = await import("@/utils/appUtils");

			snackbar.info(
				t(
					"pages.Settings.batchUpdate.updatingVndb",
					"正在批量更新 VNDB 数据...",
				),
			);

			const result = await batchUpdateVndbData();

			if (result.success > 0) {
				const message = t(
					"pages.Settings.batchUpdate.success",
					`成功更新 ${result.success}/${result.total} 个游戏`,
					{ success: result.success, total: result.total },
				);
				setUpdateStatus(message);
				snackbar.success(message);
			}

			if (result.failed > 0) {
				const failedMessage = t(
					"pages.Settings.batchUpdate.partialFailed",
					`${result.failed} 个游戏更新失败`,
					{ failed: result.failed },
				);
				setUpdateStatus((prev) =>
					prev ? `${prev}\n${failedMessage}` : failedMessage,
				);
				snackbar.warning(failedMessage);
			}

			if (result.total === 0) {
				const noGamesMessage = t(
					"pages.Settings.batchUpdate.noGames",
					"没有找到包含 VNDB ID 的游戏",
				);
				setUpdateStatus(noGamesMessage);
				snackbar.info(noGamesMessage);
			}
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.batchUpdate.failed", "批量更新失败"),
			);
			setUpdateStatus(errorMessage);
			snackbar.error(
				t(
					"pages.Settings.batchUpdate.error",
					"批量更新 VNDB 数据失败: {{message}}",
					{ message: errorMessage },
				),
			);
		} finally {
			setIsUpdatingVndb(false);
		}
	};

	const handleBatchUpdateBgm = async () => {
		setIsUpdatingBgm(true);
		setUpdateStatus("");

		try {
			// 动态导入批量更新函数
			const { batchUpdateBgmData } = await import("@/utils/appUtils");

			snackbar.info(
				t("pages.Settings.batchUpdate.updatingBgm", "正在批量更新 BGM 数据..."),
			);

			const result = await batchUpdateBgmData();

			if (result.success > 0) {
				const message = t(
					"pages.Settings.batchUpdate.success",
					`成功更新 ${result.success}/${result.total} 个游戏`,
					{ success: result.success, total: result.total },
				);
				setUpdateStatus(message);
				snackbar.success(message);
			}

			if (result.failed > 0) {
				const failedMessage = t(
					"pages.Settings.batchUpdate.partialFailed",
					`${result.failed} 个游戏更新失败`,
					{ failed: result.failed },
				);
				setUpdateStatus((prev) =>
					prev ? `${prev}\n${failedMessage}` : failedMessage,
				);
				snackbar.warning(failedMessage);
			}

			if (result.total === 0) {
				const noGamesMessage = t(
					"pages.Settings.batchUpdate.noBgmGames",
					"没有找到包含 BGM ID 的游戏",
				);
				setUpdateStatus(noGamesMessage);
				snackbar.info(noGamesMessage);
			}
		} catch (error) {
			if (isBgmAuthExpiredError(error)) {
				return;
			}
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.batchUpdate.failed", "批量更新失败"),
			);
			setUpdateStatus(errorMessage);
			snackbar.error(
				t(
					"pages.Settings.batchUpdate.errorBgm",
					"批量更新 BGM 数据失败: {{message}}",
					{ message: errorMessage },
				),
			);
		} finally {
			setIsUpdatingBgm(false);
		}
	};

	const isUpdating = isUpdatingVndb || isUpdatingBgm;

	return (
		<Box>
			<Stack direction="row" alignItems="center" className="mb-2">
				<InputLabel className="font-semibold">
					{t("pages.Settings.batchUpdate.title", "批量更新数据")}
				</InputLabel>
				<SettingsHelp
					text={t(
						"pages.Settings.batchUpdate.description",
						"批量更新功能可用于更新已存在游戏的 BGM/VNDB 数据。当游戏的元数据发生变化时，您可以使用此功能来同步最新的信息。一旦点击更新按钮请耐心等待，更新过程可能需要一些时间。推荐软件更新数据源获取字段时使用。",
					)}
				/>
			</Stack>

			<Stack direction="column" spacing={1.5}>
				<Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
					<Button
						variant="contained"
						color="info"
						onClick={handleBatchUpdateBgm}
						disabled={isUpdating}
						startIcon={
							isUpdatingBgm ? (
								<CircularProgress size={16} color="inherit" />
							) : (
								<UpdateIcon />
							)
						}
						className="px-6 py-2"
					>
						{isUpdatingBgm
							? t(
									"pages.Settings.batchUpdate.updatingBgm",
									"正在批量更新 BGM 数据...",
								)
							: t("pages.Settings.batchUpdate.updateBgm", "批量更新 BGM 数据")}
					</Button>

					<Button
						variant="contained"
						color="primary"
						onClick={handleBatchUpdateVndb}
						disabled={isUpdating}
						startIcon={
							isUpdatingVndb ? (
								<CircularProgress size={16} color="inherit" />
							) : (
								<UpdateIcon />
							)
						}
						className="px-6 py-2"
					>
						{isUpdatingVndb
							? t(
									"pages.Settings.batchUpdate.updatingVndb",
									"正在批量更新 VNDB 数据...",
								)
							: t(
									"pages.Settings.batchUpdate.updateVndb",
									"批量更新 VNDB 数据",
								)}
					</Button>
				</Stack>

				{/* 更新状态显示 */}
				{updateStatus && (
					<Typography
						variant="body2"
						color={
							updateStatus.includes("失败") ||
							updateStatus.includes("fail") ||
							updateStatus.includes("错误") ||
							updateStatus.includes("error")
								? "error"
								: "primary"
						}
						className="whitespace-pre-line"
					>
						{updateStatus}
					</Typography>
				)}
			</Stack>
		</Box>
	);
};
