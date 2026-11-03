import ClearAllIcon from "@mui/icons-material/ClearAll";
import { CircularProgress, Typography } from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputLabel from "@mui/material/InputLabel";
import Stack from "@mui/material/Stack";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { snackbar } from "@/providers/snackBar";
import { SettingsHelp } from "@/components/SettingsHelp";
import { fileService, gameService } from "@/services/invoke";
import { gameKeys } from "@/hooks/queries/useGames";
import { getUserErrorMessage } from "@/utils/errors";

/**
 * 缓存管理组件
 * 实现并行的云端封面缓存清理，包含分批处理以减轻 IO 压力
 */
export const CacheManagementSection = () => {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [isClearing, setIsClearing] = useState(false);
	const [progress, setProgress] = useState({ current: 0, total: 0 });

	const handleClearCache = async () => {
		setIsClearing(true);
		setProgress({ current: 0, total: 0 });

		try {
			// 1. 获取所有游戏数据
			const allGames = await gameService.getAllGames();
			const total = allGames.length;
			setProgress({ current: 0, total });

			let successCount = 0;
			let failedCount = 0;
			const BATCH_SIZE = 20;

			// 2. 分批处理清理逻辑
			for (let i = 0; i < total; i += BATCH_SIZE) {
				const batch = allGames.slice(i, i + BATCH_SIZE);
				const results = await Promise.allSettled(
					batch.map(async (game) => {
						if (game.id === undefined) return;
						return fileService.deleteCloudCoverCache(game.id);
					}),
				);

				// 统计本批次结果
				for (const result of results) {
					if (result.status === "fulfilled") {
						successCount++;
					} else {
						failedCount++;
						console.warn("清理缓存失败:", result.reason);
					}
				}

				// 更新进度
				setProgress((prev) => ({
					...prev,
					current: Math.min(i + BATCH_SIZE, total),
				}));
			}

			// 3. 清理完成后刷新相关查询
			// 必须刷新游戏列表和相关的封面缓存状态，防止 UI 继续引用已删除的资源
			await queryClient.invalidateQueries({ queryKey: gameKeys.all });
			
			// 弹出详细反馈
			if (failedCount === 0) {
				snackbar.success(
					t("pages.Settings.cacheSettings.clearSuccess", "缓存清理完成") +
						` (${successCount}/${total})`,
				);
			} else {
				snackbar.warning(
					t("pages.Settings.cacheSettings.clearPartialSuccess", "缓存清理完成，但部分失败") +
						` (${successCount} 成功, ${failedCount} 失败)`,
				);
			}
		} catch (error) {
			const errorMessage = getUserErrorMessage(
				error,
				t,
				t("pages.Settings.cacheSettings.clearFailed", "清理缓存失败"),
			);
			snackbar.error(errorMessage);
		} finally {
			setIsClearing(false);
		}
	};

	return (
		<Box>
			<Stack
				direction={{ xs: "column", sm: "row" }}
				spacing={1.5}
				alignItems={{ sm: "center" }}
				justifyContent="flex-start"
			>
				<Stack direction="row" alignItems="center">
					<InputLabel className="font-semibold">
						{t("pages.Settings.cacheSettings.title", "缓存管理")}
					</InputLabel>
					<SettingsHelp
						text={t(
							"pages.Settings.cacheSettings.note",
							"清理自动下载的云端封面缓存，释放存储空间。注意：这不会删除您的自定义封面。",
						)}
					/>
				</Stack>
				<Button
					variant="outlined"
					color="primary"
					onClick={handleClearCache}
					disabled={isClearing}
					startIcon={
						isClearing ? (
							<CircularProgress size={16} color="inherit" />
						) : (
							<ClearAllIcon />
						)
					}
					className="px-6 py-2"
				>
					{isClearing
						? t("pages.Settings.cacheSettings.clearing", "清理中...")
						: t("pages.Settings.cacheSettings.clearCache", "清理云端封面缓存")}
				</Button>
			</Stack>

			{isClearing && (
				<Typography variant="body2" color="text.secondary" className="mt-2">
					{t("pages.Settings.cacheSettings.progress", "进度: {{current}}/{{total}}", {
						current: progress.current,
						total: progress.total,
					})}
				</Typography>
			)}

		</Box>
	);
};
