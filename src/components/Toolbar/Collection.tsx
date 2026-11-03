/**
 * @file CollectionToolbar 收藏夹页面工具栏
 * @description 根据当前导航层级显示不同的操作按钮
 * - 分组列表页：添加分组
 * - 分类列表页：添加分类、删除分组
 * - 游戏列表页：管理游戏（添加/删除游戏）
 * @module src/components/Toolbar/CollectionToolbar
 * @author ReinaManager
 * @copyright AGPL-3.0
 */

import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import Button from "@mui/material/Button";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { AlertConfirmBox } from "@/components/AlertBox";
import { CollectionFilterModal, ManageGamesDialog } from "@/components/Collection";
import { InputDialog } from "@/components/InputDialog";
import { LaunchModal } from "@/components/LaunchModal";
import { ToolbarIconAction } from "./ToolbarIconAction";
import {
	useCategories,
	useCreateCategory,
	useCreateGroup,
	useDeleteGroup,
} from "@/hooks/queries/useCollections";
import { useStore } from "@/store/appStore";

export const CollectionToolbar: React.FC = () => {
	const { t } = useTranslation();
	const {
		currentGroupId,
		selectedCategoryId,
		setCurrentGroup,
		setSelectedCategory,
	} = useStore(
		useShallow((s) => ({
			currentGroupId: s.currentGroupId,
			selectedCategoryId: s.selectedCategoryId,
			setCurrentGroup: s.setCurrentGroup,
			setSelectedCategory: s.setSelectedCategory,
		})),
	);
	const categoriesQuery = useCategories(currentGroupId);
	const currentCategories = categoriesQuery.data ?? [];
	const createGroupMutation = useCreateGroup();
	const createCategoryMutation = useCreateCategory();
	const deleteGroupMutation = useDeleteGroup();

	// 对话框状态
	const [addGroupDialogOpen, setAddGroupDialogOpen] = useState(false);
	const [addCategoryDialogOpen, setAddCategoryDialogOpen] = useState(false);
	const [deleteGroupDialogOpen, setDeleteGroupDialogOpen] = useState(false);
	const [manageGamesDialogOpen, setManageGamesDialogOpen] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	// 判断是否是默认分组
	const isDefaultGroup = currentGroupId?.startsWith("default_") ?? false;

	// 获取当前分类名称
	const getCurrentCategoryName = () => {
		if (selectedCategoryId === null || selectedCategoryId < 0) return "";
		const category = currentCategories.find((c) => c.id === selectedCategoryId);
		return category?.name || "";
	};

	/**
	 * 创建新分组
	 */
	const handleCreateGroup = async (name: string) => {
		await createGroupMutation.mutateAsync({ name });
	};

	/**
	 * 创建新分类
	 */
	const handleCreateCategory = async (name: string) => {
		if (!currentGroupId || isDefaultGroup) return;
		await createCategoryMutation.mutateAsync({
			name,
			groupId: Number.parseInt(currentGroupId, 10),
		});
	};

	/**
	 * 删除当前分组
	 */
	const handleDeleteGroup = async () => {
		if (!currentGroupId || isDefaultGroup) return;

		try {
			setIsDeleting(true);
			await deleteGroupMutation.mutateAsync(
				Number.parseInt(currentGroupId, 10),
			);
			setCurrentGroup(null);
			setSelectedCategory(null);
			setDeleteGroupDialogOpen(false);
		} catch (error) {
			console.error("删除分组失败:", error);
		} finally {
			setIsDeleting(false);
		}
	};

	// 层级1: 分组列表页 - 显示"添加分组"按钮
	if (!currentGroupId) {
		return (
			<>
				<Button
					startIcon={<AddIcon />}
					onClick={() => setAddGroupDialogOpen(true)}
				>
					{t("components.Toolbar.Collection.Group.addGroup", "添加分组")}
				</Button>

				<InputDialog
					open={addGroupDialogOpen}
					onClose={() => setAddGroupDialogOpen(false)}
					onConfirm={handleCreateGroup}
					title={t("components.Toolbar.Collection.Group.addGroup", "添加分组")}
					label={t(
						"components.Toolbar.Collection.Group.enterGroupName",
						"请输入分组名称",
					)}
					placeholder={t(
						"components.Toolbar.Collection.Group.enterGroupName",
						"请输入分组名称",
					)}
				/>
			</>
		);
	}

	// 层级2: 分类列表页 - 显示"添加分类"和"删除分组"按钮
	if (selectedCategoryId === null && !isDefaultGroup) {
		return (
			<>
				<Button
					startIcon={<AddIcon />}
					onClick={() => setAddCategoryDialogOpen(true)}
					disabled={isDefaultGroup}
				>
					{t("components.Toolbar.Collection.Group.addCategory", "添加分类")}
				</Button>

				<Button
					startIcon={<DeleteIcon />}
					color="error"
					onClick={() => setDeleteGroupDialogOpen(true)}
					disabled={isDefaultGroup}
				>
					{t("components.Toolbar.Collection.Group.deleteGroup", "删除分组")}
				</Button>

				<InputDialog
					open={addCategoryDialogOpen}
					onClose={() => setAddCategoryDialogOpen(false)}
					onConfirm={handleCreateCategory}
					title={t(
						"components.Toolbar.Collection.Group.addCategory",
						"添加分类",
					)}
					label={t(
						"components.Toolbar.Collection.Group.enterCategoryName",
						"请输入分类名称",
					)}
					placeholder={t(
						"components.Toolbar.Collection.Group.enterCategoryName",
						"请输入分类名称",
					)}
				/>

				<AlertConfirmBox
					open={deleteGroupDialogOpen}
					setOpen={setDeleteGroupDialogOpen}
					onConfirm={handleDeleteGroup}
					isLoading={isDeleting}
					title={t(
						"components.Toolbar.Collection.Group.deleteGroupTitle",
						"删除分组",
					)}
					message={t(
						"components.Toolbar.Collection.Group.deleteGroupMessage",
						"确定要删除此分组吗？此操作将同时删除分组下的所有分类，且无法恢复。",
					)}
				/>
			</>
		);
	}

	// 层级3: 游戏列表页 - 显示"管理游戏"按钮（只在真实分类中显示）
	if (selectedCategoryId !== null) {
		return (
			<>
				<LaunchModal compact />
				{selectedCategoryId > 0 && (
					<ToolbarIconAction
						label={t("components.Toolbar.Collection.Category.manageGames", "管理游戏")}
						onClick={() => setManageGamesDialogOpen(true)}
					>
						<EditIcon />
					</ToolbarIconAction>
				)}
				<CollectionFilterModal categoryId={selectedCategoryId} />

				{selectedCategoryId > 0 && (
					<ManageGamesDialog
						open={manageGamesDialogOpen}
						onClose={() => setManageGamesDialogOpen(false)}
						categoryId={selectedCategoryId}
						categoryName={getCurrentCategoryName()}
					/>
				)}
			</>
		);
	}
};
