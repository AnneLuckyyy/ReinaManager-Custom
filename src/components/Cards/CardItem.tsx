import CheckIcon from "@mui/icons-material/Check";
import RemoveCircleIcon from "@mui/icons-material/RemoveCircle";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardMedia from "@mui/material/CardMedia";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { forwardRef, memo } from "react";
import { useStore } from "@/store/appStore";
import { getGameCover, getGameNsfwStatus } from "@/utils/appUtils";
import type { CardItemProps } from "./types";
import { useCardInteraction } from "./useCardInteraction";

const noop = () => {};

/**
 * CardItem - 游戏卡片组件
 *
 * 由父级传入展示数据，避免卡片内部读取 React Query 缓存。
 */
export const CardItem = memo(
	forwardRef<HTMLDivElement, CardItemProps>(
		(
			{
				game,
				displayName,
				interaction,
				batch,
				removeAction,
				sortFieldOverlay,
				isOverlay,
				...props
			},
			ref,
		) => {
			const nsfwCoverReplace = useStore((s) => s.nsfwCoverReplace);
			const isActive = useStore((s) => s.selectedGameId === game.id);

			const { isLongPressing, handlers } = useCardInteraction({
				onClick: interaction?.onClick ?? noop,
				onDoubleClick: interaction?.onDoubleClick ?? noop,
				onLongPress: interaction?.onLongPress ?? noop,
				useDelayedClick: interaction?.useDelayedClick ?? false,
			});

			const isNsfw = getGameNsfwStatus(game);
			const coverImage =
				nsfwCoverReplace && isNsfw ? "/images/NR18.png" : getGameCover(game);

			return (
				<Card
					ref={ref}
					className={`group relative min-w-24 max-w-full transition-shadow transition-colors ${isActive ? "ring-2 ring-blue-500 shadow-md" : ""}`}
					onContextMenu={interaction?.onContextMenu}
					{...props}
				>
					{batch?.selected && (
						<Box
							className="absolute top-1.5 left-1.5 z-2 h-5 w-5 flex items-center justify-center shadow-md"
							sx={{
								bgcolor: "primary.main",
								color: "primary.contrastText",
							}}
						>
							<CheckIcon className="text-18px" />
						</Box>
					)}
					{removeAction && (
						<Tooltip title={removeAction.title} enterDelay={1000}>
							<IconButton
								size="small"
								className="!absolute right-1 top-1 z-2 !p-0 opacity-0 group-hover:opacity-100"
								sx={{
									bgcolor: "error.main",
									color: "primary.contrastText",
									"&:hover": {
										bgcolor: "error.main",
									},
								}}
								onClick={(event) => {
									event.stopPropagation();
									removeAction.onRemove();
								}}
								onMouseDown={(event) => event.stopPropagation()}
							>
								<RemoveCircleIcon fontSize="medium" />
							</IconButton>
						</Tooltip>
					)}
					<CardActionArea
						{...handlers}
						className={`
							duration-100
							hover:shadow-lg hover:scale-105
							active:shadow-sm active:scale-95
							${isLongPressing ? "ring-2 ring-blue-500 shadow-lg" : ""}
							${isOverlay ? "shadow-lg scale-105" : ""}
						`}
					>
						<Box className="relative aspect-[3/4] overflow-hidden">
							<CardMedia
								component="img"
								className="h-full w-full object-cover"
								image={coverImage}
								alt="Card Image"
								draggable="false"
								loading="lazy"
							/>
							{sortFieldOverlay ? (
								<Box className="pointer-events-none absolute inset-x-0 bottom-0 px-2 pt-5 pb-1 text-left text-white [background:linear-gradient(to_bottom,transparent_0%,rgba(15,23,32,.85)_100%)]">
									<Typography variant="caption" className="block truncate drop-shadow">
										{sortFieldOverlay.value}
									</Typography>
								</Box>
							) : null}
						</Box>
						<div
							className={`flex items-center justify-center h-8 px-1 w-full ${isActive ? "font-semibold text-blue-500" : ""}`}
						>
							<span className="text-base truncate max-w-full">
								{displayName}
							</span>
						</div>
					</CardActionArea>
				</Card>
			);
		},
	),
);

CardItem.displayName = "CardItem";
