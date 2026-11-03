import { load } from "@tauri-apps/plugin-store";
import type { StateStorage } from "zustand/middleware";

const STORE_FILE = "web-state.json";

let storePromise: ReturnType<typeof load> | null = null;

function getStore() {
	if (!storePromise) {
		storePromise = load(STORE_FILE, { autoSave: false, defaults: {} });
	}
	return storePromise;
}

async function readNativeValue(key: string): Promise<string | null> {
	try {
		const value = await (await getStore()).get<unknown>(key);
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

async function writeNativeValue(key: string, value: string): Promise<void> {
	try {
		const store = await getStore();
		await store.set(key, value);
		await store.save();
	} catch {
		// 浏览器本地存储仍是当前会话的可用回退；下次写入会再次尝试镜像。
	}
}

async function deleteNativeValue(key: string): Promise<void> {
	try {
		const store = await getStore();
		await store.delete(key);
		await store.save();
	} catch {
		// 与写入相同：不能因为镜像失败而破坏当前会话的删除操作。
	}
}

/**
 * 用应用数据目录内的 Tauri Store 镜像 Zustand 的 WebView 本地存储。
 *
 * 安装更新偶尔会重建 WebView 数据目录；镜像文件随应用身份留在 AppData，
 * 因而能在 localStorage 不见时恢复设置和应用页状态。读取时优先当前
 * localStorage，兼容既有数据并让已有的数据库备份快照继续生效。
 */
export const durableWebStorage: StateStorage = {
	getItem: (name) => {
		const current = window.localStorage.getItem(name);
		if (current !== null) {
			void writeNativeValue(name, current);
			return current;
		}
		return readNativeValue(name).then((mirrored) => {
			if (mirrored !== null) window.localStorage.setItem(name, mirrored);
			return mirrored;
		});
	},
	setItem: (name, value) => {
		window.localStorage.setItem(name, value);
		void writeNativeValue(name, value);
	},
	removeItem: (name) => {
		window.localStorage.removeItem(name);
		void deleteNativeValue(name);
	},
};

/** 备份/恢复快照需要把恢复后的值一并写回 AppData 镜像。 */
export async function syncDurableWebStorageValue(
	key: string,
	value: string | null,
): Promise<void> {
	if (value === null) {
		window.localStorage.removeItem(key);
		await deleteNativeValue(key);
		return;
	}
	window.localStorage.setItem(key, value);
	await writeNativeValue(key, value);
}
