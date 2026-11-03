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
> This is an independent, non-official modified edition of [huoshen80/ReinaManager](https://github.com/huoshen80/ReinaManager). It is not maintained by, endorsed by, or compatible with the upstream release channel. Please report issues for this edition in this repository, not to the upstream project.

Modified edition repository: [AnneLuckyyy/ReinaManager-Custom](https://github.com/AnneLuckyyy/ReinaManager-Custom).

> [!NOTE]
> This edition keeps the upstream AGPL-3.0 license and copyright notices. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md). Parts of the implementation and documentation were produced with AI assistance; the publisher remains responsible for review, release decisions, and license compliance.

## What this edition changes

- Adds local-first workflows for bulk game import, folder-to-category bindings, application shortcuts, archive verification, and guarded download automation.
- Keeps advanced workflows out of normal browsing screens. Complex settings use a compact help entry: hover for a short explanation and click for a practical guide.
- Uses no personal default folders or executable paths in a fresh installation. Configure optional tool paths and folder associations in **Settings** when needed.
- Adds safeguards around destructive actions. Archive deletion is opt-in, independently verified, and refuses the direct child folders of a drive-level `Games` directory by default.

## Before using or contributing

- This project is currently developed and tested primarily on Windows. Do not assume that every customized workflow is cross-platform.
- Never commit local databases, cover archives, API tokens, downloaded files, signed installers, or private keys. The repository `.gitignore` contains the baseline exclusions; review `git status` before every commit.
- Upstream and this edition can evolve separately. Treat the local database as user data and make a backup before trying an untested build.

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
