import type { GameCategorySourceFolder } from "@/store/modStore";

function normalizePath(path: string): string {
	return path
		.trim()
		.replace(/[\\/]+/g, "\\")
		.replace(/\\+$/, "")
		.toLocaleLowerCase();
}

/**
 * 找到包含该游戏目录/启动文件的最具体来源目录。
 *
 * 这里刻意按完整目录边界比较，不能把 `Games` 错认成 `GamesBackup`；
 * 重叠绑定只采用更深的一项，避免一次导入自动加入多个分类。
 */
export function findGameCategorySourceFolder(
	path: string | null | undefined,
	sources: readonly GameCategorySourceFolder[],
): GameCategorySourceFolder | undefined {
	const normalizedPath = normalizePath(path ?? "");
	if (!normalizedPath) return undefined;

	return sources
		.filter((source) => {
			const normalizedSource = normalizePath(source.path);
			return normalizedPath === normalizedSource || normalizedPath.startsWith(`${normalizedSource}\\`);
		})
		.sort((left, right) => normalizePath(right.path).length - normalizePath(left.path).length)[0];
}
