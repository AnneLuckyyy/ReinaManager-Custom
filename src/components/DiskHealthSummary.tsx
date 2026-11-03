import StorageRoundedIcon from "@mui/icons-material/StorageRounded";
import { Box, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useModStore } from "@/store/modStore";
import type { DiskHealthDrive, DiskHealthLevel } from "@/types/diskHealth";

const HEALTH_PRIORITY: Record<DiskHealthLevel, number> = {
	normal: 0,
	unknown: 1,
	attention: 2,
	critical: 3,
};

export const DiskHealthSummary = ({ mini }: { mini: boolean }) => {
	const { t, i18n } = useTranslation();
	const diskHealth = useModStore((state) => state.diskHealth);

	const summary = useMemo(() => {
		if (
			!diskHealth.enabled ||
			diskHealth.lastError ||
			!diskHealth.snapshot?.drives.length
		) {
			return null;
		}

		const drives = diskHealth.snapshot.drives;
		const level = drives.reduce<DiskHealthLevel>(
			(worst, drive) =>
				HEALTH_PRIORITY[drive.health] > HEALTH_PRIORITY[worst]
					? drive.health
					: worst,
			"normal",
		);
		const affected = drives.filter((drive) => drive.health === level).length;
		const hottest = drives.reduce<DiskHealthDrive | null>(
			(current, drive) =>
				drive.temperature !== null &&
				(!current ||
					current.temperature === null ||
					drive.temperature > current.temperature)
					? drive
					: current,
			null,
		);
		return { drives, level, affected, hottest };
	}, [diskHealth]);

	if (!summary || !diskHealth.snapshot) return null;

	const healthLabel = {
		normal: t("components.DiskHealth.normal", "正常"),
		attention: t("components.DiskHealth.attention", "关注"),
		critical: t("components.DiskHealth.critical", "异常"),
		unknown: t("components.DiskHealth.unknown", "未知"),
	}[summary.level];
	const healthText =
		summary.level === "normal" || summary.level === "unknown"
			? healthLabel
			: `${healthLabel} ${summary.affected}`;
	const paletteColor = {
		normal: "success",
		attention: "warning",
		critical: "error",
		unknown: "text",
	}[summary.level] as "success" | "warning" | "error" | "text";
	const issueDrives = summary.drives
		.filter(
			(drive) => drive.health === "attention" || drive.health === "critical",
		)
		.slice(0, 4);
	const checkedTime = new Intl.DateTimeFormat(i18n.language, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(diskHealth.snapshot.checkedAt));

	const tooltip = (
		<Box sx={{ py: 0.25, maxWidth: 300 }}>
			<Typography variant="subtitle2">
				{healthText} · {summary.drives.length}{" "}
				{t("components.DiskHealth.disks", "块")}
			</Typography>
			{issueDrives.map((drive) => (
				<Typography key={drive.id} variant="caption" display="block">
					{drive.model}
					{drive.driveLetters ? ` · ${drive.driveLetters}` : ""}
					{drive.indicatorGrowth
						? ` · ${t("components.DiskHealth.growth", "指标增长")}`
						: ""}
				</Typography>
			))}
			{summary.hottest?.temperature !== null && summary.hottest && (
				<Typography variant="caption" display="block">
					{t("components.DiskHealth.hottest", "最高")}{" "}
					{summary.hottest.temperature}
					°C · {summary.hottest.driveLetters || summary.hottest.model}
				</Typography>
			)}
			<Typography variant="caption" color="inherit" sx={{ opacity: 0.72 }}>
				{checkedTime}
			</Typography>
		</Box>
	);

	return (
		<Tooltip title={tooltip} placement="right" arrow>
			<Box
				sx={(theme) => {
					const color =
						paletteColor === "text"
							? theme.palette.text.secondary
							: theme.palette[paletteColor].main;
					return {
						mx: mini ? 0.75 : 1.25,
						mb: 0.75,
						minWidth: 0,
						height: 36,
						px: mini ? 0.5 : 1.1,
						borderRadius: 2,
						display: "flex",
						alignItems: "center",
						justifyContent: mini ? "center" : "flex-start",
						gap: mini ? 0.35 : 0.75,
						color,
						bgcolor: alpha(color, 0.09),
						border: `1px solid ${alpha(color, 0.18)}`,
						userSelect: "none",
					};
				}}
			>
				<StorageRoundedIcon sx={{ fontSize: mini ? 16 : 17, flexShrink: 0 }} />
				{!mini && (
					<Typography variant="caption" fontWeight={650} noWrap>
						{healthText}
					</Typography>
				)}
				{summary.hottest?.temperature !== null && summary.hottest && (
					<Typography
						variant="caption"
						fontWeight={650}
						noWrap
						sx={{ ml: mini ? 0 : "auto", fontVariantNumeric: "tabular-nums" }}
					>
						{summary.hottest.temperature}°
					</Typography>
				)}
			</Box>
		</Tooltip>
	);
};
