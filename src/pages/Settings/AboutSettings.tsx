import BugReportIcon from "@mui/icons-material/BugReport";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import { Alert, Link, Typography } from "@mui/material";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import pkg from "@pkg";
import { open as openurl } from "@tauri-apps/plugin-shell";
import type React from "react";
import { useTranslation } from "react-i18next";

export const AboutSection: React.FC = () => {
	const { t } = useTranslation();

	const openGitHub = () => {
		openurl("https://github.com/huoshen80/ReinaManager");
	};

	const openCustomGitHub = () => {
		openurl("https://github.com/AnneLuckyyy/ReinaManager-Custom");
	};

	const openBlog = () => {
		openurl("https://huoshen80.top");
	};

	return (
		<Box className="space-y-2">
			<Alert severity="info" variant="outlined" sx={{ alignItems: "flex-start" }}>
				<Typography variant="body2" fontWeight={700}>非官方改版</Typography>
				<Typography variant="caption" component="div">
					本应用基于 huoshen80 的 ReinaManager 修改，沿用 AGPL-3.0 许可证。功能问题请通过本改版的发布渠道反馈，不要要求原项目作者处理改版特有问题。
				</Typography>
			</Alert>
			{/* 版本与改版更新通道 */}
			<Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} spacing={1}>
			<Typography variant="body2">
				<strong>{t("pages.Settings.about.version", "版本")}: </strong>v
				{pkg.version}
				<Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
					（改版基线）
				</Typography>
			</Typography>
				<Typography variant="caption" color="text.secondary">
					此改版暂未配置独立更新通道。
				</Typography>
			</Stack>
			{/* 原项目作者信息 */}
			<Typography variant="body2">
				<strong>改版维护者: </strong>
				AnneLucky
			</Typography>
			<Typography variant="body2">
				<strong>改版项目地址: </strong>
				<Link
					component="button"
					variant="body2"
					onClick={openCustomGitHub}
					sx={{ textDecoration: "none" }}
				>
					https://github.com/AnneLuckyyy/ReinaManager-Custom
				</Link>
			</Typography>
			<Typography variant="body2">
				<strong>原项目作者: </strong>
				huoshen80
			</Typography>{" "}
			{/* 使用文档和问题反馈 */}
			{/* 项目链接 */}
			<Typography variant="body2">
				<strong>原项目地址: </strong>
				<Link
					component="button"
					variant="body2"
					onClick={openGitHub}
					sx={{ textDecoration: "none" }}
				>
					https://github.com/huoshen80/ReinaManager
				</Link>
			</Typography>
			{/* 原作者博客链接 */}
			<Typography variant="body2">
				<strong>原作者博客: </strong>
				<Link
					component="button"
					variant="body2"
					onClick={openBlog}
					sx={{ textDecoration: "none" }}
				>
					https://huoshen80.top
				</Link>
			</Typography>
			{/* 使用文档和问题反馈 */}
			<Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
				<Button
					variant="outlined"
					startIcon={<MenuBookIcon />}
					onClick={openCustomGitHub}
					size="small"
				>
					改版项目页
				</Button>
				<Button
					variant="outlined"
					startIcon={<MenuBookIcon />}
					onClick={openGitHub}
					size="small"
				>
					查看原项目
				</Button>
				<Button
					variant="outlined"
					startIcon={<MenuBookIcon />}
					onClick={() => openurl("https://reina.huoshen80.top")}
					size="small"
				>
					原项目文档
				</Button>
				<Button
					variant="outlined"
					color="secondary"
					startIcon={<BugReportIcon />}
					onClick={() =>
						openurl(
							"https://github.com/huoshen80/ReinaManager/issues/new/choose",
						)
					}
					size="small"
				>
					原项目反馈
				</Button>
			</Stack>
		</Box>
	);
};
