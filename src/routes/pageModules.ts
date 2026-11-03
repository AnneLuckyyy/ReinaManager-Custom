export const loadHomePage = () => import("@/pages/HomePage").then((module) => ({ default: module.Home }));
export const loadLibrariesPage = () => import("@/pages/LibrariesPage").then((module) => ({ default: module.Libraries }));
export const loadDetailPage = () => import("@/pages/Detail").then((module) => ({ default: module.Detail }));
export const loadCollectionPage = () => import("@/pages/CollectionPage").then((module) => ({ default: module.Collection }));
export const loadSettingsPage = () => import("@/pages/Settings").then((module) => ({ default: module.Settings }));
export const loadDownloadTasksPage = () => import("@/pages/DownloadTasksPage").then((module) => ({ default: module.DownloadTasksPage }));
export const loadApplicationsPage = () => import("@/pages/ApplicationsPage").then((module) => ({ default: module.ApplicationsPage }));

// 仅预热高频大型页面的组件代码；不挂载页面、不请求游戏数据，也不创建后台任务。
export const warmFrequentlyUsedPageModules = () => Promise.all([
	loadLibrariesPage(),
	loadCollectionPage(),
	loadApplicationsPage(),
]);
