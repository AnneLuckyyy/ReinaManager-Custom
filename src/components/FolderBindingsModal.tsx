import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import AppsOutlinedIcon from "@mui/icons-material/AppsOutlined";
import SportsEsportsOutlinedIcon from "@mui/icons-material/SportsEsportsOutlined";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { useState } from "react";
import { ApplicationSourceFoldersSettings } from "@/pages/Settings/ApplicationSourceFoldersSettings";
import { GameCategorySourceFoldersSettings } from "@/pages/Settings/GameCategorySourceFoldersSettings";
import { GameImportRootsSettings } from "@/pages/Settings/GameImportRootsSettings";

type FolderBindingTab = "game-scan" | "game-category" | "application";

/** 集中管理需要保存多个目录的轻量本机偏好，避免在设置主页铺开长列表。 */
export function FolderBindingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [tab, setTab] = useState<FolderBindingTab>("game-scan");

	return (
		<Dialog open={open} onClose={onClose} fullWidth maxWidth="md" aria-labelledby="folder-bindings-dialog-title">
			<DialogTitle id="folder-bindings-dialog-title">目录关联</DialogTitle>
			<Tabs value={tab} onChange={(_, value: FolderBindingTab) => setTab(value)} variant="fullWidth" sx={{ px: 2 }}>
				<Tab value="game-scan" icon={<SportsEsportsOutlinedIcon fontSize="small" />} iconPosition="start" label="游戏批量扫描" />
				<Tab value="game-category" icon={<AccountTreeOutlinedIcon fontSize="small" />} iconPosition="start" label="游戏分类" />
				<Tab value="application" icon={<AppsOutlinedIcon fontSize="small" />} iconPosition="start" label="应用来源" />
			</Tabs>
			<DialogContent dividers sx={{ py: 2.5, minHeight: 260 }}>
				{tab === "game-scan" && <GameImportRootsSettings />}
				{tab === "game-category" && <GameCategorySourceFoldersSettings />}
				{tab === "application" && <ApplicationSourceFoldersSettings />}
			</DialogContent>
		</Dialog>
	);
}
