import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import {
	Alert,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Stack,
	Typography,
} from "@mui/material";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { snackbar } from "@/providers/snackBar";
import {
	shionlibInstallService,
	type ShionlibInstallPreview,
} from "@/services/invoke";
import { getUserErrorMessage } from "@/utils/errors";
import { useModStore } from "@/store/modStore";

const downloadTaskKey = ["download-tasks"] as const;

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
	return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function ShionlibInstallRequestHandler() {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const automationDefaults = useModStore((state) => state.downloadTaskAutomationDefaults);
	const [queue, setQueue] = useState<ShionlibInstallPreview[]>([]);
	const [preview, setPreview] = useState<ShionlibInstallPreview | null>(null);

	useEffect(() => {
		if (preview || queue.length === 0) return;
		setPreview(queue[0]);
		setQueue((current) => current.slice(1));
	}, [preview, queue]);

	useEffect(() => {
		let disposed = false;
		const unlisteners: UnlistenFn[] = [];
		const drain = async () => {
			try {
				const [previews, rejections] = await Promise.all([
					shionlibInstallService.takePendingPreviews(),
					shionlibInstallService.takePendingRejections(),
				]);
				if (disposed) return;
				if (previews.length > 0) {
					setQueue((current) => [...current, ...previews]);
				}
				for (const message of rejections) {
					snackbar.error(`已拒绝 Shionlib 资源请求：${message}`);
				}
			} catch (error) {
				console.error("读取 Shionlib 资源请求失败:", error);
			}
		};
		const register = async () => {
			for (const event of [
				"shionlib-install-preview-received",
				"shionlib-install-preview-rejected",
			]) {
				const unlisten = await listen(event, () => void drain());
				if (disposed) {
					unlisten();
					return;
				}
				unlisteners.push(unlisten);
			}
			await drain();
		};
		void register();
		return () => {
			disposed = true;
			for (const unlisten of unlisteners) unlisten();
		};
	}, []);

	const createMutation = useMutation({
		mutationFn: (requestId: string) =>
			shionlibInstallService.createPausedDownloadTask(requestId, automationDefaults.autoImport, automationDefaults.autoDelete),
		onSuccess: () => {
			setPreview(null);
			void queryClient.invalidateQueries({ queryKey: downloadTaskKey });
			snackbar.success("已开始 Shionlib 下载与自动安装任务");
		},
		onError: (error) => snackbar.error(getUserErrorMessage(error, t)),
	});

	const openShionlib = () => {
		void openUrl("https://shionlib.com/").catch((error) =>
			snackbar.error(getUserErrorMessage(error, t)),
		);
	};

	return (
		<Dialog
			open={Boolean(preview)}
			onClose={createMutation.isPending ? undefined : () => setPreview(null)}
			fullWidth
			maxWidth="sm"
		>
			<DialogTitle>来自 Shionlib 的资源请求</DialogTitle>
			<DialogContent>
				<Stack spacing={1.5} className="pt-2">
					<Alert severity="warning">
						确认后，应用会连接所示下载主机复核文件大小，下载完成后安全解压并整理到你在路径管理中设置的游戏安装目录。不会执行压缩包内程序，也不会自动创建游戏记录。安装目录必须已存在且为空间可用的本地目录。
					</Alert>
					<Typography>标题：{preview?.title}</Typography>
					<Typography>
						文件：{preview?.file_name}（{preview?.archive_format.toUpperCase()}）
					</Typography>
					<Typography>大小：{preview ? formatBytes(preview.size) : ""}</Typography>
					<Typography>下载主机：{preview?.download_host}</Typography>
					<Typography variant="body2" color="text.secondary">
						{preview?.checksum_algorithm
							? `来源声明校验：${preview.checksum_algorithm.toUpperCase()}`
							: "来源未提供校验信息"}
					</Typography>
					{preview?.expires_at ? (
						<Typography variant="body2" color="text.secondary">
							链接过期时间：{new Date(preview.expires_at * 1000).toLocaleString()}
						</Typography>
					) : null}
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button
					startIcon={<OpenInNewIcon />}
					onClick={openShionlib}
					disabled={createMutation.isPending}
				>
					返回 Shionlib
				</Button>
				<Button onClick={() => setPreview(null)} disabled={createMutation.isPending}>
					暂不创建
				</Button>
				<Button
					variant="contained"
					disabled={createMutation.isPending || !preview}
					onClick={() => {
						if (preview) createMutation.mutate(preview.request_id);
					}}
				>
					{createMutation.isPending ? "正在复核…" : "确认并开始下载"}
				</Button>
			</DialogActions>
		</Dialog>
	);
}
