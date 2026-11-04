<div align="center">
  <div style="width:200px">
    <a href="https://vndb.org/c64303">
      <img src="src-tauri/icons/reina.png" alt="Reina">
    </a>
  </div>

# ReinaManager Custom

![状态](https://img.shields.io/badge/status-active-brightgreen) ![阶段](https://img.shields.io/badge/stage-beta-blue) ![许可证](https://img.shields.io/badge/license-AGPL--3.0-blue)

<p align="center"><a href="./README.md">English</a> | 简体中文</p>

<h5>一个轻量级的 Galgame / 视觉小说 Windows 管理工具。</h5>

名称中的 <code>Reina</code> 来源于游戏 <a href="https://vndb.org/v21852"><b>金色ラブリッチェ</b></a> 中的角色 <a href="https://vndb.org/c64303"><b>妃 玲奈</b></a>。

</div>

本项目基于 [huoshen80/ReinaManager](https://github.com/huoshen80/ReinaManager)，由 AnneLucky 维护为非官方个人改版；与本改版有关的问题请在本仓库反馈。

## 原版 ReinaManager 已有功能

以下基础能力来自原版 ReinaManager 0.20.4：

- 🌐 **多源数据整合**：从 VNDB、Bangumi、YmGal 和 Kungal 获取游戏元数据。
- 🔍 **游戏搜索**：按标题、别名、自定义名称及其他元数据查找游戏。
- 📚 **收藏管理**：使用分组和分类整理游戏库。
- 🎮 **游戏时长追踪**：记录游戏会话并查看游玩时长历史。
- 🎨 **个性化定制**：使用自定义封面、名称、标签等元数据。
- 🔄 **批量操作**：批量添加游戏和更新元数据。
- 🌍 **多语言支持**：提供中文、英文、日文等界面语言。
- 🔒 **NSFW 过滤**：隐藏或遮盖 NSFW 内容。
- 💾 **存档备份**：可配置的游戏存档备份。
- 🚀 **系统集成**：开机自启、系统托盘、Locale Emulator 与 Magpie 联动。

## 本改版新增功能

- **多启动路径**：主启动路径之外可保留备用路径；游戏在不同盘符间移动后，可避免逐项手动重填路径。
- **设为云端游戏**：一键把本地游戏转为云端状态，同时保留原启动路径作为备用路径。
- **目录与分类关联**：将本地目录绑定到游戏或应用分类，使符合条件的导入项自动进入对应分类。
- **115 目录索引**：导入目录清单、识别分卷压缩包，并手动把压缩包条目关联到游戏。
- **游戏文件夹打包**：用 7-Zip 排队打包游戏目录，显示打包与核验进度；核验成功后可选择移除原目录。
- **应用页**：独立管理桌面应用、可执行文件与快捷方式，支持分类和自定义排序。
- **CrystalDiskInfo 摘要**：配置 CrystalDiskInfo 后，在应用内查看精简的磁盘健康信息。

## 技术栈

- Tauri 2.0
- React
- Material UI
- UnoCSS
- Zustand
- TanStack Query
- SQLite
- Rust
- SeaORM

## 截图

> 当前改版的实机截图将在完整验证后补充。

## 下载

请在 [Releases 页面](https://github.com/AnneLuckyyy/ReinaManager-Custom/releases) 下载安装包或便携版。

## 贡献

欢迎提交问题和改进。分发修改版时请保留上游署名与 AGPL-3.0 许可证。

### 本地构建与运行

1. 安装 [Node.js](https://nodejs.org/) 和 [Rust](https://www.rust-lang.org/)。
2. 克隆本仓库：

   ```bash
   git clone https://github.com/AnneLuckyyy/ReinaManager-Custom.git
   cd ReinaManager-Custom
   ```

3. 安装依赖并运行开发版：

   ```bash
   pnpm install
   pnpm tauri dev
   ```

4. 构建发布版：

   ```bash
   pnpm run package
   ```

## 数据源

- **[Bangumi](https://bangumi.tv/)**
- **[VNDB](https://vndb.org/)**
- **[YmGal](https://www.ymgal.games/)**
- **[Kungalgame](https://www.kungal.com/)**
- **[DLsite](https://www.dlsite.com/)**

## 许可证

本项目继续采用 [AGPL-3.0](LICENSE) 许可证，基于 [ReinaManager](https://github.com/huoshen80/ReinaManager) 改版；原作者署名与通知保留在 [NOTICE.md](NOTICE.md)。本改版的部分实现由 AI 协助完成。
