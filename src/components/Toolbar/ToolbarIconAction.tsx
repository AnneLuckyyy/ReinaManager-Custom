import type { ReactNode } from "react";
import Badge from "@mui/material/Badge";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

type ToolbarIconActionProps = {
	label: string;
	children: ReactNode;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	disabled?: boolean;
	active?: boolean;
	color?: "default" | "primary" | "error";
};

/** 顶栏的紧凑图标操作：固定点击面积，说明只在悬停或键盘聚焦时出现。 */
export function ToolbarIconAction({
	label,
	children,
	onClick,
	disabled = false,
	active = false,
	color = "primary",
}: ToolbarIconActionProps) {
	return (
		<Tooltip title={label} placement="bottom" enterDelay={350}>
			<span>
				<IconButton
					size="small"
					aria-label={label}
					onClick={onClick}
					disabled={disabled}
					color={color}
					sx={{
						width: 36,
						height: 36,
						borderRadius: 1.5,
						"&:hover": { bgcolor: "action.hover" },
					}}
				>
					<Badge color="primary" variant="dot" invisible={!active} overlap="circular">
						{children}
					</Badge>
				</IconButton>
			</span>
		</Tooltip>
	);
}
