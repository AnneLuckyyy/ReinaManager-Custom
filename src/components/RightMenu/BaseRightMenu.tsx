/**
 * @file BaseRightMenu 基础右键菜单容器组件
 * @description 提供统一的定位、自动关闭和键盘事件处理逻辑，供 RightMenu 和 CollectionRightMenu 复用
 * @module src/components/RightMenu/BaseRightMenu
 * @author ReinaManager
 * @copyright AGPL-3.0
 */

import { Paper } from "@mui/material";
import { type PropsWithChildren, useEffect, useRef } from "react";

/**
 * BaseRightMenu 组件属性类型
 */
interface BaseRightMenuProps {
	isopen: boolean;
	anchorPosition?: { top: number; left: number };
	onClose: () => void;
	ariaLabel: string;
}

/**
 * 基础右键菜单容器组件
 * 封装了菜单的定位、自动关闭、键盘事件等通用逻辑
 */
export const BaseRightMenu: React.FC<PropsWithChildren<BaseRightMenuProps>> = ({
	isopen,
	anchorPosition,
	onClose,
	ariaLabel,
	children,
}) => {
	const menuRef = useRef<HTMLDivElement | null>(null);

	/**
	 * 监听菜单外部点击、滚动、窗口变化，自动关闭菜单
	 */
	useEffect(() => {
		const handleInteraction = () => {
			onClose();
		};

		if (isopen) {
			document.addEventListener("click", handleInteraction);
			document.addEventListener("scroll", handleInteraction, true);
			window.addEventListener("resize", handleInteraction);
		}

		// 计算菜单位置
		if (menuRef.current && anchorPosition) {
			const { offsetWidth, offsetHeight } = menuRef.current;
			const newTop = Math.min(
				anchorPosition.top,
				window.innerHeight - offsetHeight,
			);
			const newLeft = Math.min(
				anchorPosition.left,
				window.innerWidth - offsetWidth,
			);
			menuRef.current.style.top = `${newTop}px`;
			menuRef.current.style.left = `${newLeft}px`;
		}

		return () => {
			document.removeEventListener("click", handleInteraction);
			document.removeEventListener("scroll", handleInteraction, true);
			window.removeEventListener("resize", handleInteraction);
		};
	}, [isopen, onClose, anchorPosition]);

	// 打开时将焦点移到菜单容器以便支持键盘事件（例如 Esc 关闭）
	useEffect(() => {
		if (isopen && menuRef.current) {
			menuRef.current.focus();
		}
	}, [isopen]);

	if (!isopen) return null;
	if (!anchorPosition) return null;

	return (
		<div
			role="menu"
			aria-label={ariaLabel}
			tabIndex={-1}
			className="fixed z-50 animate-fade-in animate-duration-100 select-none"
			ref={menuRef}
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				if (e.key === "Escape" || e.key === "Esc") {
					onClose();
				}
			}}
		>
			<Paper
				elevation={8}
				sx={{
					minWidth: "200px",
					borderRadius: 2,
					textAlign: "left",
				}}
			>
				{children}
			</Paper>
		</div>
	);
};
