import ClearIcon from "@mui/icons-material/Clear";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LoginIcon from "@mui/icons-material/Login";
import {
	Accordion,
	AccordionDetails,
	AccordionSummary,
	Avatar,
	Chip,
	IconButton,
	InputAdornment,
	Switch,
	Typography,
} from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputLabel from "@mui/material/InputLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { open as openurl } from "@tauri-apps/plugin-shell";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { getBgmAvatarUrl } from "@/api/bgm";
import { useBgmAuthController } from "@/hooks/features/useBgmAuthController";
import {
	useAllSettings,
	useUpdateSettings,
	useVndbCurrentUserProfile,
} from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { SettingsHelp } from "@/components/SettingsHelp";
import { useStore } from "@/store/appStore";
import type { BgmAuth } from "@/types";

// ==================== BGM Token 设置 ====================

type BgmAccountActionsProps = {
	showCompleteButton: boolean;
	isCompletingAuth: boolean;
	onCompleteAuth: () => void;
	onLogout: () => void;
};

const BgmAccountActions = ({
	showCompleteButton,
	isCompletingAuth,
	onCompleteAuth,
	onLogout,
}: BgmAccountActionsProps) => {
	const { t } = useTranslation();

	return (
		<Stack direction="row" spacing={1} alignItems="center">
			{showCompleteButton && (
				<Button
					variant="outlined"
					size="small"
					onClick={onCompleteAuth}
					disabled={isCompletingAuth}
				>
					{isCompletingAuth
						? t(
								"pages.Settings.bgmTokenSettings.queryingTokenStatus",
								"正在查询 Token 状态...",
							)
						: t(
								"pages.Settings.bgmTokenSettings.queryTokenStatus",
								"查询 Token 状态",
							)}
				</Button>
			)}
			<Button variant="outlined" color="error" size="small" onClick={onLogout}>
				{t("pages.Settings.bgmTokenSettings.logout", "退出登录")}
			</Button>
		</Stack>
	);
};

type BgmAccountSummaryProps = {
	bgmAuth?: BgmAuth | null;
	isCompletingAuth: boolean;
	onCompleteAuth: () => void;
	onLogout: () => void;
};

const BgmAccountSummary = ({
	bgmAuth,
	isCompletingAuth,
	onCompleteAuth,
	onLogout,
}: BgmAccountSummaryProps) => {
	const { t } = useTranslation();
	if (!bgmAuth?.access_token) return null;

	const isOAuth = Boolean(bgmAuth.refresh_token);
	const expiresAt = bgmAuth.expires_at ?? null;
	const expiresDate = expiresAt
		? new Date(expiresAt * 1000).toLocaleString()
		: null;
	const isExpired = expiresAt ? Date.now() / 1000 >= expiresAt : false;
	const username = bgmAuth.username ?? "";
	const displayName = bgmAuth.nickname || username;
	const shouldShowCompleteButton =
		!isOAuth && (bgmAuth.expires_at == null || !bgmAuth.username);
	const actions = (
		<BgmAccountActions
			showCompleteButton={shouldShowCompleteButton}
			isCompletingAuth={isCompletingAuth}
			onCompleteAuth={onCompleteAuth}
			onLogout={onLogout}
		/>
	);

	return (
		<Box className="mb-2">
			{username ? (
				<Stack direction="row" spacing={2} alignItems="flex-start">
					<Avatar
						src={getBgmAvatarUrl(username)}
						alt={displayName}
						sx={{ width: 44, height: 44 }}
					/>
					<Box className="flex-1 min-w-0">
						<Stack
							direction="row"
							spacing={1}
							alignItems="center"
							flexWrap="wrap"
						>
							<Typography variant="body1" className="font-semibold">
								{displayName}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								@{username}
							</Typography>
							<Chip
								label={isOAuth ? "OAuth" : "Access Token"}
								size="small"
								color={isOAuth ? "success" : "default"}
								variant="outlined"
							/>
						</Stack>
						<Typography
							variant="caption"
							color={isExpired ? "error.main" : "text.secondary"}
							className="block mt-1"
						>
							{expiresDate
								? t(
										"pages.Settings.bgmTokenSettings.tokenExpiresAt",
										"Token 有效期至: {{date}}",
										{ date: expiresDate },
									)
								: t(
										"pages.Settings.bgmTokenSettings.tokenExpiryUnknown",
										"Token 有效期未知",
									)}
						</Typography>
					</Box>
					{actions}
				</Stack>
			) : (
				<Stack spacing={1} alignItems="flex-start">
					<Typography variant="caption" color="text.secondary">
						{t(
							"pages.Settings.bgmTokenSettings.profileUnavailable",
							"暂无用户信息，请尝试下方按钮以获取用户信息。",
						)}
					</Typography>
					{actions}
				</Stack>
			)}
		</Box>
	);
};

type BgmOAuthLoginButtonProps = {
	isLoading: boolean;
	onLogin: () => void;
};

const BgmOAuthLoginButton = ({
	isLoading,
	onLogin,
}: BgmOAuthLoginButtonProps) => {
	const { t } = useTranslation();

	return (
		<Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
			<Button
				variant="contained"
				color="primary"
				startIcon={<LoginIcon />}
				onClick={onLogin}
				disabled={isLoading}
			>
				{isLoading
					? t(
							"pages.Settings.bgmTokenSettings.oauthWaiting",
							"请在浏览器中完成授权...",
						)
					: t("pages.Settings.bgmTokenSettings.oauthLogin", "OAuth 快捷登录")}
			</Button>
		</Stack>
	);
};

type BgmTokenLoginPanelProps = {
	summaryLabel?: string;
	inputToken: string;
	isSavingToken: boolean;
	onInputTokenChange: (value: string) => void;
	onSaveToken: () => void;
	onClearToken: () => void;
	onOpenTokenPage: () => void;
};

const BgmTokenLoginPanel = ({
	summaryLabel,
	inputToken,
	isSavingToken,
	onInputTokenChange,
	onSaveToken,
	onClearToken,
	onOpenTokenPage,
}: BgmTokenLoginPanelProps) => {
	const { t } = useTranslation();

	return (
		<Accordion className="w-full">
			<AccordionSummary expandIcon={<ExpandMoreIcon />}>
				<Typography variant="body2">
					{summaryLabel ?? t("pages.Settings.bgmTokenSettings.tokenLogin", "Access Token 登录")}
				</Typography>
			</AccordionSummary>
			<AccordionDetails>
				<Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
					<TextField
						autoComplete="off"
						placeholder={t(
							"pages.Settings.tokenPlaceholder",
							"请填写你的BGM TOKEN",
						)}
						value={inputToken}
						onChange={(e) => onInputTokenChange(e.target.value)}
						variant="outlined"
						size="medium"
						className="min-w-60"
						slotProps={{
							htmlInput: {
								style: {
									WebkitTextSecurity: "disc",
									textSecurity: "disc",
								},
							},
							input: {
								endAdornment: inputToken && (
									<InputAdornment position="end">
										<IconButton
											onClick={onClearToken}
											edge="end"
											size="small"
											aria-label={t(
												"pages.Settings.bgmTokenSettings.clearToken",
												"清除令牌",
											)}
										>
											<ClearIcon />
										</IconButton>
									</InputAdornment>
								),
							},
						}}
					/>
					<Button
						variant="contained"
						color="primary"
						onClick={onSaveToken}
						disabled={isSavingToken}
						className="px-6 py-2"
					>
						{isSavingToken
							? t(
									"pages.Settings.bgmTokenSettings.queryingTokenStatus",
									"正在查询 Token 状态...",
								)
							: t("pages.Settings.bgmTokenSettings.saveToken", "保存")}
					</Button>
					<Button
						variant="outlined"
						color="primary"
						onClick={onOpenTokenPage}
						className="px-6 py-2"
					>
						{t("pages.Settings.getToken", "获取令牌")}
					</Button>
				</Stack>
			</AccordionDetails>
		</Accordion>
	);
};

export const BgmTokenSettings = () => {
	const { t } = useTranslation();
	const {
		bgmAuth,
		inputToken,
		isOAuthLoading,
		isCompletingAuth,
		isSavingToken,
		setInputToken,
		handleOpenTokenPage,
		handleSaveToken,
		handleClearToken,
		handleOAuthLogin,
		handleCompleteAuth,
		handleLogout,
	} = useBgmAuthController();

	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.bgmToken", "BGM 令牌")}
			</InputLabel>
			<Box className="pl-1 space-y-2">
				<Box>
					<BgmAccountSummary
						bgmAuth={bgmAuth}
						isCompletingAuth={isCompletingAuth}
						onCompleteAuth={handleCompleteAuth}
						onLogout={handleLogout}
					/>
					{!bgmAuth?.access_token && (
						<Typography variant="caption" color="text.secondary">
							{t(
								"pages.Settings.bgmTokenSettings.profileUnavailable",
								"暂无用户信息，请尝试下方按钮以获取用户信息。",
							)}
						</Typography>
					)}
				</Box>

				{!bgmAuth?.access_token ? (
				<Stack spacing={1}>
					<Stack direction="row" alignItems="center">
							<InputLabel className="font-semibold">
								{t("pages.Settings.bgmTokenSettings.loginMethods", "登录方式")}
							</InputLabel>
							<SettingsHelp
								text={t(
									"pages.Settings.bgmTokenSettings.loginMethodsHint",
									"请任选一种登录方式，推荐 OAuth 快捷登录。",
								)}
							/>
						</Stack>
					<BgmOAuthLoginButton
						isLoading={isOAuthLoading}
						onLogin={handleOAuthLogin}
					/>
					<BgmTokenLoginPanel
						inputToken={inputToken}
						isSavingToken={isSavingToken}
						onInputTokenChange={setInputToken}
						onSaveToken={handleSaveToken}
						onClearToken={handleClearToken}
						onOpenTokenPage={handleOpenTokenPage}
					/>
				</Stack>
				) : (
					<BgmTokenLoginPanel
						summaryLabel={t(
							"pages.Settings.bgmTokenSettings.loginMethods",
							"更换登录方式",
						)}
						inputToken={inputToken}
						isSavingToken={isSavingToken}
						onInputTokenChange={setInputToken}
						onSaveToken={handleSaveToken}
						onClearToken={handleClearToken}
						onOpenTokenPage={handleOpenTokenPage}
					/>
				)}
			</Box>
		</Box>
	);
};

// ==================== VNDB Token 设置 ====================

export const VndbTokenSettings = () => {
	const { t } = useTranslation();
	const { data: settings } = useAllSettings();
	const vndbToken = settings?.vndb_token ?? "";
	const { data: vndbProfile, isLoading: isVndbProfileLoading } =
		useVndbCurrentUserProfile();
	const updateSettingsMutation = useUpdateSettings();
	const [inputToken, setInputToken] = useState("");

	useEffect(() => {
		setInputToken(vndbToken);
	}, [vndbToken]);

	const handleOpen = () => {
		openurl("https://vndb.org/u/tokens");
	};

	const handleSaveToken = async () => {
		try {
			await updateSettingsMutation.mutateAsync({
				vndbToken: inputToken,
			});
			snackbar.success(
				t(
					"pages.Settings.vndbTokenSettings.saveSuccess",
					"VNDB Token 保存成功",
				),
			);
		} catch (error) {
			console.error(error);
			snackbar.error(
				t("pages.Settings.vndbTokenSettings.saveError", "VNDB Token 保存失败"),
			);
		}
	};

	const handleClearToken = () => {
		setInputToken("");
	};

	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.vndbToken", "VNDB 令牌")}
			</InputLabel>
			{vndbToken && (
				<Box className="mb-4">
					{isVndbProfileLoading ? (
						<Typography variant="caption" color="text.secondary">
							{t(
								"pages.Settings.vndbTokenSettings.loadingProfile",
								"正在获取当前 VNDB 账号信息...",
							)}
						</Typography>
					) : vndbProfile ? (
						<Box>
							<Typography variant="body2" className="font-semibold">
								{vndbProfile.username}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								{t(
									"pages.Settings.vndbTokenSettings.userId",
									"用户 ID: {{id}}",
									{ id: vndbProfile.id },
								)}
							</Typography>
							<Typography
								variant="caption"
								color="text.secondary"
								className="block"
							>
								{t(
									"pages.Settings.vndbTokenSettings.permissions",
									"权限: {{permissions}}",
									{
										permissions: vndbProfile.permissions.join(", ") || "none",
									},
								)}
							</Typography>
						</Box>
					) : (
						<Typography variant="caption" color="text.secondary">
							{t(
								"pages.Settings.vndbTokenSettings.profileUnavailable",
								"当前 VNDB Token 无法获取用户信息，请检查令牌或权限是否有效。",
							)}
						</Typography>
					)}
				</Box>
			)}

			<Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
				<TextField
					autoComplete="off"
					placeholder={t(
						"pages.Settings.vndbTokenPlaceholder",
						"请填写你的 VNDB Token",
					)}
					value={inputToken}
					onChange={(e) => setInputToken(e.target.value)}
					variant="outlined"
					size="medium"
					className="min-w-60"
					slotProps={{
						htmlInput: {
							style: {
								WebkitTextSecurity: "disc",
								textSecurity: "disc",
							},
						},
						input: {
							endAdornment: inputToken && (
								<InputAdornment position="end">
									<IconButton
										onClick={handleClearToken}
										edge="end"
										size="small"
										aria-label={t(
											"pages.Settings.vndbTokenSettings.clearToken",
											"清除令牌",
										)}
									>
										<ClearIcon />
									</IconButton>
								</InputAdornment>
							),
						},
					}}
				/>
				<Button
					variant="contained"
					color="primary"
					onClick={handleSaveToken}
					disabled={updateSettingsMutation.isPending}
					className="px-6 py-2"
				>
					{t("pages.Settings.saveBtn", "保存")}
				</Button>
				<Button
					variant="outlined"
					color="primary"
					onClick={handleOpen}
					className="px-6 py-2"
				>
					{t("pages.Settings.getToken", "获取令牌")}
				</Button>
			</Stack>
		</Box>
	);
};

// ==================== 收藏同步设置 ====================

export const CollectionSyncSettings = () => {
	const { t } = useTranslation();
	const {
		syncBgmCollection,
		setSyncBgmCollection,
		syncVndbCollection,
		setSyncVndbCollection,
	} = useStore(
		useShallow((s) => ({
			syncBgmCollection: s.syncBgmCollection,
			setSyncBgmCollection: s.setSyncBgmCollection,
			syncVndbCollection: s.syncVndbCollection,
			setSyncVndbCollection: s.setSyncVndbCollection,
		})),
	);

	return (
		<Box>
			<InputLabel className="font-semibold mb-2">
				{t("pages.Settings.collectionSync.title", "收藏状态同步")}
			</InputLabel>
			<Box className="pl-1 space-y-1">
				<Stack direction="row" alignItems="center" spacing={1}>
					<Box sx={{ width: { sm: 250 }, flexShrink: 0 }}>
						<Stack direction="row" alignItems="center">
							<InputLabel className="font-semibold">
							{t(
								"pages.Settings.collectionSync.bgmTitle",
								"启用 Bangumi 收藏同步",
							)}
							</InputLabel>
							<SettingsHelp
								text={t(
								"pages.Settings.collectionSync.bgmDescription",
								"添加游戏时尝试读取 BGM 收藏状态，本地修改状态时同步回 BGM。",
							)}
							/>
						</Stack>
					</Box>
					<Switch
						checked={syncBgmCollection}
						onChange={(e) => setSyncBgmCollection(e.target.checked)}
						color="primary"
					/>
				</Stack>
				<Stack direction="row" alignItems="center" spacing={1}>
					<Box sx={{ width: { sm: 250 }, flexShrink: 0 }}>
						<Stack direction="row" alignItems="center">
							<InputLabel className="font-semibold">
							{t(
								"pages.Settings.collectionSync.vndbTitle",
								"启用 VNDB 收藏同步",
							)}
							</InputLabel>
							<SettingsHelp
								text={t(
								"pages.Settings.collectionSync.vndbDescription",
								"添加游戏时尝试读取 VNDB 收藏状态，本地修改状态时同步回 VNDB。",
							)}
							/>
						</Stack>
					</Box>
					<Switch
						checked={syncVndbCollection}
						onChange={(e) => setSyncVndbCollection(e.target.checked)}
						color="primary"
					/>
				</Stack>
			</Box>
		</Box>
	);
};
