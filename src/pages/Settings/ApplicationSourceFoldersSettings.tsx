import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import { Button, IconButton, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import { SettingsHelp } from "@/components/SettingsHelp";
import { snackbar } from "@/providers/snackBar/snackBar";
import { useAppLauncherStore } from "@/store/appLauncherStore";
import { appLauncherService } from "@/services/invoke/appLauncherService";
import { handleGetFolder } from "@/utils/appUtils";

/** 应用来源目录仅是本机扫描偏好；不会改动其中的文件或快捷方式。 */
export function ApplicationSourceFoldersSettings() {
	const categories = useAppLauncherStore((state) => state.categories);
	const sources = useAppLauncherStore((state) => state.sourceFolders);
	const addSource = useAppLauncherStore((state) => state.addSourceFolder);
	const removeSource = useAppLauncherStore((state) => state.removeSourceFolder);
	const importCandidates = useAppLauncherStore((state) => state.importCandidates);
	const [categoryId, setCategoryId] = useState("uncategorized");
	const [isScanning, setIsScanning] = useState(false);

	const chooseSource = async () => {
		const path = await handleGetFolder();
		if (!path) return;
		if (!addSource(path, categoryId)) {
			snackbar.info("该应用来源目录已存在，或分类不可用");
		}
	};

	const scanSources = async () => {
		if (!sources.length || isScanning) return;
		setIsScanning(true);
		try {
			const results = await Promise.allSettled(
				sources.map(async (source) => ({
					source,
					candidates: await appLauncherService.scanFolder(source.path),
				})),
			);
			let imported = 0;
			let failures = 0;
			for (const result of results) {
				if (result.status === "rejected") {
					failures++;
					continue;
				}
				imported += importCandidates(result.value.candidates, result.value.source.categoryId);
			}
			if (failures) snackbar.info(`已加入 ${imported} 个新应用；${failures} 个来源目录无法读取`);
			else snackbar.success(imported ? `已加入 ${imported} 个新应用` : "未发现新的应用项");
		} finally {
			setIsScanning(false);
		}
	};

	return (
		<Stack spacing={1.25}>
			<Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="flex-start" spacing={1.5}>
				<Stack direction="row" alignItems="center" sx={{ width: { sm: 250 }, flexShrink: 0 }}>
					<Typography variant="subtitle1" className="font-semibold">应用来源目录</Typography>
					<SettingsHelp text="仅在这里点击“扫描来源目录”时，读取这些目录的直属 .lnk、.url 与 .exe，并把新发现的项目加入指定分类。不会持续监听、移动或删除文件。" />
				</Stack>
				<Stack direction="row" spacing={1}>
					<TextField select size="small" label="导入分类" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} sx={{ minWidth: 132 }}>
						{categories.map((category) => <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>)}
					</TextField>
					<Button variant="outlined" startIcon={<FolderOpenRoundedIcon />} onClick={() => void chooseSource()}>添加来源目录</Button>
					<Button variant="contained" disabled={!sources.length || isScanning} onClick={() => void scanSources()}>{isScanning ? "扫描中…" : "扫描来源目录"}</Button>
				</Stack>
			</Stack>
			{sources.length === 0 ? (
				<Typography variant="body2" color="text.secondary">未设置来源目录；仍可在应用页顶栏手动导入目录或直接拖入。</Typography>
			) : (
				<Stack spacing={0.5}>
					{sources.map((source) => {
						const category = categories.find((item) => item.id === source.categoryId);
						return <Stack key={source.id} direction="row" alignItems="center" spacing={1} sx={{ minHeight: 36, px: 1, borderRadius: 1.5, bgcolor: "action.hover" }}>
							<Typography variant="body2" noWrap title={source.path} sx={{ flex: 1 }}>{source.path}</Typography>
							<Typography variant="caption" color="text.secondary">{category?.name ?? "待整理"}</Typography>
							<IconButton size="small" aria-label="移除应用来源目录" onClick={() => removeSource(source.id)}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton>
						</Stack>;
					})}
				</Stack>
			)}
		</Stack>
	);
}
