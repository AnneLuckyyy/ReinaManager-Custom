import { invoke } from "@tauri-apps/api/core";

export type AppLauncherCandidate = {
	path: string;
	name: string;
	kind: "shortcut" | "url" | "executable";
};

export const appLauncherService = {
	scanFolder(folderPath: string) {
		return invoke<AppLauncherCandidate[]>("scan_app_launcher_folder", { folderPath });
	},
	resolvePaths(paths: string[]) {
		return invoke<AppLauncherCandidate[]>("resolve_app_launcher_paths", { paths });
	},
	createShortcut(executablePath: string, destinationFolder: string) {
		return invoke<AppLauncherCandidate>("create_app_launcher_shortcut", {
			executablePath,
			destinationFolder,
		});
	},
	copyItemToSource(sourcePath: string, destinationFolder: string) {
		return invoke<AppLauncherCandidate>("copy_app_launcher_item_to_source", {
			sourcePath,
			destinationFolder,
		});
	},
	launch(path: string) {
		return invoke<void>("launch_app_launcher_item", { path });
	},
	openLocation(path: string) {
		return invoke<void>("open_app_launcher_item_location", { path });
	},
	getIcons(paths: string[]) {
		return invoke<Record<string, string>>("get_app_launcher_icons", { paths });
	},
};
