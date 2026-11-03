import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useModStore } from "@/store/modStore";

export const MIN_UI_ZOOM_PERCENT = 80;
export const MAX_UI_ZOOM_PERCENT = 150;
export const UI_ZOOM_PRESETS = [80, 90, 100, 110, 125, 150] as const;

export function normalizeUiZoomPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 100;
	return Math.min(
		MAX_UI_ZOOM_PERCENT,
		Math.max(MIN_UI_ZOOM_PERCENT, Math.round(percent)),
	);
}

export async function applyUiZoom(percent: number): Promise<void> {
	const nextPercent = normalizeUiZoomPercent(percent);
	await getCurrentWebview().setZoom(nextPercent / 100);
	useModStore.getState().setUiZoomPercent(nextPercent);
}

export async function restoreUiZoom(): Promise<void> {
	const savedPercent = normalizeUiZoomPercent(
		useModStore.getState().uiZoomPercent,
	);
	await getCurrentWebview().setZoom(savedPercent / 100);
}
