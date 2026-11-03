import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import { Box, Button, InputLabel, Stack, TextField, Typography } from "@mui/material";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useModStore } from "@/store/modStore";
import { cleanPathQuotes } from "@/utils/appUtils";

export const ToolWorkspaceSettings = () => {
	const { t } = useTranslation();
	const path = useModStore((state) => state.toolWorkspacePath);
	const setPath = useModStore((state) => state.setToolWorkspacePath);

	const chooseDirectory = async () => {
		const selected = await open({
			multiple: false,
			directory: true,
		});
		if (selected && !Array.isArray(selected)) setPath(selected);
	};

	return (
		<Box className="mb-6">
			<InputLabel className="font-semibold mb-1">
				{t("pages.Settings.toolWorkspace.title", "操作目录")}
			</InputLabel>
			<Typography variant="caption" color="text.secondary">
				{t(
					"pages.Settings.toolWorkspace.description",
					"需要手动确认、运行或放入的文件统一放在这里。",
				)}
			</Typography>
			<Stack
				direction={{ xs: "column", sm: "row" }}
				spacing={1}
				className="mt-4"
			>
				<TextField
					fullWidth
					size="small"
					label={t("pages.Settings.toolWorkspace.path", "目录")}
					value={path}
					onChange={(event) => setPath(cleanPathQuotes(event.target.value))}
					helperText={t("pages.Settings.toolWorkspace.emptyHint", "未设置时，需使用外部工具的功能会提示你先选择目录。")}
				/>
				<Button
					variant="outlined"
					startIcon={<FolderOpenIcon />}
					onClick={chooseDirectory}
					sx={{ flexShrink: 0 }}
				>
					{t("pages.Settings.toolWorkspace.choose", "选择")}
				</Button>
			</Stack>
		</Box>
	);
};
