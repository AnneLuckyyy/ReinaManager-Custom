<div align="center">
  <div style="width:200px">
    <a href="https://vndb.org/c64303">
      <img src="src-tauri/icons/reina.png" alt="Reina">
    </a>
  </div>

<h1>ReinaManager — 改版扩展</h1>

<p align="center"><a href="./README.md">English</a>|中文|<a href="./README.zh_TW.md">繁體中文</a>|<a href="./README.ja_JP.md">日本語</a></p>

<h5>一个轻量级的galgame/视觉小说管理工具，正在开发中...</h5>

名称中的 `Reina` 来源于游戏 <a href="https://vndb.org/v21852"><b>金色ラブリッチェ(Kin'iro Loveriche)</b></a> 中的角色 <a href="https://vndb.org/c64303"><b>妃 玲奈(Kisaki Reina)</b></a>

</div>

> [!IMPORTANT]
> 这是基于 [huoshen80/ReinaManager](https://github.com/huoshen80/ReinaManager) 的独立非官方改版，不由上游项目维护、认可或兼容其发布通道。请只在本仓库反馈改版特有的问题，不要把它们提交给上游项目。

改版仓库：[AnneLuckyyy/ReinaManager-Custom](https://github.com/AnneLuckyyy/ReinaManager-Custom)。

> [!NOTE]
> 本改版保留上游的 AGPL-3.0 许可证与版权声明，详见 [LICENSE](./LICENSE) 和 [NOTICE.md](./NOTICE.md)。部分实现与文档由 AI 辅助完成；发布者仍对审查、发布决定和许可证合规负责。

## 改版要点

- 新增本地优先的批量导入、目录与分类关联、应用快捷方式、游戏打包校验和受限下载自动化。
- 日常浏览界面保持简洁；较复杂的设置提供紧凑帮助入口：悬停可看短说明，点击可看使用场景、步骤和安全边界。
- 新安装不会预填个人目录或外部工具路径；需要时可在“设置”中自行选择。
- 涉及删除的打包操作必须由用户明确选择，并在归档校验后才会执行；默认保护盘符根目录 `Games` 下的直属目录。

## 使用与贡献前请注意

- 当前主要在 Windows 上开发与验证，不应假设所有改版工作流都跨平台可用。
- 不要提交本地数据库、封面归档、API Token、下载文件、安装包或私钥；`.gitignore` 只是基础保护，每次提交前仍应检查 `git status`。
- 上游与本改版可独立演进。尝试未经验证的构建前，请先备份本地数据库。

## 技术栈

- Tauri 2.0

- React

- Material UI

- UnoCSS

- Zustand

- TanStack Query

- Sqlite

- Rust

- SeaORM

## 功能特性

- 🌐 **多源数据整合** - 无缝获取并合并来自 VNDB、Bangumi、YmGal 和 Kungal API 的游戏元数据
- 🔍 **强大的搜索** - 通过游戏标题、别名、自定义名称及其他元数据智能搜索游戏
- 📚 **收藏管理** - 使用分层的分组和分类来组织游戏，更好地管理游戏库，支持拖拽排序
- 🎮 **游戏时长追踪** - 自动记录游戏会话，提供详细的游玩时间统计和历史记录
- 🎨 **个性化定制** - 为游戏设置自定义元数据，如封面、名称、标签等，打造个性化游戏库
- 🔄 **批量操作** - 从 API 批量导入、添加和更新游戏元数据
- 🌍 **多语言支持** - 完整的国际化支持，提供多种语言界面，包括中文(简体、繁体)、英文、日文等
- 🔒 **NSFW 过滤** - 通过简单的开关隐藏或遮盖 NSFW 内容
- 💾 **自动存档备份** - 可配置的自动备份功能，保护您的游戏存档数据
- 🚀 **系统集成** - 开机自启动和最小化到系统托盘
- 🎮 **工具集成** - 启动游戏可联动 LE 转区和 Magpie 放大

## 待办事项

- [x] 从文件夹批量导入游戏
- [x] 对 Linux 平台的基础支持 
- [x] 与 Bangumi 和 VNDB 同步游戏状态
- [ ] 美化各个页面

## 迁移

需要从其他 galgame/视觉小说管理器迁移数据？请查看 [reina_migrator](https://github.com/huoshen80/reina_migrator) - 一个用于将其他管理器数据迁移到 ReinaManager 的工具。

当前支持：
- **WhiteCloud** 数据迁移

该迁移工具可帮助您无缝转移游戏库、游玩时间记录和其他数据到 ReinaManager。

## 截图

![主页](screenshots/home.png)
![游戏库](screenshots/library.png)
![详情页](screenshots/detail.png)
![统计](screenshots/stats.png)
![收藏](screenshots/collection.png)

## 发布说明

本改版已有独立应用标识，且不会使用上游的发布通道或自动更新。公开构建请使用 `pnpm run package:public`，生成的安装包可作为手动下载的 Release 附件发布。在本仓库具备自己的签名密钥和更新地址前，不要开启应用内自动更新；自动发布工作流也暂时保持关闭。

## 贡献
##### 开始
欢迎任何形式的贡献！如果你有改进建议、发现了 bug，或希望提交 Pull Request，请按照以下步骤操作：

1. Fork 本仓库，并从 `main` 分支创建新分支。
2. 如果修复了 bug 或新增了功能，请尽量进行相应测试。
3. 保证代码风格与现有代码一致，并通过所有检查。
4. 提交 Pull Request，并清晰描述你的更改内容。

##### 本地构建与运行项目
1. 确保你已安装 [Node.js](https://nodejs.org/) 和 [Rust](https://www.rust-lang.org/)。
2. 克隆仓库：
   ```bash
   git clone https://github.com/AnneLuckyyy/ReinaManager-Custom.git
   cd ReinaManager-Custom
   ```
3. 安装依赖：
   ```bash
   pnpm install
   ```
4. 运行开发服务器：
   ```bash
   pnpm tauri dev
   ```
5. 构建生产版本：
   ```bash
   pnpm run package:public
   ```

感谢你为本改版做出的贡献。请始终保留原项目署名与 AGPL-3.0 义务。

## 数据源

- **[Bangumi](https://bangumi.tv/)** - Bangumi 番组计划

- **[VNDB](https://vndb.org/)** - 视觉小说数据库

- **[Ymgal](https://www.ymgal.games/)** - 月幕Galgame

- **[Kungal](https://www.kungal.com/)** - 鲲 Galgame

特别感谢这些平台提供的公共 API 和数据！

## 许可证

本项目采用 [AGPL-3.0 许可证](./LICENSE)，原项目来源与改动说明见 [NOTICE.md](./NOTICE.md)。
