import AccountCircleOutlinedIcon from "@mui/icons-material/AccountCircleOutlined";
import BackupOutlinedIcon from "@mui/icons-material/BackupOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PaletteOutlinedIcon from "@mui/icons-material/PaletteOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SettingsSuggestOutlinedIcon from "@mui/icons-material/SettingsSuggestOutlined";
import SportsEsportsOutlinedIcon from "@mui/icons-material/SportsEsportsOutlined";
import {
	Breadcrumbs,
	InputAdornment,
	Link,
	Paper,
	Stack,
	TextField,
	Typography,
} from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { PageContainer } from "@toolpad/core/PageContainer";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { PathSettingsModal } from "@/components/PathSettingsModal";
import { FolderBindingsModal } from "@/components/FolderBindingsModal";
import { AdvancedSettingsHelp } from "@/components/AdvancedSettingsHelp";
import { SettingsHelp } from "@/components/SettingsHelp";
import { ThemeModeSettings } from "@/components/ThemeModeSettings";
import { useScrollRestore } from "@/hooks/common/useScrollRestore";
import { AboutSection } from "./AboutSettings";
import {
	BgmTokenSettings,
	CollectionSyncSettings,
	VndbTokenSettings,
} from "./AccountSettings";
import { BackupCatalogSettings } from "./BackupCatalogSettings";
import { CacheManagementSection } from "./CacheSettings";
import {
	DevSettings,
	MixedSearchSourceSettings,
	VndbDataSettings,
} from "./DataSourceSettings";
import {
	CardClickModeSettings,
	GameLaunchSettings,
	InterfaceZoomSettings,
	LanguageSelect,
	NsfwSettings,
	StartupPageSettings,
} from "./GeneralSettings";
import { DatabaseBackupSettings } from "./MaintenanceSettings";
import { DiskHealthSettings } from "./DiskHealthSettings";
import { GameArchiveSettings } from "./GameArchiveSettings";
import { DownloadAutomationSettings } from "./DownloadAutomationSettings";
import {
	AutoStartSettings,
	CloseBtnSettings,
	LinuxLaunchCommandSettings,
	LogLevelSettings,
	TimeTrackingModeSettings,
} from "./SystemSettings";

type SettingsItem = {
	id: string;
	label: string;
	keywords: string;
	content: React.ReactNode;
};

type SettingsSection = {
	id: string;
	label: string;
	description: string;
	icon: React.ReactNode;
	items: SettingsItem[];
};

type SettingsPageHeaderProps = {
	title?: string;
	breadcrumbs?: { title: string; path: string }[];
};

const ACTIVE_SECTION_KEY = "reina:settingsActiveSection";

const SettingsPageHeader: React.FC<SettingsPageHeaderProps> = ({
	title,
	breadcrumbs = [],
}) => (
	<Box>
		<Breadcrumbs aria-label="breadcrumb">
			{breadcrumbs.map((item) => (
				<Link
					key={`${item.path}-${item.title}`}
					component={RouterLink}
					to={item.path}
					underline="hover"
					color="inherit"
				>
					{item.title}
				</Link>
			))}
		</Breadcrumbs>
		<Typography variant="h4" component="h1" className="mt-1 font-semibold">
			{title}
		</Typography>
	</Box>
);

const SettingsCard = ({
	id,
	children,
	highlighted,
}: {
	id: string;
	children: React.ReactNode;
	highlighted: boolean;
}) => (
	<Box
		component="section"
		id={`setting-${id}`}
		className="settings-item scroll-mt-6 px-5 py-4 transition-colors sm:px-6"
		sx={{
			backgroundColor: highlighted ? "action.hover" : "background.paper",
			boxShadow: highlighted ? 1 : 0,
			"& > .settings-card-body > .MuiBox-root": {
				marginBottom: "0 !important",
			},
			"& .MuiInputLabel-root": {
				lineHeight: 1.35,
				color: "text.primary",
				fontWeight: 600,
			},
			"& .MuiButton-root": {
				borderRadius: 2,
				minHeight: 36,
				textTransform: "none",
			},
			"& .MuiInputBase-root": {
				borderRadius: 2,
			},
			"& .MuiFormControlLabel-root": {
				marginLeft: 0,
			},
			"& .MuiAccordion-root": {
				backgroundColor: "transparent",
				boxShadow: "none",
				"&:before": { display: "none" },
			},
		}}
	>
		<Box className="settings-card-body">{children}</Box>
	</Box>
);

/**
 * 设置页面只重组现有设置组件，不改动各功能的状态来源和保存逻辑。
 */
export const Settings: React.FC = () => {
	const { t } = useTranslation();
	useScrollRestore("/settings");
	const [pathSettingsModalOpen, setPathSettingsModalOpen] = useState(false);
	const [folderBindingsModalOpen, setFolderBindingsModalOpen] = useState(false);
	const [searchText, setSearchText] = useState("");
	const [activeSectionId, setActiveSectionId] = useState(() =>
		window.localStorage.getItem(ACTIVE_SECTION_KEY) ?? "display",
	);
	const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
	const highlightTimerRef = useRef<number | null>(null);
	const pageTitle = t("app.NAVIGATION.settings", "设置");
	const breadcrumbs = useMemo(
		() => [
			{ title: t("app.NAVIGATION.home", "主页"), path: "/" },
			{ title: pageTitle, path: "/settings" },
		],
		[t, pageTitle],
	);

	const sections = useMemo<SettingsSection[]>(
		() => [
			{
				id: "display",
				label: t("pages.Settings.sections.display", "界面与操作"),
				description: t(
					"pages.Settings.sections.displayDescription",
					"语言、内容显示和卡片操作方式。",
				),
				icon: <PaletteOutlinedIcon />,
				items: [
					{
						id: "interface-zoom",
						label: t("pages.Settings.interfaceZoom.title", "界面缩放"),
						keywords: "界面 缩放 大小 zoom scale 80 100 150",
						content: <InterfaceZoomSettings />,
					},
					{
						id: "theme-mode",
						label: t("components.Toolbar.theme", "主题"),
						keywords: "主题 浅色 深色 跟随系统 light dark theme",
						content: <ThemeModeSettings />,
					},
					{
						id: "language",
						label: t("pages.Settings.language", "语言"),
						keywords: "language locale 中文 english 日本語",
						content: <LanguageSelect />,
					},
					{
						id: "startup-page",
						label: t("pages.Settings.startupPage.title", "启动默认页面"),
						keywords: "启动 默认 页面 上次 主页 游戏仓库 收藏夹 startup",
						content: <StartupPageSettings />,
					},
					{
						id: "card-click",
						label: t("pages.Settings.cardClickMode.title", "卡片点击模式"),
						keywords: "卡片 单击 双击 长按 启动 选择 分类 拖拽 排序",
						content: <CardClickModeSettings />,
					},
					{
						id: "nsfw",
						label: t("pages.Settings.nsfw.title", "NSFW 设置"),
						keywords: "nsfw 内容 过滤 封面 替换 cover filter",
						content: <NsfwSettings />,
					},
				],
			},
			{
				id: "game",
				label: t("pages.Settings.sections.game", "游戏与启动"),
				description: t(
					"pages.Settings.sections.gameDescription",
					"启动路径、伴生工具和游戏计时。",
				),
				icon: <SportsEsportsOutlinedIcon />,
				items: [
					...(import.meta.env.TAURI_ENV_PLATFORM === "windows"
						? [
								{
									id: "game-launch",
									label: t(
										"pages.Settings.gameLaunch.title",
										"游戏启动增强",
									),
									keywords: "启动 自动换盘 盘符 magpie 快捷键 全屏",
									content: <GameLaunchSettings />,
								},
							]
						: []),
					{
						id: "time-tracking",
						label: t("pages.Settings.timeTrackingMode.title", "游戏计时模式"),
						keywords: "游戏 时间 计时 playtime elapsed",
						content: <TimeTrackingModeSettings />,
					},
					{
						id: "game-archive",
						label: t("pages.Settings.gameArchive.title", "游戏打包"),
						keywords: "游戏 打包 压缩 7z zip 密码 归档 删除 原文件夹",
						content: <GameArchiveSettings />,
					},
					{
						id: "download-automation",
						label: "下载自动化",
						keywords: "下载 自动 入库 删除 Shionlib 队列",
						content: <DownloadAutomationSettings />,
					},
					...(import.meta.env.TAURI_ENV_PLATFORM === "linux"
						? [
								{
									id: "linux-command",
									label: t(
										"pages.Settings.linuxLaunchCommand.title",
										"Linux 启动命令",
									),
									keywords: "linux wine proton command 启动命令",
									content: <LinuxLaunchCommandSettings />,
								},
							]
						: []),
				],
			},
			{
				id: "account",
				label: t("pages.Settings.sections.account", "账号与数据源"),
				description: t(
					"pages.Settings.sections.accountDescription",
					"账号、同步、搜索源和元数据维护。",
				),
				icon: <AccountCircleOutlinedIcon />,
				items: [
					{
						id: "bgm-token",
						label: t("pages.Settings.bgmToken", "BGM 令牌"),
						keywords: "bgm bangumi 登录 oauth token 令牌",
						content: <BgmTokenSettings />,
					},
					{
						id: "vndb-token",
						label: t("pages.Settings.vndbToken", "VNDB 令牌"),
						keywords: "vndb token 令牌 登录",
						content: <VndbTokenSettings />,
					},
					{
						id: "collection-sync",
						label: t("pages.Settings.collectionSync.title", "收藏状态同步"),
						keywords: "收藏 同步 状态 bgm vndb sync",
						content: <CollectionSyncSettings />,
					},
					{
						id: "mixed-source",
						label: t("pages.Settings.mixedSearchSources.title", "Mixed 搜索源"),
						keywords: "mixed 搜索 数据源 bgm vndb ymgal kun",
						content: <MixedSearchSourceSettings />,
					},
					{
						id: "vndb-data",
						label: t("pages.Settings.vndbData.title", "VNDB 数据设置"),
						keywords: "vndb tag 标签 翻译 剧透 spoiler",
						content: <VndbDataSettings />,
					},
					{
						id: "experimental",
						label: t("pages.Settings.dev.title", "实验性功能"),
						keywords: "实验 批量 更新 bgm vndb metadata",
						content: <DevSettings />,
					},
				],
			},
			{
				id: "storage",
				label: t("pages.Settings.sections.storage", "备份与存储"),
				description: t(
					"pages.Settings.sections.storageDescription",
					"路径、数据库备份、115 目录和缓存。",
				),
				icon: <BackupOutlinedIcon />,
				items: [
					{
						id: "database-backup",
						label: t("pages.Settings.databaseBackup.title", "数据备份与恢复"),
						keywords:
							"数据库 自动 月度 定时 备份 恢复 导入 封面 backup restore monthly",
						content: <DatabaseBackupSettings />,
					},
					{
						id: "backup-catalog",
						label: t("pages.Settings.backupCatalog.title", "115 游戏备份目录"),
						keywords: "115 网盘 目录树 压缩包 匹配 备份 catalog archive",
						content: <BackupCatalogSettings />,
					},
					{
						id: "cache",
						label: t("pages.Settings.cacheSettings.title", "缓存管理"),
						keywords: "缓存 封面 清理 cache cover",
						content: <CacheManagementSection />,
					},
					{
						id: "paths",
						label: t("pages.Settings.pathSettings.title", "路径设置"),
						keywords: "路径 操作目录 存档 le magpie 数据库 备份 工具 压缩包 连接 folder path workspace tool archive",
						content: (
							<Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="flex-start" spacing={1}>
								<Stack direction="row" alignItems="center">
									<Typography variant="subtitle1" className="font-semibold">
										{t("pages.Settings.pathSettings.title", "路径设置")}
									</Typography>
									<SettingsHelp
										text={t(
											"pages.Settings.pathSettings.note",
											"集中管理存档、外部工具和数据库备份路径。",
										)}
									/>
								</Stack>
								<Button variant="outlined" startIcon={<FolderOpenOutlinedIcon />} onClick={() => setPathSettingsModalOpen(true)}>
									{t("pages.Settings.pathSettings.openModal", "管理路径")}
								</Button>
							</Stack>
						),
					},
					{
						id: "folder-bindings",
						label: "目录关联",
						keywords: "目录 关联 游戏 批量 导入 扫描 根目录 收藏夹 分类 应用 来源 快捷方式",
						content: (
							<Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="flex-start" spacing={1}>
								<Stack direction="row" alignItems="center">
									<Typography variant="subtitle1" className="font-semibold">目录关联</Typography>
									<AdvancedSettingsHelp
										tooltip="集中管理扫描根目录与分类来源目录；只在需要时读取。"
										title="目录关联说明"
										sections={[
											{
												title: "默认游戏扫描目录",
												content: "未手动选择根文件夹时，批量导入会按这里的顺序扫描；手动选择后只扫描本次选择的目录。它不会持续扫描或监听这些文件夹。",
											},
											{
												title: "游戏分类来源目录",
												content: "导入成功的游戏启动文件位于某个来源目录或其子目录时，会附加到对应收藏夹分类。重叠目录优先使用更深的一项，不会移除已有分类。",
											},
											{
												title: "应用来源目录",
												content: "只在你手动点击扫描时读取每个目录的一层 .lnk、.url 和 .exe，并把新项目加入绑定分类。不会递归扫描、常驻监听、移动或删除原文件。",
											},
										]}
									/>
								</Stack>
								<Button variant="outlined" startIcon={<AccountTreeOutlinedIcon />} onClick={() => setFolderBindingsModalOpen(true)}>管理目录关联</Button>
							</Stack>
						),
					},
				],
			},
			{
				id: "system",
				label: t("pages.Settings.sections.system", "系统"),
				description: t(
					"pages.Settings.sections.systemDescription",
					"应用启动、关闭行为和日志。",
				),
				icon: <SettingsSuggestOutlinedIcon />,
				items: [
					{
						id: "auto-start",
						label: t("pages.Settings.autoStart", "开机自启"),
						keywords: "开机 自启 自动启动 autostart",
						content: <AutoStartSettings />,
					},
					{
						id: "close-behavior",
						label: t("pages.Settings.closeSettings", "关闭设置"),
						keywords: "关闭 托盘 退出 提醒 tray exit",
						content: <CloseBtnSettings />,
					},
					{
						id: "logs",
						label: t("pages.Settings.logLevel.title", "日志设置"),
						keywords: "日志 log level 文件夹 调试",
						content: <LogLevelSettings />,
					},
					...(import.meta.env.TAURI_ENV_PLATFORM === "windows"
						? [
								{
									id: "disk-health",
									label: t(
										"pages.Settings.diskHealth.title",
										"磁盘健康",
									),
									keywords:
										"硬盘 磁盘 健康 温度 smart crystal disk info diskinfo",
									content: <DiskHealthSettings />,
								},
							]
						: []),
				],
			},
			{
				id: "about",
				label: t("pages.Settings.sections.about", "关于"),
				description: t(
					"pages.Settings.sections.aboutDescription",
					"版本、更新、文档和反馈。",
				),
				icon: <InfoOutlinedIcon />,
				items: [
					{
						id: "about-app",
						label: t("pages.Settings.sections.about", "关于"),
						keywords: "版本 更新 作者 github 文档 反馈 about update",
						content: <AboutSection />,
					},
				],
			},
		],
		[t],
	);

	useEffect(() => {
		if (!sections.some((section) => section.id === activeSectionId)) {
			setActiveSectionId(sections[0]?.id ?? "display");
			return;
		}
		window.localStorage.setItem(ACTIVE_SECTION_KEY, activeSectionId);
	}, [activeSectionId, sections]);

	useEffect(
		() => () => {
			if (highlightTimerRef.current !== null) {
				window.clearTimeout(highlightTimerRef.current);
			}
		},
		[],
	);

	const normalizedSearch = searchText.trim().toLocaleLowerCase();
	const searchResults = useMemo(
		() =>
			normalizedSearch
				? sections.flatMap((section) =>
						section.items
							.filter((item) =>
								`${item.label} ${item.keywords}`
									.toLocaleLowerCase()
									.includes(normalizedSearch),
							)
							.map((item) => ({ section, item })),
					)
				: [],
		[normalizedSearch, sections],
	);

	const openSection = (sectionId: string) => {
		setSearchText("");
		setActiveSectionId(sectionId);
		setHighlightedItemId(null);
		window.requestAnimationFrame(() => {
			document
				.getElementById(`settings-section-${sectionId}`)
				?.scrollIntoView({ behavior: "smooth", block: "start" });
		});
	};

	const openSearchResult = (sectionId: string, itemId: string) => {
		setSearchText("");
		setActiveSectionId(sectionId);
		setHighlightedItemId(itemId);
		window.requestAnimationFrame(() =>
			document
				.getElementById(`setting-${itemId}`)
				?.scrollIntoView({ behavior: "smooth", block: "center" }),
		);
		if (highlightTimerRef.current !== null) {
			window.clearTimeout(highlightTimerRef.current);
		}
		highlightTimerRef.current = window.setTimeout(
			() => setHighlightedItemId(null),
			1800,
		);
	};

	useEffect(() => {
		if (normalizedSearch) return;
		const sectionElements = sections
			.map((section) => document.getElementById(`settings-section-${section.id}`))
			.filter((element): element is HTMLElement => element !== null);
		if (!sectionElements.length) return;

		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((entry) => entry.isIntersecting)
					.sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
				const sectionId = visible[0]?.target.getAttribute("data-settings-section");
				if (sectionId) setActiveSectionId(sectionId);
			},
			{ rootMargin: "-18% 0px -64%", threshold: 0 },
		);
		sectionElements.forEach((element) => {
			observer.observe(element);
		});
		return () => observer.disconnect();
	}, [normalizedSearch, sections]);

	return (
		<PageContainer
			className="w-full max-w-full"
			title={pageTitle}
			breadcrumbs={breadcrumbs}
			slots={{ header: SettingsPageHeader }}
			sx={{ maxWidth: "100% !important" }}
		>
			<Box className="mx-auto grid w-full max-w-[1440px] grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
				<Paper
					component="nav"
					variant="outlined"
					className="sticky top-4 z-10 h-fit overflow-x-auto rounded-2xl p-2 lg:overflow-visible lg:p-3"
					aria-label={t("pages.Settings.navigation", "设置分类导航")}
				>
					<Box className="flex min-w-max gap-1.5 lg:min-w-0 lg:flex-col">
						{sections.map((section) => {
							const isActive = section.id === activeSectionId && !normalizedSearch;
							return (
								<button
									key={section.id}
									type="button"
									onClick={() => openSection(section.id)}
									className={`flex cursor-pointer items-center gap-2.5 rounded-xl border-0 px-3 py-2.5 text-left text-sm transition-all lg:w-full ${
										isActive
											? "bg-[var(--mui-palette-primary-main)] text-[var(--mui-palette-primary-contrastText)] shadow-sm"
											: "bg-transparent text-[var(--mui-palette-text-primary)] hover:bg-[var(--mui-palette-action-hover)]"
									}`}
								>
									<span className="flex shrink-0 [&>svg]:text-[1.15rem]">
										{section.icon}
									</span>
									<span className="font-medium">{section.label}</span>
								</button>
							);
						})}
					</Box>
				</Paper>

				<Box id="settings-content" className="min-w-0 scroll-mt-6">
					<TextField
						fullWidth
						size="small"
						value={searchText}
						onChange={(event) => setSearchText(event.target.value)}
						placeholder={t(
							"pages.Settings.searchPlaceholder",
							"搜索设置，例如 Magpie、双击启动、备份路径",
						)}
						inputProps={{ "aria-label": t("pages.Settings.search", "搜索设置") }}
						InputProps={{
							startAdornment: (
								<InputAdornment position="start">
									<SearchIcon fontSize="small" />
								</InputAdornment>
							),
						}}
						sx={{
							mb: 3,
							"& .MuiOutlinedInput-root": {
								borderRadius: 3,
								backgroundColor: "background.paper",
							},
						}}
					/>

					{normalizedSearch ? (
						<Box>
							<Typography variant="h6" className="mb-3 font-semibold">
								{t("pages.Settings.searchResults", "搜索结果")}
							</Typography>
							{searchResults.length > 0 ? (
								<Paper variant="outlined" className="overflow-hidden rounded-2xl">
									{searchResults.map(({ section, item }, index) => (
										<button
											key={`${section.id}-${item.id}`}
											type="button"
											onClick={() => openSearchResult(section.id, item.id)}
											className={`flex w-full cursor-pointer items-center justify-between gap-4 border-0 bg-transparent px-4 py-3 text-left transition-colors hover:bg-[var(--mui-palette-action-hover)] ${
												index > 0
													? "border-t border-solid border-[var(--mui-palette-divider)]"
													: ""
											}`}
										>
											<span className="font-medium text-[var(--mui-palette-text-primary)]">
												{item.label}
											</span>
											<span className="shrink-0 text-xs text-[var(--mui-palette-text-secondary)]">
												{section.label}
											</span>
										</button>
									))}
								</Paper>
							) : (
								<Paper
									variant="outlined"
									className="rounded-2xl px-5 py-10 text-center"
								>
									<Typography color="text.secondary">
										{t("pages.Settings.searchNoResults", "没有找到相关设置")}
									</Typography>
								</Paper>
							)}
						</Box>
					) : (
						<Stack spacing={{ xs: 5, sm: 7 }}>
							{sections.map((section) => (
								<Box
									key={section.id}
									component="section"
									id={`settings-section-${section.id}`}
									data-settings-section={section.id}
									className="scroll-mt-6"
								>
									<Stack direction="row" spacing={1.25} alignItems="center" className="mb-3">
										<Box className="flex shrink-0 text-[var(--mui-palette-text-primary)] [&>svg]:text-[1.35rem]">
											{section.icon}
										</Box>
										<Typography variant="h6" component="h2" className="font-semibold">
											{section.label}
										</Typography>
										<SettingsHelp text={section.description} />
									</Stack>
									<Stack spacing={1.5}>
										{section.items.map((item) => (
											<Paper
												key={item.id}
												variant="outlined"
												className="overflow-hidden rounded-2xl"
												sx={{
													"& .settings-card-body > .mb-6": { marginBottom: "0 !important" },
													"& .settings-card-body > .mb-8": { marginBottom: "0 !important" },
												}}
											>
												<SettingsCard
													id={item.id}
													highlighted={highlightedItemId === item.id}
												>
													{item.content}
												</SettingsCard>
											</Paper>
										))}
									</Stack>
								</Box>
							))}
						</Stack>
					)}
				</Box>
			</Box>

			<PathSettingsModal
				open={pathSettingsModalOpen}
				onClose={() => setPathSettingsModalOpen(false)}
				inSettingsPage={true}
			/>
			<FolderBindingsModal
				open={folderBindingsModalOpen}
				onClose={() => setFolderBindingsModalOpen(false)}
			/>
		</PageContainer>
	);
};
