function normalizeTagFilterValue(tag: string): string {
	return tag.trim().toLowerCase();
}

export function normalizeTagFilters(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const tag of tags) {
		const trimmed = tag.trim();
		const normalized = normalizeTagFilterValue(trimmed);
		if (!trimmed || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(trimmed);
	}

	return result;
}

export function buildNormalizedTagMap(
	tags: readonly string[],
): Map<string, string> {
	const tagMap = new Map<string, string>();
	for (const tag of tags) {
		const trimmed = tag.trim();
		if (trimmed) tagMap.set(normalizeTagFilterValue(trimmed), trimmed);
	}
	return tagMap;
}

export function matchesAllTagFilters(
	tags: readonly string[],
	filters: readonly string[],
): boolean {
	if (filters.length === 0) return true;
	if (tags.length === 0) return false;

	const normalizedTags = new Set(tags.map(normalizeTagFilterValue));
	return filters.every((filter) =>
		normalizedTags.has(normalizeTagFilterValue(filter)),
	);
}

export function findTagByInput(
	tagMap: ReadonlyMap<string, string>,
	input: string,
): string | undefined {
	return tagMap.get(normalizeTagFilterValue(input));
}

export function filterTagSuggestions(
	tagMap: ReadonlyMap<string, string>,
	selectedTags: readonly string[],
	input: string,
	limit: number,
): string[] {
	const normalizedInput = normalizeTagFilterValue(input);
	if (!normalizedInput || limit <= 0) return [];

	const selected = new Set(selectedTags.map(normalizeTagFilterValue));
	const suggestions: string[] = [];
	for (const [normalizedTag, tag] of tagMap) {
		if (selected.has(normalizedTag) || !normalizedTag.includes(normalizedInput)) {
			continue;
		}
		suggestions.push(tag);
		if (suggestions.length >= limit) break;
	}
	return suggestions;
}
