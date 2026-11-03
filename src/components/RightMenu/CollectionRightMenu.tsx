/**
 * @file CollectionRightMenu 组件
 * @description 分组和分类的右键菜单组件
 * @module src/components/RightMenu/CollectionRightMenu
 * @author ReinaManager
 * @copyright AGPL-3.0
 */

import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import EditIcon from "@mui/icons-material/Edit";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import { ListItemIcon, ListItemText, MenuItem, MenuList } from "@mui/material";
import { useTranslation } from "react-i18next";
import { useModStore } from "@/store/modStore";
import { BaseRightMenu } from "./BaseRightMenu";

/**
 * CollectionRightMenu 组件属性类型
 */
type CollectionRightMenuTarget =
	| { type: "group"; id: string }
	| { type: "category"; id: number; groupId: string };

interface CollectionRightMenuProps {
	anchorPosition: { top: number; left: number };
	onClose: () => void;
	target: CollectionRightMenuTarget;
	onOpenRename: () => void; // 打开重命名对话框的回调
	onOpenManageGames?: () => void; // 打开管理游戏对话框的回调（仅分类）
}

/**
 * 分组和分类的右键菜单组件
 * - 分类：编辑分类（管理游戏）+ 重命名
 * - 分组：只有重命名
 *
 * @param {CollectionRightMenuProps} props 组件属性
 * @returns {JSX.Element | null} 右键菜单
 */
export const CollectionRightMenu: React.FC<CollectionRightMenuProps> = ({
	anchorPosition,
	onClose,
	target,
	onOpenRename,
	onOpenManageGames,
}) => {
	const { t } = useTranslation();
	const pinnedFolders = useModStore((state) => state.pinnedFolders);
	const togglePinnedFolder = useModStore((state) => state.togglePinnedFolder);

	const isPinned =
		target.type === "category" &&
		pinnedFolders.some((f) => f.type === "category" && f.categoryId === target.id);

	const handleTogglePin = () => {
		if (target.type === "category") {
			togglePinnedFolder({
				type: "category",
				categoryId: target.id,
				groupId: target.groupId,
			});
		}
		onClose();
	};

	return (
		<BaseRightMenu
			isopen
			anchorPosition={anchorPosition}
			onClose={onClose}
			ariaLabel={
				target.type === "group"
					? t("components.RightMenu.Collection.groupMenu", "分组菜单")
					: t("components.RightMenu.Collection.categoryMenu", "分类菜单")
			}
		>
			<MenuList sx={{ py: 1 }}>
				{/* 编辑分类（管理游戏） - 仅分类显示 */}
				{target.type === "category" && (
					<MenuItem onClick={onOpenManageGames}>
						<ListItemIcon>
							<EditIcon />
						</ListItemIcon>
						<ListItemText
							primary={t(
								"components.RightMenu.Collection.manageGames",
								"管理游戏",
							)}
						/>
					</MenuItem>
				)}

				{/* 固定/取消固定 - 仅分类显示 */}
				{target.type === "category" && (
					<MenuItem onClick={handleTogglePin}>
						<ListItemIcon>
							{isPinned ? (
								<PushPinIcon fontSize="small" />
							) : (
								<PushPinOutlinedIcon fontSize="small" />
							)}
						</ListItemIcon>
						<ListItemText
							primary={
								isPinned
									? t("components.RightMenu.Collection.unpin", "从快速访问解除固定")
									: t("components.RightMenu.Collection.pin", "固定到快速访问")
							}
						/>
					</MenuItem>
				)}

				{/* 重命名 */}
				<MenuItem onClick={onOpenRename}>
					<ListItemIcon>
						<DriveFileRenameOutlineIcon />
					</ListItemIcon>
					<ListItemText
						primary={
							target.type === "group"
								? t("components.RightMenu.Collection.renameGroup", "重命名分组")
								: t(
										"components.RightMenu.Collection.renameCategory",
										"重命名分类",
									)
						}
					/>
				</MenuItem>
			</MenuList>
		</BaseRightMenu>
	);
};
