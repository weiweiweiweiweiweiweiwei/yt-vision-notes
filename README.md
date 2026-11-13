# YT-Vision-Notes

YouTube 沉浸式截圖筆記：**Chrome 擴充功能**（在 YouTube 右側欄直接做多圖截圖筆記）＋ **GitHub Pages 知識庫網站**（像觀看紀錄一樣回顧），資料存在**你自己的 Google Drive**。

沒有建置步驟、沒有第三方套件、沒有伺服器 —— 全部是原生 JavaScript。

```
/shared      共用原始碼（唯一來源）：schema、Markdown、Drive API、IndexedDB 同步、ZIP、Lightbox/畫布編輯器
/extension   Chrome Extension (Manifest V3)   ← 「載入未封裝項目」選這個資料夾
/docs        GitHub Pages 網站 (SPA)           ← Pages 設定選 main 分支的 /docs
/scripts     build.mjs：把 /shared 複製到 extension/shared 與 docs/shared，並產生圖示
```

> 修改 `/shared` 裡的檔案後請執行 `node scripts/build.mjs`，兩端才會拿到新版。

---

## 功能總覽

**擴充功能（YouTube 頁面內）**
- 播放器控制列常駐按鈕，開啟後右側推薦欄換成筆記工作區（跟隨 YouTube 深/淺色主題）。
- **`[+]` 擷取畫面**：用 `<canvas>` 直接抓 `video.html5-main-video` 的畫面幀 → WebP，不含暫停遮罩、進度條、控制列。快捷鍵 `Alt+S`。
- **同主題多張連拍**：多次 `[+]` 都進同一則草稿的圖片列，可拖曳排序、單張刪除，每張有自己的時間戳。
- 沒截圖就按儲存時，會**自動擷取當下畫面**。
- Markdown 筆記、`#標籤`（含自動補全）、`[[雙向連結]]`、`❝ CC 字幕` 一鍵引用、`⏱` 插入時間戳。
- 影片主分類（可新增/改名/改色/刪除）。本片筆記清單可點時間戳跳轉、編輯、刪除。

**Lightbox / 畫布編輯器（兩端共用）**
- 滾輪縮放、拖曳平移、`← →` 切換同則筆記的連續截圖。
- 裁切、畫筆、螢光筆、箭頭、矩形、圓形、文字（雙擊圖片即可輸入）。
- Undo / Redo / Clear All（還原原始底圖）。原始截圖永遠保留，標註以圖層資料另存，可隨時再編輯。
- 快捷鍵：`V` 平移、`P` 畫筆、`H` 螢光筆、`A` 箭頭、`R` 矩形、`E` 圓形、`T` 文字、`C` 裁切、`Ctrl+Z / Ctrl+Y`、`Ctrl+S` 儲存、`0` 符合視窗、`Esc` 關閉。

**知識庫網站**
- 觀看紀錄風格首頁：分類 Tabs、熱門標籤膠囊、全文搜尋（`/` 聚焦搜尋框）。
- 點標籤 → 跨影片知識卡片牆。
- 單片複習頁：內嵌 YouTube 播放器＋時間軸筆記，點時間戳立即跳轉播放。
- 反向連結、補充文字筆記、編輯/刪除、匯出 `.md + 圖片` ZIP。
- 支援電腦、平板、手機。

---

## 安裝步驟

### 1. 載入擴充功能（先做，因為需要它的 ID）
1. Chrome 開 `chrome://extensions` → 右上開啟「開發人員模式」→「載入未封裝項目」→ 選 `extension` 資料夾。
2. 記下卡片上的 **ID**（32 個小寫字母）。只要資料夾路徑不變，這個 ID 就不會變。

即使還沒設定 Google，筆記也已經可以使用（存在本機），之後登入會自動上傳。

### 2. Google Cloud Console 設定
兩個 OAuth 用戶端**必須建在同一個專案**：`drive.file` 權限是以「專案」為單位，這樣網站才讀得到擴充功能建立的檔案。

1. 到 <https://console.cloud.google.com/> 建立專案（例如 `yt-vision-notes`）。
2. **API 和服務 → 程式庫** → 搜尋 **Google Drive API** → 啟用。
3. **API 和服務 → OAuth 同意畫面**（Google Auth Platform）
   - 使用者類型：**外部**；填應用程式名稱與你的 Email。
   - 資料存取權／範圍：新增 `https://www.googleapis.com/auth/drive.file`（這是非機密範圍，不需要 Google 審核）。
   - 目標對象：在「測試使用者」加入你自己的 Google 帳號。
     測試狀態下授權每 7 天會過期需重新登入；想免除可按「發布應用程式」（只用 `drive.file` 不需驗證）。
4. **憑證 → 建立憑證 → OAuth 用戶端 ID**，建立兩個：

   | 類型 | 設定 | 用在哪 |
   |---|---|---|
   | **Chrome 擴充功能** | 「項目 ID」填步驟 1 的擴充功能 ID | `extension/manifest.json` 的 `oauth2.client_id` |
   | **網頁應用程式** | 「已授權的 JavaScript 來源」加入 `https://<你的帳號>.github.io`（本機測試再加 `http://localhost:4173`）。不需要重新導向 URI。 | `docs/config.js` 的 `clientId`（或在網站 ⚙ 設定裡貼上） |

5. 把兩個 Client ID 貼到對應檔案；回 `chrome://extensions` 按擴充功能的「重新載入」。
6. 點工具列的擴充功能圖示 → **登入 Google**。

### 3. 部署網站到 GitHub Pages
```bash
git init
git add .
git commit -m "YT-Vision-Notes"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<repo>.git
git push -u origin main
```
GitHub repo → **Settings → Pages** → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾選 **`/docs`**。
網址會是 `https://<你的帳號>.github.io/<repo>/`，把它貼到擴充功能彈出視窗的「知識庫網站網址」，面板上的 ↗ 與標籤就能直接跳到網站。

> 網站原始碼公開沒關係：裡面沒有任何筆記資料，Client ID 也不是機密。筆記只存在你的 Google Drive 與各裝置瀏覽器的 IndexedDB。

本機預覽：`npx serve docs -l 4173`

---

## 資料 Schema

Google Drive 結構（都在你雲端硬碟的 `YT-Vision-Notes/` 內，可直接用 Drive 檢視）：

```
YT-Vision-Notes/
├── index.json                    分類、標籤索引、每部影片摘要
├── videos/{videoId}.json         該影片所有筆記、時間戳、標註圖層、圖片 fileId
└── images/{videoId}/
    ├── {imageId}.webp            原始截圖（不會被覆寫）
    └── {imageId}.edit.webp       套用裁切/標註後的成品
```

### `index.json`
```jsonc
{
  "schemaVersion": 1,
  "updatedAt": 1794542400000,
  "categories": [
    { "id": "cat_davinci", "name": "DaVinci 調色", "color": "#e5484d", "updatedAt": 0, "deleted": false }
  ],
  "tags": { "膚色校正": 3, "CST": 1 },            // 標籤 → 筆記則數
  "videos": {
    "dQw4w9WgXcQ": {
      "videoId": "dQw4w9WgXcQ", "title": "…", "channel": "…", "categoryId": "cat_davinci",
      "noteCount": 4, "imageCount": 11, "tags": ["節點串聯", "膚色校正"],
      "createdAt": 0, "updatedAt": 0, "deleted": false
    }
  }
}
```

### `videos/{videoId}.json`
```jsonc
{
  "schemaVersion": 1,
  "videoId": "dQw4w9WgXcQ", "title": "…", "channel": "…",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "duration": 1234,
  "categoryId": "cat_davinci", "metaUpdatedAt": 0,
  "createdAt": 0, "updatedAt": 0, "deleted": false,
  "notes": [
    {
      "id": "n_xxx", "ts": 312,                    // 秒
      "text": "Markdown…", "tags": ["節點串聯"],
      "createdAt": 0, "updatedAt": 0, "deleted": false,
      "images": [                                  // 順序 = 連拍步驟順序
        {
          "id": "img_xxx", "ts": 312, "w": 1920, "h": 1080,
          "fileId": "<Drive id：原圖>", "editedFileId": "<Drive id：編輯後>", "editedAt": 0,
          "edits": {                               // null = 未編輯；座標皆為原圖像素
            "crop": { "x": 0, "y": 0, "w": 800, "h": 450 },
            "shapes": [
              { "type": "arrow", "color": "#ff3b30", "size": 9, "x1": 0, "y1": 0, "x2": 10, "y2": 10 },
              { "type": "pen",   "color": "#ff3b30", "size": 9, "pts": [[0, 0], [5, 5]] },
              { "type": "text",  "color": "#ffd60a", "size": 9, "x": 0, "y": 0, "text": "重點" }
            ]                                      // type: pen | hl | arrow | rect | ellipse | text
          }
        }
      ]
    }
  ]
}
```

### 同步方式（Delta Sync）
- 兩端各有自己的 IndexedDB（`videos`、`blobs`、`kv`），畫面永遠先讀本機 → 秒開、可離線。
- 同步時：讀 `index.json` → 只下載 `updatedAt` 與上次同步不同的影片 JSON → 以「筆記為單位、最後修改者勝」合併（刪除用墓碑標記）→ 只上傳有變動的影片與尚未上傳的圖片 → 更新 `index.json`。
- 圖片在要顯示時才從 Drive 下載並快取。
- 擴充功能：每次儲存後立即同步，另外每 30 分鐘背景同步一次。網站：開啟時、修改後、切回分頁時同步。

---

## 已知限制
- **受 DRM 保護的影片**（部分電影、YouTube Premium 內容）瀏覽器不允許讀取畫面，會提示無法擷取。
- 網站的 Google 登入權杖有效約 1 小時，過期後按一下右上角「重新連線」即可（Google 對純前端網站的限制）；擴充功能端不受影響。
- 擴充功能使用 `chrome.identity`，需在 Google Chrome 使用（Edge/Brave 的行為不同）。
- 同一則筆記在兩台裝置上「同時」被修改時，較晚儲存的版本會勝出。
- YouTube 改版若更動 `.ytp-right-controls`、`#secondary` 等節點，需調整 `extension/content.js` 的選擇器。
