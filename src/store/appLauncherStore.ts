import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AppLauncherCandidate } from "@/services/invoke/appLauncherService";
import { durableWebStorage } from "@/utils/durableWebStorage";

export type AppCategory = {
	id: string;
	name: string;
	color: string;
};

export type AppLauncherItem = AppLauncherCandidate & {
	id: string;
	categoryId: string;
	pinned: boolean;
	addedAt: string;
};

export type AppLauncherSortMode = "default" | "custom";

export type AppSourceFolder = {
	id: string;
	path: string;
	categoryId: string;
};

const DEFAULT_CATEGORIES: AppCategory[] = [
	{ id: "system", name: "系统", color: "#5b8def" },
	{ id: "files", name: "文件", color: "#10a37f" },
	{ id: "network", name: "网络", color: "#7c6ee6" },
	{ id: "tools", name: "工具", color: "#e07a3f" },
	{ id: "media", name: "多媒体", color: "#d45d8b" },
	{ id: "games", name: "游戏", color: "#3d9b63" },
	{ id: "code", name: "代码", color: "#4f7cac" },
	{ id: "uncategorized", name: "待整理", color: "#7a8394" },
];

type AppLauncherState = {
	categories: AppCategory[];
	items: AppLauncherItem[];
	sourceFolders: AppSourceFolder[];
	query: string;
	sortMode: AppLauncherSortMode;
	customOrderByCategory: Record<string, string[]>;
	selectionMode: boolean;
	selectedIds: string[];
	setQuery: (query: string) => void;
	setSortMode: (mode: AppLauncherSortMode) => void;
	startSelecting: () => void;
	stopSelecting: () => void;
	toggleSelected: (id: string) => void;
	importCandidates: (candidates: AppLauncherCandidate[], categoryId: string) => number;
	addSourceFolder: (path: string, categoryId: string) => boolean;
	removeSourceFolder: (id: string) => void;
	updateCategory: (id: string, categoryId: string) => void;
	updateCategories: (ids: string[], categoryId: string) => void;
	moveItemToPosition: (id: string, categoryId: string, beforeId?: string) => void;
	renameItem: (id: string, name: string) => boolean;
	togglePinned: (id: string) => void;
	removeItem: (id: string) => void;
	removeItems: (ids: string[]) => void;
	addCategory: (name: string) => void;
	renameCategory: (id: string, name: string) => boolean;
	moveCategory: (id: string, direction: "left" | "right") => void;
	removeCategory: (id: string) => void;
};

function itemId(path: string) {
	return path.replaceAll("/", "\\").toLocaleLowerCase();
}

export const useAppLauncherStore = create<AppLauncherState>()(
	persist(
		(set, get) => ({
			categories: DEFAULT_CATEGORIES,
			items: [],
			sourceFolders: [],
			query: "",
			sortMode: "default",
			customOrderByCategory: {},
			selectionMode: false,
			selectedIds: [],
			setQuery: (query) => set({ query }),
			setSortMode: (sortMode) => set({ sortMode }),
			startSelecting: () => set({ selectionMode: true, selectedIds: [] }),
			stopSelecting: () => set({ selectionMode: false, selectedIds: [] }),
			toggleSelected: (id) => set((state) => ({
				selectedIds: state.selectedIds.includes(id)
					? state.selectedIds.filter((current) => current !== id)
					: [...state.selectedIds, id],
			})),
			importCandidates: (candidates, categoryId) => {
				const current = get().items;
				const known = new Set(current.map((item) => itemId(item.path)));
				const next = candidates
					.filter((candidate) => !known.has(itemId(candidate.path)))
					.map((candidate) => ({
						...candidate,
						id: itemId(candidate.path),
						categoryId,
						pinned: false,
						addedAt: new Date().toISOString(),
					}));
				if (next.length) set({ items: [...current, ...next] });
				return next.length;
			},
			addSourceFolder: (path, categoryId) => {
				const normalizedPath = path.trim().replace(/[\\/]+$/, "").toLocaleLowerCase();
				if (!normalizedPath || !get().categories.some((category) => category.id === categoryId)) return false;
				if (get().sourceFolders.some((source) => source.path.replace(/[\\/]+$/, "").toLocaleLowerCase() === normalizedPath)) return false;
				set((state) => ({
					sourceFolders: [...state.sourceFolders, { id: `source-${Date.now()}-${state.sourceFolders.length}`, path: path.trim(), categoryId }],
				}));
				return true;
			},
			removeSourceFolder: (id) => set((state) => ({
				sourceFolders: state.sourceFolders.filter((source) => source.id !== id),
			})),
			updateCategory: (id, categoryId) =>
				set((state) => ({
					items: state.items.map((item) =>
						item.id === id ? { ...item, categoryId } : item,
					),
				})),
			updateCategories: (ids, categoryId) => {
				const selected = new Set(ids);
				if (!selected.size) return;
				set((state) => ({
					items: state.items.map((item) =>
						selected.has(item.id) ? { ...item, categoryId } : item,
					),
				}));
			},
			moveItemToPosition: (id, categoryId, beforeId) => set((state) => {
				const item = state.items.find((current) => current.id === id);
				if (!item || !state.categories.some((category) => category.id === categoryId)) return {};
				const resolveOrder = (targetCategoryId: string) => {
					const targetIds = state.items
						.filter((current) => current.categoryId === targetCategoryId)
						.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
						.map((current) => current.id);
					const known = new Set(targetIds);
					const stored = state.customOrderByCategory[targetCategoryId] ?? [];
					return [...stored.filter((current) => known.has(current)), ...targetIds.filter((current) => !stored.includes(current))];
				};
				const sourceOrder = resolveOrder(item.categoryId).filter((current) => current !== id);
				const targetOrder = item.categoryId === categoryId ? sourceOrder : resolveOrder(categoryId).filter((current) => current !== id);
				const insertionIndex = beforeId ? targetOrder.indexOf(beforeId) : -1;
				targetOrder.splice(insertionIndex < 0 ? targetOrder.length : insertionIndex, 0, id);
				return {
					items: state.items.map((current) => current.id === id ? { ...current, categoryId } : current),
					customOrderByCategory: {
						...state.customOrderByCategory,
						[item.categoryId]: item.categoryId === categoryId ? targetOrder : sourceOrder,
						...(item.categoryId === categoryId ? {} : { [categoryId]: targetOrder }),
					},
				};
			}),
			renameItem: (id, name) => {
				const trimmed = name.trim();
				if (!trimmed || !get().items.some((item) => item.id === id)) return false;
				set((state) => ({
					items: state.items.map((item) =>
						item.id === id ? { ...item, name: trimmed } : item,
					),
				}));
				return true;
			},
			togglePinned: (id) =>
				set((state) => ({
					items: state.items.map((item) =>
						item.id === id ? { ...item, pinned: !item.pinned } : item,
					),
				})),
			removeItem: (id) =>
				set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
			removeItems: (ids) => {
				const selected = new Set(ids);
				if (!selected.size) return;
				set((state) => ({
					items: state.items.filter((item) => !selected.has(item.id)),
				}));
			},
			addCategory: (name) => {
				const trimmed = name.trim();
				if (!trimmed || get().categories.some((category) => category.name === trimmed)) return;
				set((state) => ({
					categories: [
						...state.categories,
						{ id: `custom-${Date.now()}`, name: trimmed, color: "#6574c4" },
					],
				}));
			},
			renameCategory: (id, name) => {
				const trimmed = name.trim();
				if (
					!trimmed
					|| get().categories.some(
						(category) => category.id !== id && category.name === trimmed,
					)
				) return false;
				set((state) => ({
					categories: state.categories.map((category) =>
						category.id === id ? { ...category, name: trimmed } : category,
					),
				}));
				return true;
			},
			moveCategory: (id, direction) => set((state) => {
				const index = state.categories.findIndex((category) => category.id === id);
				const nextIndex = direction === "left" ? index - 1 : index + 1;
				if (index < 0 || nextIndex < 0 || nextIndex >= state.categories.length) return {};
				const categories = [...state.categories];
				[categories[index], categories[nextIndex]] = [categories[nextIndex], categories[index]];
				return { categories };
			}),
			removeCategory: (id) => {
				if (id === "uncategorized") return;
				set((state) => {
					const movedIds = state.items.filter((item) => item.categoryId === id).map((item) => item.id);
					const existingUncategorized = state.customOrderByCategory.uncategorized ?? [];
					const customOrderByCategory: Record<string, string[]> = { ...state.customOrderByCategory, uncategorized: [...existingUncategorized.filter((current) => !movedIds.includes(current)), ...movedIds] };
					delete customOrderByCategory[id];
					return {
						categories: state.categories.filter((category) => category.id !== id),
						items: state.items.map((item) => item.categoryId === id ? { ...item, categoryId: "uncategorized" } : item),
						sourceFolders: state.sourceFolders.map((source) => source.categoryId === id ? { ...source, categoryId: "uncategorized" } : source),
						customOrderByCategory,
					};
				});
			},
		}),
		{
			name: "reina-app-launcher",
			storage: createJSONStorage(() => durableWebStorage),
			version: 2,
			partialize: (state) => ({ categories: state.categories, items: state.items, sourceFolders: state.sourceFolders, sortMode: state.sortMode, customOrderByCategory: state.customOrderByCategory }),
		},
	),
);
