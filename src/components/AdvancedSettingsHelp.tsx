import ContactSupportOutlinedIcon from "@mui/icons-material/ContactSupportOutlined";
import CloseIcon from "@mui/icons-material/Close";
import {
	Box,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Divider,
	IconButton,
	Stack,
	Tooltip,
	Typography,
} from "@mui/material";
import { useState } from "react";

type HelpSection = {
	title: string;
	content: string;
};

type AdvancedSettingsHelpProps = {
	/** A short explanation that remains available on hover. */
	tooltip: string;
	/** Dialog heading. */
	title: string;
	/** Longer, task-oriented help shown only after an explicit click. */
	sections: HelpSection[];
};

/**
 * A compact entry for settings whose safe use needs more than one tooltip.
 * It deliberately keeps the normal settings surface quiet: hover gives a
 * one-line answer, while click opens an independently closable guide.
 */
export function AdvancedSettingsHelp({
	tooltip,
	title,
	sections,
}: AdvancedSettingsHelpProps) {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);

	return (
		<>
			<Tooltip title={tooltip} arrow placement="right-start" enterDelay={80}>
				<IconButton
					size="small"
					aria-label={`${title}说明`}
					onClick={() => setOpen(true)}
					sx={{ ml: 0.25, p: 0.25, color: "primary.main" }}
				>
					<ContactSupportOutlinedIcon fontSize="inherit" />
				</IconButton>
			</Tooltip>

			<Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="advanced-settings-help-title">
				<DialogTitle id="advanced-settings-help-title" sx={{ pr: 6 }}>
					{title}
					<IconButton
						aria-label="关闭说明"
						onClick={close}
						size="small"
						sx={{ position: "absolute", right: 12, top: 12 }}
					>
						<CloseIcon fontSize="small" />
					</IconButton>
				</DialogTitle>
				<DialogContent dividers>
					<Stack spacing={2}>
						{sections.map((section, index) => (
							<Box key={section.title}>
								{index > 0 && <Divider sx={{ mb: 2 }} />}
								<Typography variant="subtitle2" className="font-semibold">
									{section.title}
								</Typography>
								<Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, lineHeight: 1.7 }}>
									{section.content}
								</Typography>
							</Box>
						))}
					</Stack>
				</DialogContent>
				<DialogActions sx={{ px: 3, py: 1.5 }}>
					<Button onClick={close} variant="contained">关闭</Button>
				</DialogActions>
			</Dialog>
		</>
	);
}
