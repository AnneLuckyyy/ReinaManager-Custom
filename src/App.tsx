import "./App.css";
import "@/utils/i18n";
import HomeIcon from "@mui/icons-material/Home";
import GamesIcon from "@mui/icons-material/Games";
import CategoryIcon from "@mui/icons-material/Category";
import WidgetsRoundedIcon from "@mui/icons-material/WidgetsRounded";
import { SnackbarProvider } from "notistack";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import WindowsHandler from "@/components/Windows";
import { ShionlibInstallRequestHandler } from "@/components/ShionlibInstallRequestHandler";
import { GameArchiveTaskStatus } from "@/components/GameArchiveTaskStatus";
import { ThemeWindowSync } from "@/components/ThemeModeSettings";
import { UiZoom } from "@/components/UiZoom";
import { SnackbarUtilsConfigurator } from "@/providers/snackBar";
import { ToolpadReactRouterAppProvider } from "@/providers/ToolpadReactRouterAppProvider";
import { warmFrequentlyUsedPageModules } from "@/routes/pageModules";
import { useModStore } from "@/store/modStore";
import { initBgmAuthRefresh } from "@/utils/bgmAuthSession";
import { refreshDiskHealth } from "@/utils/diskHealth";
import { runMonthlyDatabaseBackupIfDue } from "@/utils/monthlyDatabaseBackup";

// 导航配置模板（模块级常量，title 在组件内惰性初始化）
// Toolpad DashboardLayout 对 navigation prop 引用稳定性极其敏感。
// 使用 useRef 惰性初始化确保 navigation 引用在整个组件生命周期内不变。
const NAV_CONFIG = [
	{ segment: "", key: "app.NAVIGATION.home", fallback: "主页", icon: <HomeIcon /> },
	{ segment: "libraries", key: "app.NAVIGATION.gameLibrary", fallback: "游戏仓库", icon: <GamesIcon /> },
	{ segment: "collection", key: "app.NAVIGATION.collection", fallback: "收藏夹", icon: <CategoryIcon /> },
	{ segment: "applications", key: "app.NAVIGATION.applications", fallback: "应用", icon: <WidgetsRoundedIcon /> },
];

const LAST_ROUTE_KEY = "reina:lastRoute";
const FIXED_STARTUP_PAGE_PATHS = {
	home: "/",
	libraries: "/libraries",
	collection: "/collection",
} as const;

/**
 * RoutePersistence 组件
 * 记录最后一次访问的路由，重启时恢复到该路由。
 * 必须在 ToolpadReactRouterAppProvider 内部渲染（需要 useLocation/useNavigate）。
 */
function RoutePersistence({ children }: { children: ReactNode }) {
	const location = useLocation();
	const navigate = useNavigate();
	const startupPage = useModStore((state) => state.startupPage);
	const restoredRef = useRef(false);

	// 只处理正常从根页面启动的首次挂载，明确给出的页面地址必须保留。
	useEffect(() => {
		if (restoredRef.current) return;
		restoredRef.current = true;
		if (location.pathname !== "/" || location.search) return;

		const lastRoute = window.localStorage.getItem(LAST_ROUTE_KEY);
		const current = location.pathname + location.search;
		const startupRoute =
			startupPage === "last"
				? lastRoute
				: FIXED_STARTUP_PAGE_PATHS[startupPage];
		if (startupRoute && startupRoute !== current && startupRoute !== "/") {
			navigate(startupRoute, { replace: true });
		}
	}, [location.pathname, location.search, navigate, startupPage]);

	// 每次路由变化时记录，供“保持上次停留页面”在下次启动时使用。
	useEffect(() => {
		window.localStorage.setItem(LAST_ROUTE_KEY, location.pathname + location.search);
	}, [location.pathname, location.search]);

	return <>{children}</>;
}

const App: React.FC = () => {
	const { t } = useTranslation();

	useEffect(() => {
		void initBgmAuthRefresh();
	}, []);

	useEffect(() => {
		const preloadTimer = window.setTimeout(() => {
			void warmFrequentlyUsedPageModules();
		}, 1500);
		return () => window.clearTimeout(preloadTimer);
	}, []);

	useEffect(() => {
		const checkMonthlyDatabaseBackup = () => {
			void runMonthlyDatabaseBackupIfDue();
		};

		checkMonthlyDatabaseBackup();
		const intervalId = window.setInterval(
			checkMonthlyDatabaseBackup,
			60 * 60 * 1000,
		);
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				checkMonthlyDatabaseBackup();
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			window.clearInterval(intervalId);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, []);

	useEffect(() => {
		const checkDiskHealth = () => {
			void refreshDiskHealth().catch((error) => {
				console.warn("磁盘状态读取失败:", error);
			});
		};

		checkDiskHealth();
		const intervalId = window.setInterval(checkDiskHealth, 10 * 60 * 1000);
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") checkDiskHealth();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			window.clearInterval(intervalId);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, []);

	// useRef 惰性初始化：只在组件挂载时计算一次 Navigation
	// 一旦赋值，navRef.current 的引用永远不会变
	const navRef = useRef<Array<{ segment: string; title: string; icon: React.ReactNode }> | null>(null);
	if (navRef.current === null) {
		navRef.current = NAV_CONFIG.map((item) => ({
			segment: item.segment,
			title: t(item.key, item.fallback),
			icon: item.icon,
		}));
	}

	return (
		<SnackbarProvider
			maxSnack={3}
			autoHideDuration={3000}
			anchorOrigin={{ vertical: "top", horizontal: "center" }}
		>
			<SnackbarUtilsConfigurator />
			<UiZoom />
			<ToolpadReactRouterAppProvider navigation={navRef.current}>
				<ThemeWindowSync />
				<WindowsHandler />
				<ShionlibInstallRequestHandler />
				<GameArchiveTaskStatus />
				<RoutePersistence>
					<Outlet />
				</RoutePersistence>
			</ToolpadReactRouterAppProvider>
		</SnackbarProvider>
	);
};

export default App;
