<div align="center">
  <div style="width:200px">
    <a href="https://vndb.org/c64303">
      <img src="src-tauri/icons/reina.png" alt="Reina">
    </a>
  </div>

<h1>ReinaManager — Customized Edition</h1>

<p align="center">English|<a href="./README.zh_CN.md">中文</a>|<a href="./README.zh_TW.md">繁體中文</a>|<a href="./README.ja_JP.md">日本語</a></p>

<h5>A lightweight galgame/visual-novel manager,Under development...</h5>

The `Reina` in the name is the character <a href="https://vndb.org/c64303"><b>妃 玲奈(Kisaki Reina)</b></a> from game <a href="https://vndb.org/v21852"><b>金色ラブリッチェ(Kin'iro Loveriche)</b></a>

</div>

> [!IMPORTANT]
> This is a community-maintained edition based on [huoshen80/ReinaManager](https://github.com/huoshen80/ReinaManager). It has its own app identity and release page and does not follow the upstream update channel. Issues specific to this edition are welcome in this repository.

Modified edition repository: [AnneLuckyyy/ReinaManager-Custom](https://github.com/AnneLuckyyy/ReinaManager-Custom).

> [!NOTE]
> This edition keeps the upstream AGPL-3.0 license and copyright notices. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md). Some changes and documentation were made with AI assistance, then reviewed and verified before being committed.

## What this edition changes

- ReinaManager 0.20.4 already provides metadata lookup, collections, play tracking, save management, and basic bulk operations. This edition focuses on making a local game library easier to organize, move, and maintain.
- **Local import and metadata matching**: multiple default scan roots, deep launch-file scanning, cross-drive path deduplication, manual Bangumi/DLsite source selection, and a direct “open folder” check from every import row. Unlisted folders and their reasons remain visible.
- **Paths, launching, and cloud state**: primary and fallback paths retain history; failed launches can try a configured drive-letter replacement; a game can be marked as cloud-only from the context menu; opening a game folder can fall back to its parent directory.
- **Automatic organization and application management**: multiple local source folders can map to collection categories. Single import, bulk import, and download/install import append the matching category. The applications page accepts `.lnk`, `.url`, and `.exe` drops and can manually scan configured source folders.
- **Backups, restore, and covers**: database backup and restore include settings and application-page data. Custom covers are backed up separately from network-cover cache. Monthly and on-exit backups are available.
- **Downloads and game archives**: download tasks can safely auto-import, clean up their task files, and continue later tasks. Games can be queued for 7-Zip archiving, verified, then optionally moved to the Recycle Bin or deleted. Removing originals always requires an explicit choice, and direct children of any drive-level `Games` folder are protected by default.
- **Settings made easier to manage**: settings are grouped by feature, with separate pages for paths and folder bindings. Regular help icons give a short hint; complex options can open a fuller guide. Fresh installs do not include personal folders or external-tool paths.

This repository may also selectively integrate suitable compatibility improvements from later upstream versions. Those integrations are not presented as original features of this edition; their differences are recorded in the change history.

## Using and contributing

- Windows is the primary development and verification platform. Basic use on other platforms may work, but extended workflows are not guaranteed to behave identically.
- Issues and improvements are welcome. Before contributing, make sure a commit does not include local databases, cover archives, tokens, downloaded files, installers, or private keys. `.gitignore` is only a baseline; review `git status` first.
- This edition and upstream evolve separately. Back up your database before trying a test build or manually installing a new version.

## Stacks

- Tauri 2.0

- React

- Material UI

- UnoCSS

- Zustand

- TanStack Query

- Sqlite

- Rust

- SeaORM

## Features

- 🌐 **Multi-source Data Integration** - Seamlessly fetch and merge game metadata from VNDB, Bangumi, YmGal and Kungal APIs
- 🔍 **Powerful Search** - Smart search game from titles, aliases, custom names, and other metadata
- 📚 **Collection Management** - Organize games with hierarchical groups and categories for better library management, support drag and drop sorting
- 🎮 **Play Time Tracking** - Automatic gameplay session recording with detailed play time statistics and history
- 🎨 **Customization** - Set custom metadata for games such as covers, names, tags, etc., to create a personalized game library
- 🔄 **Batch Operations** - Bulk import, add and update game metadata from APIs 
- 🌍 **Multi-language Support** - Complete i18n support with multiple language interfaces, including Chinese (Simplified, Traditional), English, Japanese, etc.
- 🔒 **NSFW Filter** - Hide or cover NSFW content with a simple toggle
- 💾 **Auto Savedata Backup** - Configurable automatic backup to protect your game savedata
- 🚀 **System Integration** - Auto-start on boot and minimize to system tray
- 🎮 **Tool Integration** - Launch games with LE locale switching and Magpie upscaling integration

## Todo

- [x] Bulk import games from folders
- [x] Basic support for the Linux platform
- [x] Sync game status with Bangumi and VNDB
- [ ] Beautify individual pages

## Migration

Need to migrate your data from other galgame/visual-novel managers? Check out [reina_migrator](https://github.com/huoshen80/reina_migrator) - a tool for migrating others manager data into ReinaManager.

Currently supports:
- **WhiteCloud** data migration

The migrator helps you seamlessly transfer your game library, play time records, and other data from supported managers to ReinaManager.

## Screenshots

![Home](screenshots/home.png)
![Library](screenshots/library.png)
![Detail](screenshots/detail.png)
![Stats](screenshots/stats.png)
![Collection](screenshots/collection.png)

## Releases

This modified edition has its own application identifier and does not use the upstream release channel or updater. Public builds are made with `pnpm run package:public`; they can be published as manually downloaded release assets. Automated release publishing is intentionally disabled until this repository has its own signing key and update endpoint.

## Contribution
##### Start
Contributions are welcome! If you have suggestions for improvements, bug reports, or want to submit a pull request, please follow these steps:

1. Fork this repository and create your branch from `main`.
2. If you have fixed a bug or added a feature, please try to conduct the corresponding tests.
3. Ensure your code follows the existing style and passes all checks.
4. Submit a pull request with a clear description of your changes.

##### How to build and run the project locally
1. Make sure you have [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/) installed on your machine.
2. Clone the repository:
   ```bash
   git clone https://github.com/AnneLuckyyy/ReinaManager-Custom.git
   cd ReinaManager-Custom
   ```
3. Install the dependencies:
   ```bash
   pnpm install
   ```
4. Run the development server:
   ```bash
   pnpm tauri dev
   ```
5. Build the application for production:
   ```bash
   pnpm run package:public
   ```

Thank you for helping improve this modified edition. Please keep the upstream attribution and AGPL-3.0 obligations intact.

## Data Sources

- **[Bangumi](https://bangumi.tv/)** - Bangumi 番组计划

- **[VNDB](https://vndb.org/)** - the visual novel database

- **[Ymgal](https://www.ymgal.games/)** - 月幕Galgame

- **[Kungal](https://www.kungal.com/)** - 鲲 Galgame

Special thanks to these platforms for providing public APIs and data!

## License

This project is licensed under the [AGPL-3.0 license](./LICENSE). See [NOTICE.md](./NOTICE.md) for upstream attribution and modification notices.
