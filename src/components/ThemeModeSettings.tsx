import BrightnessAutoIcon from "@mui/icons-material/BrightnessAuto";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import { useColorScheme } from "@mui/material/styles";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

type ThemeMode = "light" | "dark" | "system";

let lastAppliedWindowTheme: ThemeMode | null = null;

/** 始终让原生窗口外观跟随已保存的界面主题；不渲染任何界面。 */
export function ThemeWindowSync() {
	const { mode } = useColorScheme();
	const currentMode = (mode ?? "system") as ThemeMode;

	useEffect(() => {
		if (lastAppliedWindowTheme === currentMode) return;

		lastAppliedWindowTheme = currentMode;
		void getCurrentWindow()
			.setTheme(currentMode === "system" ? null : currentMode)
			.catch((error) => {
				lastAppliedWindowTheme = null;
				console.warn("更新窗口主题失败:", error);
			});
	}, [currentMode]);

	return null;
}

/** 主题选择保留在设置页，使用与其它基础偏好一致的紧凑设置行。 */
export function ThemeModeSettings() {
	const { t } = useTranslation();
	const { mode, setMode, allColorSchemes } = useColorScheme();
	const currentMode = (mode ?? "system") as ThemeMode;

	if (allColorSchemes.length <= 1) return null;

	const handleChange = (event: SelectChangeEvent<ThemeMode>) => {
		setMode(event.target.value as ThemeMode);
	};

	return (
		<Stack
			direction={{ xs: "column", sm: "row" }}
			alignItems={{ xs: "stretch", sm: "center" }}
			justifyContent="flex-start"
			spacing={1.5}
			sx={{ "& > .MuiInputLabel-root": { width: { sm: 250 }, flexShrink: 0 } }}
		>
			<InputLabel id="theme-mode-select-label" className="font-semibold">
				{t("components.Toolbar.theme", "主题")}
			</InputLabel>
			<Select
				labelId="theme-mode-select-label"
				id="theme-mode-select"
				size="small"
				value={currentMode}
				onChange={handleChange}
				className="w-40"
			>
				<MenuItem value="light"><LightModeIcon fontSize="small" sx={{ mr: 1 }} />{t("components.Toolbar.themeLight", "浅色")}</MenuItem>
				<MenuItem value="dark"><DarkModeIcon fontSize="small" sx={{ mr: 1 }} />{t("components.Toolbar.themeDark", "深色")}</MenuItem>
				<MenuItem value="system"><BrightnessAutoIcon fontSize="small" sx={{ mr: 1 }} />{t("components.Toolbar.themeSystem", "跟随系统")}</MenuItem>
			</Select>
		</Stack>
	);
}
