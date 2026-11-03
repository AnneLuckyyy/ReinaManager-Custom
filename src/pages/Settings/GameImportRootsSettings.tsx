import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import { Box, Button, IconButton, Stack, Typography } from "@mui/material";
import { SettingsHelp } from "@/components/SettingsHelp";
import { snackbar } from "@/providers/snackBar/snackBar";
import { useModStore } from "@/store/modStore";
import { handleGetFolder } from "@/utils/appUtils";

/** 批量导入的默认根目录只保存为本机偏好，不进入游戏数据库。 */
export function GameImportRootsSettings() {
	const roots = useModStore((state) => state.gameScanRoots);
	const addRoot = useModStore((state) => state.addGameScanRoot);
	const removeRoot = useModStore((state) => state.removeGameScanRoot);

	const chooseRoot = async () => {
		const path = await handleGetFolder();
		if (!path) return;
		if (!addRoot(path)) {
			snackbar.info("该默认扫描根目录已存在");
		}
	};

	return (
		<Stack spacing={1.25}>
			<Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="flex-start" spacing={1.5}>
				<Stack direction="row" alignItems="center" sx={{ width: { sm: 250 }, flexShrink: 0 }}>
					<Typography variant="subtitle1" className="font-semibold">游戏批量导入</Typography>
					<SettingsHelp text="未手动选择根文件夹时，批量导入会依次扫描这里的目录；手动选择后只扫描该次选中的目录。目录仅在打开批量导入时读取，不会持续监听。" />
				</Stack>
				<Button variant="outlined" startIcon={<FolderOpenRoundedIcon />} onClick={() => void chooseRoot()}>
					添加默认根目录
				</Button>
			</Stack>
			{roots.length === 0 ? (
				<Typography variant="body2" color="text.secondary">未设置默认根目录；批量导入会保持原来的手动选择方式。</Typography>
			) : (
				<Stack spacing={0.5}>
					{roots.map((root) => (
						<Stack key={root.id} direction="row" alignItems="center" spacing={1} sx={{ minHeight: 36, px: 1, borderRadius: 1.5, bgcolor: "action.hover" }}>
							<Typography variant="body2" noWrap title={root.path} sx={{ flex: 1 }}>{root.path}</Typography>
							<IconButton size="small" aria-label="移除默认根目录" onClick={() => removeRoot(root.id)}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton>
						</Stack>
					))}
				</Stack>
			)}
			<Box><Typography variant="caption" color="text.secondary">扫描结果仍会保留未导入且未列入候选的一级待核对文件夹与原因；删除这里的设置不会删除任何游戏记录。</Typography></Box>
		</Stack>
	);
}
