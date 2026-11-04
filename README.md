<div align="center">
  <div style="width:200px">
    <a href="https://vndb.org/c64303">
      <img src="src-tauri/icons/reina.png" alt="Reina">
    </a>
  </div>

# ReinaManager Custom

![Status](https://img.shields.io/badge/status-active-brightgreen) ![Stage](https://img.shields.io/badge/stage-beta-blue) ![License](https://img.shields.io/badge/license-AGPL--3.0-blue)

<p align="center">English | <a href="./README.zh_CN.md">简体中文</a></p>

<h5>A lightweight galgame / visual-novel manager for Windows.</h5>

The name <code>Reina</code> comes from <a href="https://vndb.org/v21852"><b>Kin'iro Loveriche</b></a> and its character <a href="https://vndb.org/c64303"><b>Kisaki Reina</b></a>.

</div>

Based on [huoshen80/ReinaManager](https://github.com/huoshen80/ReinaManager), maintained as an unofficial custom edition by AnneLucky. Please report edition-specific issues in this repository.

## Original ReinaManager features

The following core capabilities come from the original ReinaManager 0.20.4:

- 🌐 **Multi-source metadata** — retrieve game metadata from VNDB, Bangumi, YmGal, and Kungal.
- 🔍 **Search** — find games through titles, aliases, custom names, and other metadata.
- 📚 **Collection management** — organize a library with groups and categories.
- 🎮 **Playtime tracking** — record game sessions and view playtime history.
- 🎨 **Personalization** — use custom metadata such as covers, names, and tags.
- 🔄 **Batch operations** — add games and update metadata in batches.
- 🌍 **Localization** — Chinese, English, Japanese, and other interface languages.
- 🔒 **NSFW filter** — hide or mask NSFW content.
- 💾 **Save backup** — configurable game-save backup.
- 🚀 **System integration** — autostart, system tray, Locale Emulator, and Magpie support.

## Custom features

- **Multiple launcher paths** — retain a primary launcher with fallback paths; games moved between drives can be found again without manually rewriting every path.
- **Cloud-game switch** — move a local game to cloud status with one action while retaining its previous launcher as a fallback path.
- **Folder-to-category associations** — associate local folders with game or application categories to place eligible imports into the right category automatically.
- **115 archive catalogue** — import directory listings, identify split archives, and manually match archive entries to games.
- **Game folder packing** — queue game folders for 7-Zip packing, track packing and verification progress, then optionally remove the original folder after successful verification.
- **Applications page** — keep desktop applications, executables, and shortcuts in a separate browsable library with categories and custom ordering.
- **CrystalDiskInfo summary** — show a compact disk-health summary in the app when CrystalDiskInfo is configured.

## Tech stack

- Tauri 2.0
- React
- Material UI
- UnoCSS
- Zustand
- TanStack Query
- SQLite
- Rust
- SeaORM

## Screenshots

> Screenshots of this edition will be added after the current build is fully verified.

## Download

Download installers and portable builds from the [Releases page](https://github.com/AnneLuckyyy/ReinaManager-Custom/releases).

## Contribution

Contributions and issue reports are welcome. Please retain upstream attribution and the AGPL-3.0 license when redistributing modified versions.

### Run locally

1. Install [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/).
2. Clone this repository:

   ```bash
   git clone https://github.com/AnneLuckyyy/ReinaManager-Custom.git
   cd ReinaManager-Custom
   ```

3. Install dependencies and run the development build:

   ```bash
   pnpm install
   pnpm tauri dev
   ```

4. Create a release build:

   ```bash
   pnpm run package
   ```

## Data sources

- **[Bangumi](https://bangumi.tv/)**
- **[VNDB](https://vndb.org/)**
- **[YmGal](https://www.ymgal.games/)**
- **[Kungalgame](https://www.kungal.com/)**
- **[DLsite](https://www.dlsite.com/)**

## License

This project remains licensed under [AGPL-3.0](LICENSE). It is based on [ReinaManager](https://github.com/huoshen80/ReinaManager); original attribution and notices are retained in [NOTICE.md](NOTICE.md). Some implementation work in this edition was completed with AI assistance.
