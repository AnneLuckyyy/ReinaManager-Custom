import {
	durableWebStorage,
	syncDurableWebStorageValue,
} from "@/utils/durableWebStorage";

const SNAPSHOT_VERSION = 1;

const PERSISTED_STORE_KEYS = [
	"reina-manager-store",
	"reina-manager-mod-store",
	"reina-app-launcher",
	"i18nextLng",
] as const;

type PersistedStoreKey = (typeof PERSISTED_STORE_KEYS)[number];

interface PersistentSettingsSnapshot {
	version: number;
	stores: Record<PersistedStoreKey, Record<string, unknown> | string | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(raw: string): PersistentSettingsSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("设置快照不是有效的 JSON 数据");
	}
	if (!isRecord(parsed) || parsed.version !== SNAPSHOT_VERSION || !isRecord(parsed.stores)) {
		throw new Error("设置快照格式不受支持");
	}

	const stores = {} as PersistentSettingsSnapshot["stores"];
	for (const key of PERSISTED_STORE_KEYS) {
		const value = parsed.stores[key];
		if (key === "i18nextLng") {
			if (value !== null && typeof value !== "string") {
				throw new Error(`设置快照中的 ${key} 无效`);
			}
			stores[key] = value;
		} else {
			if (value !== null && !isRecord(value)) {
				throw new Error(`设置快照中的 ${key} 无效`);
			}
			stores[key] = value;
		}
	}
	return { version: SNAPSHOT_VERSION, stores };
}

/**
 * 读取会影响用户功能的三个持久化 Zustand store 和语言选择。
 * 路由和设置页最后打开位置属于短暂界面状态，不参与数据恢复。
 */
export async function createPersistentSettingsSnapshot(): Promise<string> {
	const stores = {} as PersistentSettingsSnapshot["stores"];
	for (const key of PERSISTED_STORE_KEYS) {
		const raw = await durableWebStorage.getItem(key);
		if (raw === null) {
			stores[key] = null;
			continue;
		}
		try {
			if (key === "i18nextLng") {
				if (!raw.trim()) throw new Error("empty language");
				stores[key] = raw;
			} else {
				const value: unknown = JSON.parse(raw);
				if (!isRecord(value)) throw new Error("not a persisted store");
				stores[key] = value;
			}
		} catch {
			throw new Error(`无法读取本机设置：${key} 已损坏`);
		}
	}
	return JSON.stringify({ version: SNAPSHOT_VERSION, stores });
}

/** 仅在数据库导入已成功后写回同备份的设置快照。 */
export async function restorePersistentSettingsSnapshot(raw: string): Promise<void> {
	const snapshot = parseSnapshot(raw);
	for (const key of PERSISTED_STORE_KEYS) {
		const value = snapshot.stores[key];
		if (value === null) {
			await syncDurableWebStorageValue(key, null);
		} else if (key === "i18nextLng" && typeof value === "string") {
			await syncDurableWebStorageValue(key, value);
		} else {
			await syncDurableWebStorageValue(key, JSON.stringify(value));
		}
	}
}
