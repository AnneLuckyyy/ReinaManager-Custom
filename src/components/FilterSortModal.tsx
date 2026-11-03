import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import FilterAlt from "@mui/icons-material/FilterAlt";
import FilterListIcon from "@mui/icons-material/FilterList";
import LocalOfferIcon from "@mui/icons-material/LocalOffer";
import SortIcon from "@mui/icons-material/Sort";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { GameType, SortOption, SortOrder } from "@/services/invoke/types";
import { useStore } from "@/store/appStore";
import { useGameIndex } from "@/hooks/features/games/useGameListFacade";
import { ToolbarIconAction } from "@/components/Toolbar/ToolbarIconAction";
import {
	ALL_PLAY_STATUSES,
	type BackupStatusFilter,
	getPlayStatusLabel,
	type PlayStatus,
	type PlayStatusFilter,
} from "@/types/collection";
import {
	buildNormalizedTagMap,
	filterTagSuggestions,
	findTagByInput,
	normalizeTagFilters,
} from "@/utils/tagFilter";

const filterTypeOptions: Array<{ value: GameType; labelKey: string }> = [
	{ value: "all", labelKey: "allGames" },
	{ value: "local", labelKey: "localGames" },
	{ value: "online", labelKey: "onlineGames" },
	{ value: "iscustom", labelKey: "customGames" },
];

const sortOptions: Array<{ value: SortOption; labelKey: string }> = [
	{ value: "addtime", labelKey: "addTime" },
	{ value: "namesort", labelKey: "nameSort" },
	{ value: "datetime", labelKey: "releaseTime" },
	{ value: "lastplayed", labelKey: "lastPlayed" },
	{ value: "bgmrank", labelKey: "bgmRank" },
	{ value: "vndbrank", labelKey: "vndbRank" },
];

export const FilterSortModal: React.FC = () => {
	const { t } = useTranslation();
	const {
		gameFilterType,
		playStatusFilter,
		backupStatusFilter,
		tagFilters,
		sortOption,
		sortOrder,
		showCardSortFieldOverlay,
		setGameFilterType,
		setPlayStatusFilter,
		setBackupStatusFilter,
		setTagFilters,
		updateSort,
		setShowCardSortFieldOverlay,
	} = useStore(
		useShallow((s) => ({
			gameFilterType: s.gameFilterType,
			playStatusFilter: s.playStatusFilter,
			backupStatusFilter: s.backupStatusFilter,
			tagFilters: s.tagFilters,
			sortOption: s.sortOption,
			sortOrder: s.sortOrder,
			showCardSortFieldOverlay: s.showCardSortFieldOverlay,
			setGameFilterType: s.setGameFilterType,
			setPlayStatusFilter: s.setPlayStatusFilter,
			setBackupStatusFilter: s.setBackupStatusFilter,
			setTagFilters: s.setTagFilters,
			updateSort: s.updateSort,
			setShowCardSortFieldOverlay: s.setShowCardSortFieldOverlay,
		})),
	);

	const [open, setOpen] = useState(false);
	const [localFilterType, setLocalFilterType] =
		useState<GameType>(gameFilterType);
	const [localPlayStatusFilter, setLocalPlayStatusFilter] =
		useState<PlayStatusFilter>(playStatusFilter);
	const [localBackupStatusFilter, setLocalBackupStatusFilter] =
		useState<BackupStatusFilter>(backupStatusFilter);
	const [localTagFilters, setLocalTagFilters] = useState<string[]>(tagFilters);
	const [localSortOption, setLocalSortOption] =
		useState<SortOption>(sortOption);
	const [localSortOrder, setLocalSortOrder] = useState<SortOrder>(sortOrder);
	const [localShowCardSortFieldOverlay, setLocalShowCardSortFieldOverlay] =
		useState(showCardSortFieldOverlay);
	const [tagInput, setTagInput] = useState("");
	const { index } = useGameIndex();
	const knownTagByNormalized = useMemo(() => {
		const tags = new Set<string>();
		for (const game of index.displayById.values()) {
			for (const tag of game.tags ?? []) {
				if (tag.trim()) tags.add(tag.trim());
			}
		}
		return buildNormalizedTagMap(
			Array.from(tags).toSorted((left, right) => left.localeCompare(right)),
		);
	}, [index.displayById]);
	const tagOptions = useMemo(
		() =>
			filterTagSuggestions(
				knownTagByNormalized,
				localTagFilters,
				tagInput,
				12,
			),
		[knownTagByNormalized, localTagFilters, tagInput],
	);
	const hasActiveFilters =
		gameFilterType !== "all" ||
		playStatusFilter.length > 0 ||
		backupStatusFilter !== "all" ||
		tagFilters.length > 0;
	const hasLocalActiveFilters =
		localFilterType !== "all" ||
		localPlayStatusFilter.length > 0 ||
		localBackupStatusFilter !== "all" ||
		localTagFilters.length > 0;

	const handleOpen = () => {
		setLocalFilterType(gameFilterType);
		setLocalPlayStatusFilter(playStatusFilter);
		setLocalBackupStatusFilter(backupStatusFilter);
		setLocalTagFilters(tagFilters);
		setLocalSortOption(sortOption);
		setLocalSortOrder(sortOrder);
		setLocalShowCardSortFieldOverlay(showCardSortFieldOverlay);
		setTagInput("");
		setOpen(true);
	};

	const handleClose = () => setOpen(false);

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setGameFilterType(localFilterType);
		setPlayStatusFilter(localPlayStatusFilter);
		setBackupStatusFilter(localBackupStatusFilter);
		setTagFilters(localTagFilters);
		updateSort(localSortOption, localSortOrder);
		setShowCardSortFieldOverlay(localShowCardSortFieldOverlay);
		handleClose();
	};

	const handleTagFiltersChange = (nextTags: string[]) => {
		const matchedTags = nextTags
			.map((tag) => findTagByInput(knownTagByNormalized, tag))
			.filter((tag): tag is string => Boolean(tag));
		setLocalTagFilters(normalizeTagFilters(matchedTags));
	};

	const handlePlayStatusToggle = (status: PlayStatus) => {
		setLocalPlayStatusFilter((previous) =>
			previous.includes(status)
				? previous.filter((item) => item !== status)
				: [...previous, status],
		);
	};

	const handleTagInputKeyDown = (
		event: React.KeyboardEvent<HTMLInputElement>,
	) => {
		if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
		const matchedTag = findTagByInput(knownTagByNormalized, tagInput);
		if (!tagInput.trim()) return;
		event.preventDefault();
		if (matchedTag) {
			handleTagFiltersChange([...localTagFilters, matchedTag]);
		}
		setTagInput("");
	};

	const resetLocalFilters = () => {
		setLocalFilterType("all");
		setLocalPlayStatusFilter([]);
		setLocalBackupStatusFilter("all");
		setLocalTagFilters([]);
		setTagInput("");
	};

	return (
		<>
			<ToolbarIconAction
				label={t("components.FilterSortModal.title", "筛选排序")}
				active={hasActiveFilters}
				onClick={handleOpen}
			>
				<FilterAlt />
			</ToolbarIconAction>
			<Dialog
				open={open}
				onClose={handleClose}
				closeAfterTransition={false}
				aria-labelledby="filter-sort-dialog-title"
				maxWidth={false}
				slotProps={{
					transition: { timeout: 0 },
					paper: {
						component: "form",
						onSubmit: handleSubmit,
						className:
							"w-fit min-w-88 max-w-[calc(100vw-2rem)] overflow-hidden",
					},
				}}
			>
				<DialogTitle
					id="filter-sort-dialog-title"
					className="flex items-center gap-2 border-b border-black/8 px-5 py-4 dark:border-white/10"
				>
					<FilterAlt fontSize="small" className="text-primary" />
					<span className="text-base font-600">
						{t("components.FilterSortModal.title", "筛选排序")}
					</span>
				</DialogTitle>
				<DialogContent className="overflow-x-auto px-5 py-4">
					<div className="w-max min-w-88 flex flex-col gap-4">
						<section className="rounded-2 border border-black/8 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.04]">
							<div className="mb-2 flex items-center gap-2">
								<FilterListIcon fontSize="small" className="text-primary" />
								<Typography variant="body2" className="font-600">
									{t("components.FilterSortModal.filter", "筛选")}
								</Typography>
							</div>
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center gap-2">
										<Typography variant="caption" color="text.secondary">
											{t("components.FilterSortModal.sourceFilter", "游戏来源")}
										</Typography>
									</div>
									<FormControl fullWidth size="small">
										<Select
											labelId="library-filter-label"
											value={localFilterType}
											displayEmpty
											onChange={(event: SelectChangeEvent) =>
												setLocalFilterType(event.target.value as GameType)
											}
										>
											{filterTypeOptions.map((option) => (
												<MenuItem key={option.value} value={option.value}>
													{t(`components.FilterSortModal.${option.labelKey}`)}
												</MenuItem>
											))}
										</Select>
									</FormControl>
								</div>
								<div className="flex flex-col gap-2">
									<div className="flex items-center gap-2">
										<Typography variant="caption" color="text.secondary">
											{t(
												"components.FilterSortModal.playStatusFilter",
												"游戏状态",
											)}
										</Typography>
									</div>
									<fieldset className="grid w-max grid-flow-col auto-cols-max gap-1.5 border-0 p-0 m-0">
										<legend className="sr-only">
											{t(
												"components.FilterSortModal.playStatusFilter",
												"游戏状态",
											)}
										</legend>
										<ToggleButton
											size="small"
											value="all"
											selected={localPlayStatusFilter.length === 0}
											onClick={() => setLocalPlayStatusFilter([])}
											className="min-w-0 whitespace-nowrap px-2"
										>
											{t("components.FilterSortModal.allStatuses", "全部状态")}
										</ToggleButton>
										{ALL_PLAY_STATUSES.map((status: PlayStatus) => (
											<ToggleButton
												key={status}
												size="small"
												value={status}
											selected={localPlayStatusFilter.includes(status)}
											onClick={() => handlePlayStatusToggle(status)}
												className="min-w-0 whitespace-nowrap px-2"
											>
												{getPlayStatusLabel(t, status)}
											</ToggleButton>
										))}
									</fieldset>
								</div>
								<div className="flex flex-col gap-2">
									<Typography variant="caption" color="text.secondary">
										{t(
											"components.FilterSortModal.backupStatusFilter",
											"网盘备份",
										)}
									</Typography>
									<FormControl fullWidth size="small">
										<Select
											value={localBackupStatusFilter}
											onChange={(event: SelectChangeEvent) =>
												setLocalBackupStatusFilter(
													event.target.value as BackupStatusFilter,
												)
											}
										>
											<MenuItem value="all">
												{t("components.FilterSortModal.allBackupStatuses", "全部")}
											</MenuItem>
											<MenuItem value="has">
											{t(
												"components.FilterSortModal.hasCloudBackup",
												"有备份",
											)}
											</MenuItem>
											<MenuItem value="multiple">
											{t(
												"components.FilterSortModal.multipleCloudBackups",
												"多备份",
											)}
											</MenuItem>
											<MenuItem value="none">
											{t("components.FilterSortModal.noCloudBackup", "无备份")}
											</MenuItem>
										</Select>
									</FormControl>
								</div>
								<div className="flex flex-col gap-2">
									<div className="flex items-center gap-2">
										<LocalOfferIcon fontSize="small" className="text-primary" />
										<Typography variant="caption" color="text.secondary">
											{t("components.FilterSortModal.tagFilter", "标签")}
										</Typography>
									</div>
									<Autocomplete
										multiple
										freeSolo
										options={tagOptions}
										value={localTagFilters}
										inputValue={tagInput}
										filterOptions={(options) => options}
										onInputChange={(_, value, reason) => {
											if (reason === "input" || reason === "clear") setTagInput(value);
										}}
										onChange={(_, value) => {
											handleTagFiltersChange(value);
											setTagInput("");
										}}
										noOptionsText={t(
											"components.FilterSortModal.noTagSuggestions",
											"没有标签建议",
										)}
										renderTags={(value, getTagProps) =>
											value.map((option, index) => {
												const { key, ...tagProps } = getTagProps({ index });
												return <Chip key={key} label={option} size="small" {...tagProps} />;
											})
										}
										renderInput={(params) => (
											<TextField
												{...params}
												size="small"
												placeholder={
													localTagFilters.length === 0
														? t(
															"components.FilterSortModal.tagFilterPlaceholder",
															"输入标签",
														)
														: ""
												}
												onKeyDown={handleTagInputKeyDown}
											/>
										)}
									/>
								</div>
							</div>
						</section>

						<section className="rounded-2 border border-black/8 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.04]">
							<div className="mb-2 flex items-center gap-2">
								<SortIcon fontSize="small" className="text-primary" />
								<Typography variant="body2" className="font-600">
									{t("components.FilterSortModal.sortMethod", "排序方式")}
								</Typography>
							</div>
							<div className="flex flex-col gap-3">
								<FormControl fullWidth size="small">
									<Select
										labelId="library-sort-label"
										value={localSortOption}
										displayEmpty
										onChange={(event: SelectChangeEvent) =>
											setLocalSortOption(event.target.value as SortOption)
										}
									>
										{sortOptions.map((option) => (
											<MenuItem key={option.value} value={option.value}>
												{t(`components.FilterSortModal.${option.labelKey}`)}
											</MenuItem>
										))}
									</Select>
								</FormControl>
								<ToggleButtonGroup
									exclusive
									fullWidth
									size="small"
									value={localSortOrder}
									aria-label={t(
										"components.FilterSortModal.sortOrder",
										"排序方向",
									)}
									onChange={(_, value: SortOrder | null) => {
										if (value) setLocalSortOrder(value);
									}}
								>
									<ToggleButton value="asc" className="gap-1">
										<ArrowUpwardIcon fontSize="small" />
										{t("components.FilterSortModal.ascending", "升序")}
									</ToggleButton>
									<ToggleButton value="desc" className="gap-1">
										<ArrowDownwardIcon fontSize="small" />
										{t("components.FilterSortModal.descending", "降序")}
									</ToggleButton>
								</ToggleButtonGroup>
								{localSortOption !== "namesort" ? (
									<FormControlLabel
										className="m-0 justify-between"
										control={
											<Switch
												size="small"
												checked={localShowCardSortFieldOverlay}
												onChange={(event) =>
													setLocalShowCardSortFieldOverlay(event.target.checked)
												}
											/>
										}
										label={t(
											"components.FilterSortModal.showCardSortFieldOverlay",
											"封面展示排序字段",
										)}
										labelPlacement="start"
									/>
								) : null}
							</div>
						</section>
					</div>
				</DialogContent>
				<DialogActions className="border-t border-black/8 px-5 py-3 dark:border-white/10">
					<Button onClick={resetLocalFilters} disabled={!hasLocalActiveFilters}>
						{t("components.FilterSortModal.clearFilters", "清除筛选")}
					</Button>
					<Button onClick={handleClose}>
						{t("components.FilterSortModal.cancel", "取消")}
					</Button>
					<Button type="submit" variant="contained">
						{t("components.FilterSortModal.confirm", "确认")}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
};
