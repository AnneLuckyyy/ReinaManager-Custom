import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import KeyboardArrowUpRoundedIcon from "@mui/icons-material/KeyboardArrowUpRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import { Avatar, Badge, Box, Fab, Fade } from "@mui/material";
import AppBar from "@mui/material/AppBar";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { DashboardLayout } from "@toolpad/core/DashboardLayout";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import AddModal from "@/components/AddModal";
import { DiskHealthSummary } from "@/components/DiskHealthSummary";
import { GameArchiveSidebarStatus } from "@/components/GameArchiveSidebarStatus";
import { PinnedSidebarList } from "@/components/PinnedSidebarList";
import { SearchBox } from "@/components/SearchBox";
import { ApplicationsSearchBox, Toolbars } from "@/components/Toolbar";
import { setScrollPosition } from "@/hooks/common/useScrollRestore";
import { useCategories, useGroups } from "@/hooks/queries/useCollections";
import { useStore } from "@/store/appStore";
import { saveScrollPosition } from "@/utils/appUtils";

/**
 * 侧边栏底部内容（包含快速访问和磁盘健康摘要）
 */
function DownloadTasksSidebarButton({ mini }: { mini: boolean }) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const label = t("app.NAVIGATION.downloads", "下载任务");
	const selected = location.pathname === "/downloads";

	return (
		<Tooltip title={label} placement="right" arrow>
			<Box
				sx={{
					display: "flex",
					alignItems: "center",
					justifyContent: mini ? "center" : "flex-start",
					mx: mini ? 0.75 : 1.25,
					mb: 0.75,
					minHeight: 36,
					borderRadius: 2,
					bgcolor: selected ? "action.selected" : "transparent",
				}}
			>
				<IconButton
					aria-label={label}
					onClick={() => navigate("/downloads")}
					color={selected ? "primary" : "inherit"}
					size="small"
				>
					<DownloadRoundedIcon fontSize="small" />
				</IconButton>
				{!mini && (
					<Typography variant="body2" fontWeight={selected ? 650 : 500}>
						{label}
					</Typography>
				)}
			</Box>
		</Tooltip>
	);
}

function SidebarContent({ mini }: { mini: boolean }) {
	return (
		<Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
			<Box sx={{ flexGrow: 1, overflowY: "auto" }}>
				<PinnedSidebarList mini={mini} />
			</Box>
			<GameArchiveSidebarStatus mini={mini} />
			<DiskHealthSummary mini={mini} />
			<DownloadTasksSidebarButton mini={mini} />
		</Box>
	);
}

/**
 * 自定义应用标题组件
 * @returns {JSX.Element}
 */
const CollectionHeaderPath = () => {
	const navigate = useNavigate();
	const { currentGroupId, selectedCategoryId, selectedCategoryName, setCurrentGroup, setSelectedCategory } =
		useStore(useShallow((state) => ({
			currentGroupId: state.currentGroupId,
			selectedCategoryId: state.selectedCategoryId,
			selectedCategoryName: state.selectedCategoryName,
			setCurrentGroup: state.setCurrentGroup,
			setSelectedCategory: state.setSelectedCategory,
		})));
	const groupsQuery = useGroups();
	const categoriesQuery = useCategories(currentGroupId);

	if (!currentGroupId) return null;

	const groupName = currentGroupId.startsWith("default_")
		? "开发商"
		: groupsQuery.data?.find((group) => group.id.toString() === currentGroupId)
				?.name ?? "收藏夹";
	const categoryName = selectedCategoryId === null
		? null
		: categoriesQuery.data?.find((category) => category.id === selectedCategoryId)
				?.name ??
			selectedCategoryName ??
			"分类";

	return (
		<Box
			className="flex items-center min-w-0"
			sx={{ color: "text.secondary", fontSize: "0.875rem", maxWidth: 360 }}
		>
			<Typography
				component="button"
				type="button"
				variant="body2"
				color="text.secondary"
				noWrap
				onClick={() => {
					setCurrentGroup(null);
					setSelectedCategory(null);
					navigate("/collection");
				}}
				sx={{ border: 0, background: "transparent", p: 0, cursor: "pointer", "&:hover": { color: "primary.main" } }}
			>
				收藏夹
			</Typography>
			<Typography component="span" variant="body2" color="text.disabled" sx={{ mx: 0.75 }}>
				›
			</Typography>
			{selectedCategoryId === null ? (
				<Typography component="span" variant="body2" color="text.primary" noWrap sx={{ maxWidth: 150 }}>
					{groupName}
				</Typography>
			) : (
				<>
					<Typography
						component="button"
						type="button"
						variant="body2"
						color="text.secondary"
						noWrap
						onClick={() => {
							setSelectedCategory(null);
							navigate("/collection");
						}}
						sx={{ border: 0, background: "transparent", p: 0, cursor: "pointer", maxWidth: 130, "&:hover": { color: "primary.main" } }}
					>
						{groupName}
					</Typography>
					<Typography component="span" variant="body2" color="text.disabled" sx={{ mx: 0.75 }}>
						›
					</Typography>
					<Typography component="span" variant="body2" color="text.primary" noWrap sx={{ maxWidth: 150 }}>
						{categoryName}
					</Typography>
				</>
			)}
		</Box>
	);
};

const CustomAppTitle = () => {
	const navigate = useNavigate();
	const location = useLocation();
	const { t } = useTranslation();
	const isLibraries = location.pathname === "/libraries";
	const isApplications = location.pathname === "/applications";
	const isCollection = location.pathname === "/collection";

	const handleBack = () => {
		saveScrollPosition(location.pathname);
		navigate(-1);
	};

	return (
		<Stack
			direction="row"
			alignItems="center"
			spacing={2}
			className="select-none"
		>
			<Tooltip title={t("components.AppLayout.back", "返回")} enterDelay={1000}>
				<span>
					<IconButton
						aria-label={t("components.AppLayout.back", "返回")}
						onClick={handleBack}
						size="large"
					>
						<ArrowBackRoundedIcon />
					</IconButton>
				</span>
			</Tooltip>
			<Avatar
				alt="Reina"
				src="/images/reina.png"
				onDragStart={(event) => event.preventDefault()}
			/>
			<Typography variant="h6">ReinaManager</Typography>
			{isCollection && <CollectionHeaderPath />}
			{isLibraries && <SearchBox />}
			{isApplications && <ApplicationsSearchBox />}
		</Stack>
	);
};

const HeaderSettingsButton = () => {
	const { t } = useTranslation();
	const location = useLocation();
	const label = t("app.NAVIGATION.settings", "设置");

	return (
		<Tooltip title={label} placement="bottom" enterDelay={350}>
			<span>
				<IconButton
					component={RouterLink}
					to="/settings"
					aria-label={label}
					aria-current={location.pathname === "/settings" ? "page" : undefined}
					color="primary"
					size="small"
					onClick={(event) => {
						event.stopPropagation();
						saveScrollPosition(location.pathname);
					}}
					sx={{
						width: 36,
						height: 36,
						borderRadius: 1.5,
						"&:hover": { bgcolor: "action.hover" },
					}}
				>
					<Badge
						color="primary"
						variant="dot"
						invisible={location.pathname !== "/settings"}
						overlap="circular"
					>
						<SettingsRoundedIcon />
					</Badge>
				</IconButton>
			</span>
		</Tooltip>
	);
};

const Header = () => (
	<AppBar
		color="inherit"
		position="absolute"
		className="print:hidden border-0 border-b border-solid shadow-none"
		sx={{
			borderColor: "divider",
			zIndex: (theme) => theme.zIndex.drawer + 1,
		}}
	>
		<Toolbar
			className="bg-inherit"
			sx={{
				mx: {
					xs: -0.75,
					sm: -1,
				},
			}}
		>
			<Stack
				direction="row"
				justifyContent="space-between"
				alignItems="center"
				className="w-full flex-wrap"
			>
				<CustomAppTitle />
				<Stack
					direction="row"
					alignItems="center"
					spacing={0.5}
					className="ml-auto"
				>
					<Toolbars />
					<HeaderSettingsButton />
				</Stack>
			</Stack>
		</Toolbar>
	</AppBar>
);

const BackToTopButton = () => {
	const { t } = useTranslation();
	const location = useLocation();
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const container = document.querySelector<HTMLElement>("main");
		if (!container) return;

		const updateVisible = () => setVisible(container.scrollTop > 320);
		updateVisible();
		container.addEventListener("scroll", updateVisible, { passive: true });

		return () => container.removeEventListener("scroll", updateVisible);
	}, []);

	const label = t("components.AppLayout.backToTop", "返回顶部");
	const handleClick = () => {
		setScrollPosition(location.pathname, 0);
		document
			.querySelector<HTMLElement>("main")
			?.scrollTo({ top: 0, behavior: "smooth" });
	};

	return (
		<Fade in={visible} unmountOnExit>
			<Tooltip title={label} enterDelay={1000}>
				<Fab
					color="primary"
					size="small"
					aria-label={label}
					className="print:hidden"
					onClick={handleClick}
					sx={{
						position: "fixed",
						right: { xs: 16, sm: 24 },
						bottom: { xs: 16, sm: 24 },
						zIndex: 40,
					}}
				>
					<KeyboardArrowUpRoundedIcon />
				</Fab>
			</Tooltip>
		</Fade>
	);
};

/**
 * 应用主布局组件
 * 集成侧边栏、顶部工具栏、页面容器等，支持自定义标题、国际化和响应式布局。
 *
 * @component
 * @returns {JSX.Element} 应用主布局
 */
export const Layout: React.FC = () => {
	return (
		<>
			<AddModal />
			<DashboardLayout
				slots={{
					header: Header,
					sidebarFooter: SidebarContent,
				}}
				defaultSidebarCollapsed={true}
			>
				<Outlet />
			</DashboardLayout>
			<BackToTopButton />
		</>
	);
};
export default Layout;
