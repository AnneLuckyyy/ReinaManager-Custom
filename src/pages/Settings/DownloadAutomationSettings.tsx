import { Stack, Switch, Typography } from "@mui/material";
import { AdvancedSettingsHelp } from "@/components/AdvancedSettingsHelp";
import { useModStore } from "@/store/modStore";

/** 仅用于新创建任务的默认勾选；逐任务选择仍以任务数据库记录为准。 */
export function DownloadAutomationSettings() {
	const defaults = useModStore((state) => state.downloadTaskAutomationDefaults);
	const update = useModStore((state) => state.updateDownloadTaskAutomationDefaults);
	return (
		<Stack spacing={0.25}>
			<Stack direction="row" alignItems="center">
				<Typography variant="subtitle1" className="font-semibold">下载自动化</Typography>
				<AdvancedSettingsHelp
					tooltip="查看自动入库的条件、后续任务规则与安全边界。"
					title="下载自动化说明"
					sections={[
						{
							title: "适用场景",
							content: "为之后新建的下载任务预设选项。每个任务仍可单独修改；未勾选时，下载保持原来的手动确认流程。",
						},
						{
							title: "自动入库条件",
							content: "只在下载、校验、解压和目录整理全部成功，且只找到一个启动程序、资料又精确命中一个已有但无路径的游戏时才会执行。多个启动程序、资料不可靠或匹配不到时不会猜测，任务会保留给你手动处理。",
						},
						{
							title: "自动删除的范围",
							content: "它只能在自动入库成功后启用，并复用普通“删除任务”的逻辑：清理该任务自己的下载和临时文件，不会删除已经整理好的游戏目录。",
						},
						{
							title: "队列接续",
							content: "当前任务完成、暂停、取消或无法继续后，系统会依次尝试继续后面的暂停任务；一个任务失败不会阻塞之后的任务。",
						},
					]}
				/>
			</Stack>
			<Stack direction="row" alignItems="center" spacing={1}>
				<Typography variant="body2">新任务默认自动入库</Typography>
				<Switch checked={defaults.autoImport} onChange={(event) => update({ autoImport: event.target.checked, autoDelete: event.target.checked ? defaults.autoDelete : false })} />
			</Stack>
			<Stack direction="row" alignItems="center" spacing={1}>
				<Typography variant="body2" color={defaults.autoImport ? "text.primary" : "text.disabled"}>入库成功后自动删除任务文件</Typography>
				<Switch disabled={!defaults.autoImport} checked={defaults.autoDelete} onChange={(event) => update({ autoDelete: event.target.checked })} />
			</Stack>
		</Stack>
	);
}
