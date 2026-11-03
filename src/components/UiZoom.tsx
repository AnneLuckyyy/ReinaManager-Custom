import { useEffect } from "react";
import { applyUiZoom, restoreUiZoom } from "@/services/uiZoom";

export const UiZoom = () => {
	useEffect(() => {
		void restoreUiZoom().catch((error) => {
			console.warn("恢复界面缩放失败:", error);
		});

		const handleZoomReset = (event: KeyboardEvent) => {
			if (
				event.ctrlKey &&
				!event.altKey &&
				!event.shiftKey &&
				(event.key === "0" || event.code === "Numpad0")
			) {
				event.preventDefault();
				void applyUiZoom(100).catch((error) => {
					console.warn("重置界面缩放失败:", error);
				});
			}
		};

		window.addEventListener("keydown", handleZoomReset, true);
		return () => window.removeEventListener("keydown", handleZoomReset, true);
	}, []);

	return null;
};
