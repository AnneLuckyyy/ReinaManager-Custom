<div align="center">
  <div style="width:200px">
    <a href="https://vndb.org/c64303">
      <img src="src-tauri/icons/reina.png" alt="Reina">
    </a>
  </div>

<h1>ReinaManager — 改版擴充</h1>

<p align="center"><a href="./README.md">English</a>|<a href="./README.zh_CN.md">中文</a>|繁體中文|<a href="./README.ja_JP.md">日本語</a></p>

<h5>一個輕量級的galgame/視覺小說管理工具，正在開發中...</h5>

名稱中的 `Reina` 來源於遊戲 <a href="https://vndb.org/v21852"><b>金色ラブリッチェ(Kin'iro Loveriche)</b></a> 中的角色 <a href="https://vndb.org/c64303"><b>妃 玲奈(Kisaki Reina)</b></a>

</div>

> [!IMPORTANT]
> 這是基於 [huoshen80/ReinaManager](https://github.com/huoshen80/ReinaManager) 的社群維護改版，使用獨立的應用程式識別與發布頁，且不跟隨上游的自動更新。與本改版相關的問題歡迎在本倉庫回報。

> [!NOTE]
> 本改版保留上游的 AGPL-3.0 授權與版權聲明，詳見 [LICENSE](./LICENSE) 與 [NOTICE.md](./NOTICE.md)。部分改動與文件由 AI 工具協助完成，並在提交前經人工整理與驗證。

## 改版重點

- 在保留 0.20.4 原有資料檢索、收藏、遊玩記錄、存檔與基礎批量操作的前提下，著重補強本地遊戲庫的整理、遷移與維護。
- 提供多個預設掃描根目錄、深層啟動程式掃描、跨磁碟路徑去重、Bangumi／DLsite 手動資料來源選擇，以及可直接開啟資料夾確認的批量導入流程。
- 支援來源目錄自動歸類、應用程式捷徑匯入、完整的資料庫／自訂封面備份還原，以及具佇列、驗證、回收站與目錄保護機制的下載和遊戲封存工作流。
- 本倉庫也會選擇性合入合適的上游相容性改進；這類內容不會作為本改版的原創功能宣傳。

## 技術棧

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

- 🌐 **多源數據整合** - 無縫獲取並合併來自 VNDB、Bangumi、YmGal 和 Kungal API 的遊戲元數據
- 🔍 **強大的搜尋** - 通過遊戲標題、別名、自定義名稱及其他元數據智能搜尋遊戲
- 📚 **收藏管理** - 使用分層的分組和分類來組織遊戲，更好地管理遊戲庫，支持拖拽排序
- 🎮 **遊戲時長追蹤** - 自動記錄遊戲會話，提供詳細的遊玩時間統計和歷史記錄
- 🎨 **個性化定制** - 為遊戲設置自定義元數據，如封面、名稱、標籤等，打造個性化遊戲庫
- 🔄 **批量操作** - 從 API 批量匯入、添加和更新遊戲元數據
- 🌍 **多語言支持** - 完整的國際化支持，提供多種語言界面，包括中文（簡體、繁體）、英文、日文等
- 🔒 **NSFW 過濾** - 通過簡單的開關隱藏或遮蓋 NSFW 內容
- 💾 **自動存檔備份** - 可配置的自動備份功能，保護您的遊戲存檔數據
- 🚀 **系統集成** - 開機自啟動和最小化到系統托盤
- 🎮 **工具整合** - 啟動遊戲可聯動 LE 轉區和 Magpie 放大

## 待辦事項

- [x] 從資料夾批量匯入遊戲
- [x] 對 Linux 平台的基礎支持
- [x] 與 Bangumi 和 VNDB 同步遊戲狀態
- [ ] 美化各個頁面

## 遷移

需要從其他 galgame/視覺小說管理器遷移數據？請查看 [reina_migrator](https://github.com/huoshen80/reina_migrator) - 一個用於將其他管理器數據遷移到 ReinaManager 的工具。

當前支持：
- **WhiteCloud** 數據遷移

該遷移工具可幫助您無縫轉移遊戲庫、遊玩時間記錄和其他數據到 ReinaManager。

## 截圖

![主頁](screenshots/home.png)
![遊戲庫](screenshots/library.png)
![詳情頁](screenshots/detail.png)
![統計](screenshots/stats.png)
![收藏](screenshots/collection.png)

本改版不使用上游的自動更新。公開建置請使用 `pnpm run package:public`；在擁有本倉庫自己的簽名金鑰與更新位址前，僅應手動發佈安裝包。

## 貢獻
##### 開始
歡迎各種形式的貢獻！如果你有改進建議、發現了 bug，或想提交 Pull Request，請依照以下步驟：

1. Fork 本倉庫，並從 `main` 分支建立新分支。
2. 若修復了 bug 或新增功能，請盡量進行相關測試。
3. 請確保程式碼風格與現有代碼一致，並通過所有檢查。
4. 提交 Pull Request，並清楚描述你的更改內容。

##### 本機建構與執行專案
1. 確保已安裝 [Node.js](https://nodejs.org/) 及 [Rust](https://www.rust-lang.org/)。
2. Clone 倉庫：
   ```bash
   git clone https://github.com/AnneLuckyyy/ReinaManager-Custom.git
   cd ReinaManager-Custom
   ```
3. 安裝依賴：
   ```bash
   pnpm install
   ```
4. 啟動開發伺服器：
   ```bash
   pnpm tauri dev
   ```
5. 建構生產版本：
   ```bash
   pnpm run package:public
   ```

感謝你為本改版做出的貢獻。請始終保留上游專案署名與 AGPL-3.0 義務。

## 贊助
如果你覺得這個專案好用，並希望支持項目的開發，可以考慮贊助。非常感謝每個支持者！

## 數據源

- **[Bangumi](https://bangumi.tv/)** - Bangumi 番組計劃

- **[VNDB](https://vndb.org/)** - 視覺小說數據庫

- **[Ymgal](https://www.ymgal.games/)** - 月幕Galgame

- **[Kungal](https://www.kungal.com/)** - 鯤 Galgame

特別感謝這些平台提供的公共 API 和數據！

## 許可證

本專案採用 [AGPL-3.0 許可證](./LICENSE)

## Star 歷史
