import {
	Box,
	Checkbox,
	FormControl,
	FormControlLabel,
	InputLabel,
	MenuItem,
	Select,
	Stack,
	Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { AdvancedSettingsHelp } from "@/components/AdvancedSettingsHelp";

import { useAllSettings, useUpdateSettings } from "@/hooks/queries/useSettings";
import { snackbar } from "@/providers/snackBar";
import { useModStore } from "@/store/modStore";

/** 只保存归档偏好；密码始终在执行打包时临时输入，不会写进设置或备份。 */
export const GameArchiveSettings = () => {
	const { t } = useTranslation();
	const settings = useModStore((state) => state.gameArchiveSettings);
	const updateSettings = useModStore((state) => state.updateGameArchiveSettings);
	const { data: persistedSettings } = useAllSettings();
	const updatePersistedSettings = useUpdateSettings();
	const protectGamesRootChildren =
		persistedSettings?.protect_games_root_children !== false;

	const setGamesRootProtection = async (enabled: boolean) => {
		if (!enabled && !window.confirm("关闭后，盘符根目录 Games 下的直属目录也可能被打包后删除。请确认该目录确实是单个游戏目录。")) {
			return;
		}
		try {
			await updatePersistedSettings.mutateAsync({
				protectGamesRootChildren: enabled,
			});
		} catch (error) {
			snackbar.error(error instanceof Error ? error.message : "保存目录保护设置失败");
		}
	};

	return (
		<Box>
			<Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
				<Typography variant="subtitle1" className="font-semibold">
					{t("pages.Settings.gameArchive.title", "游戏打包")}
				</Typography>
				<AdvancedSettingsHelp
					tooltip="查看打包流程、适用场景与删除保护。"
					title="游戏打包与云端化说明"
					sections={[
						{
							title: "适用场景",
							content: "用于把一个已有主路径的本地游戏目录压缩到同级位置，以便腾出磁盘空间或留作离线备份。它不会下载、上传或改变游戏资料。",
						},
						{
							title: "使用步骤",
							content: "先在这里选格式和压缩等级；再从游戏卡片右键菜单选择“打包游戏”。如勾选删除原目录，系统会先完成压缩并核验内容，再按这里的删除方式处理原目录。",
						},
						{
							title: "格式、压缩率与密码",
							content: "7z 通常压缩率更高，适合长期归档；zip 兼容性更好，适合交给其它工具打开。等级越高通常越省空间，也会花更久。密码只在本次执行时输入，不会保存；“加密文件名”只适用于带密码的 7z 归档。",
						},
						{
							title: "安全限制",
							content: "只能处理该游戏当前主路径所属的普通目录。归档校验失败或目录在操作中变化时，删除会被拒绝。默认还会保护盘符根目录 Games 下的直属目录；如果你的目录结构不同，可在下方明确关闭这项保护。",
						},
						{
							title: "完成后的状态",
							content: "只打包时，原目录与游戏状态不变。成功删除原目录后，主路径会被移除、原路径保留在路径历史中，游戏显示为云端游戏；任务状态可从左侧栏随时查看。",
						},
					]}
				/>
			</Stack>
			<Stack
				direction={{ xs: "column", sm: "row" }}
				spacing={1}
				alignItems={{ sm: "center" }}
				useFlexGap
				flexWrap="wrap"
			>
				<FormControl size="small" sx={{ minWidth: 140 }}>
					<InputLabel id="game-archive-format-label">{t("pages.Settings.gameArchive.format", "归档格式")}</InputLabel>
					<Select
						labelId="game-archive-format-label"
						label={t("pages.Settings.gameArchive.format", "归档格式")}
						value={settings.format}
						onChange={(event) => updateSettings({ format: event.target.value as "7z" | "zip" })}
					>
						<MenuItem value="7z">7z</MenuItem>
						<MenuItem value="zip">zip</MenuItem>
					</Select>
				</FormControl>
				<FormControl size="small" sx={{ minWidth: 160 }}>
					<InputLabel id="game-archive-level-label">{t("pages.Settings.gameArchive.level", "压缩等级")}</InputLabel>
					<Select
						labelId="game-archive-level-label"
						label={t("pages.Settings.gameArchive.level", "压缩等级")}
						value={settings.compressionLevel}
						onChange={(event) => updateSettings({ compressionLevel: Number(event.target.value) })}
					>
						{[0, 1, 3, 5, 7, 9].map((level) => (
							<MenuItem key={level} value={level}>{level === 0 ? t("pages.Settings.gameArchive.store", "仅存储") : `${level} / 9`}</MenuItem>
						))}
					</Select>
				</FormControl>
				<FormControl size="small" sx={{ minWidth: 180 }}>
					<InputLabel id="game-archive-delete-behavior-label">删除方式</InputLabel>
					<Select labelId="game-archive-delete-behavior-label" label="删除方式" value={settings.deleteBehavior} onChange={(event) => updateSettings({ deleteBehavior: event.target.value as "permanent" | "recycle" })}>
						<MenuItem value="recycle">移入回收站</MenuItem>
						<MenuItem value="permanent">永久删除</MenuItem>
					</Select>
				</FormControl>
			</Stack>
			<Stack
				direction={{ xs: "column", sm: "row" }}
				sx={{ mt: 1 }}
				spacing={1}
				useFlexGap
				flexWrap="wrap"
			>
				<FormControlLabel
					labelPlacement="start"
					sx={{ gap: 0.75, ml: 0 }}
					control={<Checkbox checked={settings.requirePassword} onChange={(event) => updateSettings({ requirePassword: event.target.checked })} />}
					label={t("pages.Settings.gameArchive.requirePassword", "打包时要求密码")}
				/>
				<FormControlLabel
					labelPlacement="start"
					sx={{ gap: 0.75, ml: 0 }}
					disabled={settings.format !== "7z" || !settings.requirePassword}
					control={<Checkbox checked={settings.encryptHeaders} onChange={(event) => updateSettings({ encryptHeaders: event.target.checked })} />}
					label={t("pages.Settings.gameArchive.encryptHeaders", "加密文件名")}
				/>
				<FormControlLabel
					labelPlacement="start"
					sx={{ gap: 0.75, ml: 0 }}
					control={<Checkbox checked={protectGamesRootChildren} disabled={updatePersistedSettings.isPending} onChange={(event) => void setGamesRootProtection(event.target.checked)} />}
					label="保护盘符 Games 直属目录"
				/>
			</Stack>
		</Box>
	);
};
