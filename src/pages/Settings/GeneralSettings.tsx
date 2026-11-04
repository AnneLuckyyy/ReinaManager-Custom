import {
	Stack,
	Switch,
	TextField,
	Typography,
	Divider,
} from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { snackbar } from "@/providers/snackBar";
import { SettingsHelp } from "@/components/SettingsHelp";
import { applyUiZoom, UI_ZOOM_PRESETS } from "@/services/uiZoom";
import { useStore } from "@/store/appStore";
import { type StartupPage, useModStore } from "@/store/modStore";

const DRIVE_LETTERS = Array.from({ length: 24 }, (_, index) =>
	String.fromCharCode("C".charCodeAt(0) + index),
);

function getRecordedHotkey(event: React.KeyboardEvent<HTMLElement>): string | null {
	const modifierKeys = ["Control", "Alt", "Shift", "Meta"];
	if (modifierKeys.includes(event.key)) return null;

	let mainKey = event.key.length === 1 ? event.key.toUpperCase() : event.key;
	if (event.code.startsWith("Key")) mainKey = event.code.slice(3);
	if (event.code.startsWith("Digit")) mainKey = event.code.slice(5);
	if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(mainKey)) return "";

	const keys = [
		event.ctrlKey ? "Ctrl" : null,
		event.altKey ? "Alt" : null,
		event.shiftKey ? "Shift" : null,
		event.metaKey ? "Win" : null,
		mainKey,
	].filter((key): key is string => Boolean(key));

	return keys.length >= 2 && keys.length <= 3 ? keys.join("+") : "";
}

export const LanguageSelect = () => {
	const { t, i18n } = useTranslation(); // 使用i18n实例和翻译函数

	// 语言名称映射
	const languageNames = {
		"zh-CN": "简体中文(zh-CN)",
		"zh-TW": "繁体中文(zh-TW)",
		"en-US": "English(en-US)",
		"ja-JP": "日本語(ja-JP)",
	};

	/**
	 * 处理语言切换
	 * @param {SelectChangeEvent} event
	 */
	const handleChange = (event: SelectChangeEvent) => {
		const newLang = event.target.value;
		i18n.changeLanguage(newLang); // 切换语言
	};

	return (
		<Stack
			direction={{ xs: "column", sm: "row" }}
			alignItems={{ xs: "stretch", sm: "center" }}
			justifyContent="flex-start"
			spacing={1}
		>
			<InputLabel id="language-select-label" className="font-semibold">
				{t("pages.Settings.language", "语言")}
			</InputLabel>
			<Select
				labelId="language-select-label"
				id="language-select"
				size="small"
				value={i18n.language}
				onChange={handleChange}
				className="w-60"
				renderValue={(value) =>
					languageNames[value as keyof typeof languageNames]
				}
			>
				<MenuItem value="zh-CN">简体中文(zh-CN)</MenuItem>
				<MenuItem value="zh-TW">繁体中文(zh-TW)</MenuItem>
				<MenuItem value="en-US">English(en-US)</MenuItem>
				<MenuItem value="ja-JP">日本語(ja-JP)</MenuItem>
			</Select>
		</Stack>
	);
};

export const InterfaceZoomSettings = () => {
	const { t } = useTranslation();
	const uiZoomPercent = useModStore((state) => state.uiZoomPercent);

	const handleChange = (event: SelectChangeEvent) => {
		void applyUiZoom(Number(event.target.value)).catch((error) => {
			console.error("设置界面缩放失败:", error);
			snackbar.error(
				t("pages.Settings.interfaceZoom.error", "界面缩放失败"),
			);
		});
	};

	return (
		<Stack
			direction={{ xs: "column", sm: "row" }}
			alignItems={{ xs: "stretch", sm: "center" }}
			justifyContent="flex-start"
			spacing={1}
		>
			<Stack direction="row" alignItems="center">
				<InputLabel id="interface-zoom-select-label" className="font-semibold">
					{t("pages.Settings.interfaceZoom.title", "界面缩放")}
				</InputLabel>
				<SettingsHelp
					text={t(
					"pages.Settings.interfaceZoom.note",
					"调整应用内容大小，不改变窗口尺寸。",
				)}
				/>
			</Stack>
			<Select
				labelId="interface-zoom-select-label"
				id="interface-zoom-select"
				size="small"
				value={String(uiZoomPercent)}
				onChange={handleChange}
				className="w-40"
			>
				{UI_ZOOM_PRESETS.map((percent) => (
					<MenuItem key={percent} value={String(percent)}>
						{percent}%
					</MenuItem>
				))}
			</Select>
		</Stack>
	);
};

export const StartupPageSettings = () => {
	const { t } = useTranslation();
	const startupPage = useModStore((state) => state.startupPage);
	const setStartupPage = useModStore((state) => state.setStartupPage);

	const handleChange = (event: SelectChangeEvent<StartupPage>) => {
		setStartupPage(event.target.value as StartupPage);
	};

	return (
		<Stack
			direction={{ xs: "column", sm: "row" }}
			alignItems={{ xs: "stretch", sm: "center" }}
			justifyContent="flex-start"
			spacing={1}
		>
			<Stack direction="row" alignItems="center">
				<InputLabel id="startup-page-select-label" className="font-semibold">
					{t("pages.Settings.startupPage.title", "启动默认页面")}
				</InputLabel>
				<SettingsHelp
					text={t(
						"pages.Settings.startupPage.note",
						"选择下次正常启动时打开的页面；保持上次停留页面会延续原有行为。",
					)}
				/>
			</Stack>
			<Select
				labelId="startup-page-select-label"
				id="startup-page-select"
				size="small"
				value={startupPage}
				onChange={handleChange}
				className="w-60"
			>
				<MenuItem value="last">保持上次停留页面</MenuItem>
				<MenuItem value="home">主页</MenuItem>
				<MenuItem value="libraries">游戏仓库</MenuItem>
				<MenuItem value="collection">收藏夹</MenuItem>
			</Select>
		</Stack>
	);
};

export const NsfwSettings = () => {
	const { t } = useTranslation();
	const { nsfwFilter, setNsfwFilter, nsfwCoverReplace, setNsfwCoverReplace } =
		useStore(
			useShallow((s) => ({
				nsfwFilter: s.nsfwFilter,
				setNsfwFilter: s.setNsfwFilter,
				nsfwCoverReplace: s.nsfwCoverReplace,
				setNsfwCoverReplace: s.setNsfwCoverReplace,
			})),
		);

	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.nsfw.title", "NSFW 设置")}
			</InputLabel>

			<Stack spacing={0.25}>
				<Stack direction="row" alignItems="center" spacing={1}>
					<Typography variant="body2">
						{t("pages.Settings.nsfw.filter", "过滤 NSFW 内容")}
					</Typography>
					<Switch
						checked={nsfwFilter}
						onChange={(e) => setNsfwFilter(e.target.checked)}
						inputProps={{ "aria-label": t("pages.Settings.nsfw.filter", "过滤 NSFW 内容") }}
						color="primary"
					/>
				</Stack>
				<Stack direction="row" alignItems="center" spacing={1}>
					<Typography variant="body2">
						{t("pages.Settings.nsfw.coverReplace", "NSFW 封面替换")}
					</Typography>
					<Switch
						checked={nsfwCoverReplace}
						onChange={(e) => setNsfwCoverReplace(e.target.checked)}
						inputProps={{ "aria-label": t("pages.Settings.nsfw.coverReplace", "NSFW 封面替换") }}
						color="primary"
					/>
				</Stack>
			</Stack>
		</Box>
	);
};

export const CardClickModeSettings = () => {
	const { t } = useTranslation();
	const {
		cardClickMode,
		setCardClickMode,
		doubleClickLaunch,
		setDoubleClickLaunch,
		longPressLaunch,
		setLongPressLaunch,
	} = useStore(
		useShallow((s) => ({
			cardClickMode: s.cardClickMode,
			setCardClickMode: s.setCardClickMode,
			doubleClickLaunch: s.doubleClickLaunch,
			setDoubleClickLaunch: s.setDoubleClickLaunch,
			longPressLaunch: s.longPressLaunch,
			setLongPressLaunch: s.setLongPressLaunch,
		})),
	);
	const folderDragEnabled = useModStore((s) => s.folderDragEnabled);
	const setFolderDragEnabled = useModStore((s) => s.setFolderDragEnabled);

	return (
		<Box>
			<Stack direction="row" alignItems="center" className="mb-1">
				<InputLabel className="font-semibold">
					{t("pages.Settings.cardClickMode.title", "卡片点击模式")}
				</InputLabel>
				<SettingsHelp
					text={t(
						"pages.Settings.cardClickMode.description",
						"导航模式单击打开详情；选择模式单击选中游戏。",
					)}
				/>
			</Stack>
			<Stack spacing={0.5}>
				<Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap role="group" aria-label={t("pages.Settings.cardClickMode.title", "卡片点击模式")}>
					<Button
						variant={cardClickMode === "navigate" ? "contained" : "outlined"}
						onClick={() => setCardClickMode("navigate")}
						aria-pressed={cardClickMode === "navigate"}
						size="small"
						sx={{ minHeight: 32, px: 1.75, py: 0.25 }}
					>
						{t("pages.Settings.cardClickMode.navigate", "导航")}
					</Button>
					<Button
						variant={cardClickMode === "select" ? "contained" : "outlined"}
						onClick={() => setCardClickMode("select")}
						aria-pressed={cardClickMode === "select"}
						size="small"
						sx={{ minHeight: 32, px: 1.75, py: 0.25 }}
					>
						{t("pages.Settings.cardClickMode.select", "选择")}
					</Button>
				</Stack>

				<Stack divider={<Box sx={{ borderBottom: 1, borderColor: "divider" }} />}>
					{[
						{
							label: t("pages.Settings.cardClickMode.doubleClickLaunch", "双击启动游戏"),
							checked: doubleClickLaunch,
							onChange: setDoubleClickLaunch,
							note: doubleClickLaunch && cardClickMode === "navigate"
								? t("pages.Settings.cardClickMode.doubleClickLaunchNote", "开启后会导致左键单击延迟500ms（仅导航模式）")
								: "",
						},
						{
							label: t("pages.Settings.cardClickMode.longPressLaunch", "长按启动游戏"),
							checked: longPressLaunch,
							onChange: setLongPressLaunch,
							note: longPressLaunch
								? t("pages.Settings.cardClickMode.longPressLaunchNote", "长按卡片800ms后启动游戏，开启后收藏夹拖拽排序功能将被禁用")
								: "",
						},
						{
							label: t("pages.Settings.cardClickMode.folderDrag", "分类拖拽排序"),
							checked: folderDragEnabled,
							onChange: setFolderDragEnabled,
							note: folderDragEnabled
								? t("pages.Settings.cardClickMode.folderDragNote", "在收藏夹页面拖拽分类卡片进行排序，虚拟分类不可拖拽")
								: "",
						},
					].map((item) => (
						<Box key={item.label} sx={{ py: 0.25 }}>
							<Stack direction="row" alignItems="center" spacing={1}>
								<Typography variant="body2">{item.label}</Typography>
								<Switch
									checked={item.checked}
									onChange={(event) => item.onChange(event.target.checked)}
									inputProps={{ "aria-label": item.label }}
								/>
							</Stack>
							{item.note && <Typography variant="caption" color="text.secondary">{item.note}</Typography>}
						</Box>
					))}
				</Stack>
			</Stack>
		</Box>
	);
};

export const GameLaunchSettings = () => {
	const { t } = useTranslation();
	const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
	const [hotkeyError, setHotkeyError] = useState("");
	const {
		autoDriveFallbackEnabled,
		autoDriveStart,
		autoDriveEnd,
		magpieHotkey,
		setAutoDriveFallbackEnabled,
		setAutoDriveStart,
		setAutoDriveEnd,
		setMagpieHotkey,
	} = useModStore();

	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.gameLaunch.title", "游戏启动增强")}
			</InputLabel>
			<Stack divider={<Divider flexItem />} spacing={0}>
				<Box sx={{ py: 0.5 }}>
					<Stack direction="row" alignItems="center" spacing={1}>
						<Stack direction="row" alignItems="center">
							<Typography variant="body2">
								{t("pages.Settings.gameLaunch.autoDrive", "自动更换盘符")}
							</Typography>
							<SettingsHelp
								text={t(
									"pages.Settings.gameLaunch.autoDriveNote",
									"仅在主路径和备用路径全部失败后尝试，不扫描磁盘。",
								)}
							/>
						</Stack>
						<Switch
							checked={autoDriveFallbackEnabled}
							onChange={(event) => setAutoDriveFallbackEnabled(event.target.checked)}
							inputProps={{ "aria-label": t("pages.Settings.gameLaunch.autoDrive", "自动更换盘符") }}
						/>
					</Stack>
				{autoDriveFallbackEnabled && (
					<Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap className="mt-1">
						<Typography variant="body2">尝试盘符</Typography>
							<Select
								size="small"
								value={autoDriveStart}
								onChange={(event) => {
									const nextStart = event.target.value;
									setAutoDriveStart(nextStart);
									if (nextStart > autoDriveEnd) setAutoDriveEnd(nextStart);
								}}
							>
								{DRIVE_LETTERS.map((drive) => (
									<MenuItem key={drive} value={drive}>{drive}:</MenuItem>
								))}
							</Select>
						<Typography variant="body2">—</Typography>
							<Select
								size="small"
								value={autoDriveEnd}
								onChange={(event) => {
									const nextEnd = event.target.value;
									setAutoDriveEnd(nextEnd);
									if (nextEnd < autoDriveStart) setAutoDriveStart(nextEnd);
								}}
							>
								{DRIVE_LETTERS.map((drive) => (
									<MenuItem key={drive} value={drive}>{drive}:</MenuItem>
								))}
							</Select>
					</Stack>
				)}
				</Box>

				<Stack
					direction={{ xs: "column", sm: "row" }}
					spacing={1.5}
					alignItems={{ xs: "stretch", sm: "flex-start" }}
					justifyContent="flex-start"
					sx={{ py: 1.25 }}
				>
					<Box>
						<Typography variant="body2" className="font-medium">
							{t("pages.Settings.gameLaunch.magpieHotkey", "Magpie 全屏快捷键")}
						</Typography>
						<Typography variant="caption" color="text.secondary">
							点击输入框后直接按组合键
						</Typography>
					</Box>
					<TextField
						size="small"
						value={
							isRecordingHotkey
								? t("pages.Settings.gameLaunch.recording", "请按下组合键…")
								: magpieHotkey
						}
						inputProps={{ readOnly: true }}
						onFocus={() => {
							setIsRecordingHotkey(true);
							setHotkeyError("");
						}}
						onBlur={() => setIsRecordingHotkey(false)}
						onKeyDown={(event) => {
							if (!isRecordingHotkey) return;
							if (event.key === "Escape") {
								setIsRecordingHotkey(false);
								(event.target as HTMLElement).blur();
								return;
							}
							event.preventDefault();
							const hotkey = getRecordedHotkey(event);
							if (hotkey === null) return;
							if (!hotkey) {
								setHotkeyError(
									t("pages.Settings.gameLaunch.hotkeyError", "请使用一个或两个功能键，加一个字母、数字或 F1–F12。"),
								);
								return;
							}
							setMagpieHotkey(hotkey);
							setHotkeyError("");
							setIsRecordingHotkey(false);
							(event.target as HTMLElement).blur();
						}}
						error={Boolean(hotkeyError)}
						helperText={hotkeyError}
						sx={{ width: { xs: "100%", sm: 260 } }}
					/>
				</Stack>
			</Stack>
		</Box>
	);
};
