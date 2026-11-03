function getDirectoryNameFromExecutablePath(path: string): string {
	const normalizedPath = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
	const separatorIndex = normalizedPath.lastIndexOf("/");
	if (separatorIndex <= 0) return "";

	const parentPath = normalizedPath.slice(0, separatorIndex).replace(/\/+$/, "");
	const directoryName = parentPath.slice(parentPath.lastIndexOf("/") + 1).trim();
	return /^[A-Za-z]:$/.test(directoryName) ? "" : directoryName;
}

export function deriveBackupMatchName(
	localPath?: string | null,
	extraLocalPaths?: readonly string[] | null,
): string {
	const path = localPath?.trim() || [...(extraLocalPaths ?? [])].reverse().find((item) => item.trim());
	return path ? getDirectoryNameFromExecutablePath(path) : "";
}
