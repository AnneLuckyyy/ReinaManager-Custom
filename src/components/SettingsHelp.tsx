import HelpOutlineRoundedIcon from "@mui/icons-material/HelpOutlineRounded";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

type SettingsHelpProps = {
	text: string;
};

/**
 * 设置说明的统一紧凑入口。
 * 只收纳静态说明；错误、权限和数据覆盖等即时风险仍应直接显示。
 */
export const SettingsHelp = ({ text }: SettingsHelpProps) => (
	<Tooltip
		title={text}
		arrow
		placement="right-start"
		enterDelay={80}
		enterNextDelay={0}
		enterTouchDelay={500}
		leaveDelay={120}
		slotProps={{
			tooltip: {
				sx: {
					maxWidth: 360,
					bgcolor: "grey.900",
					color: "common.white",
					fontSize: "0.82rem",
					lineHeight: 1.55,
					px: 1.25,
					py: 0.75,
					boxShadow: 4,
				},
			},
			arrow: { sx: { color: "grey.900" } },
		}}
	>
		<IconButton
			size="small"
			aria-label={text}
			sx={{ ml: 0.25, p: 0.25, color: "text.secondary" }}
		>
			<HelpOutlineRoundedIcon fontSize="inherit" />
		</IconButton>
	</Tooltip>
);
