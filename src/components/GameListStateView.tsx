import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getUserErrorMessage } from "@/utils/errors";

interface GameListStateViewProps {
	loading?: boolean;
	error?: unknown;
	empty?: boolean;
	emptyMessage?: ReactNode;
	children: ReactNode;
}

export const GameListStateView: React.FC<GameListStateViewProps> = ({
	loading = false,
	error,
	empty = false,
	emptyMessage,
	children,
}) => {
	const { t } = useTranslation();

	if (loading) {
		return (
			<Box className="flex flex-1 items-center justify-center p-4">
				<CircularProgress />
			</Box>
		);
	}

	if (error) {
		return (
			<Box className="p-4">
				<Alert severity="error">{getUserErrorMessage(error, t)}</Alert>
			</Box>
		);
	}

	if (empty) {
		return (
			<Box className="flex justify-center mt-12">
				<Alert severity="info">
					{emptyMessage ??
						t("components.GameListStateView.empty", "没有找到符合条件的游戏")}
				</Alert>
			</Box>
		);
	}

	return <>{children}</>;
};
