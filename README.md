# YT-Vision-Notes

YouTube 沉浸式截圖筆記：**Chrome 擴充功能**（在 YouTube 旁邊直接用白板做截圖筆記）＋ **GitHub Pages 知識庫網站**（像觀看紀錄一樣回顧），資料存在**你自己的 Google Drive**。

沒有建置步驟、沒有第三方套件、沒有伺服器 —— 全部是原生 JavaScript。

```
/shared      共用原始碼（唯一來源）：schema、白板引擎、Markdown、Drive API、IndexedDB 同步、ZIP、Lightbox/畫布編輯器
/extension   Chrome Extension (Manifest V3)   ← 「載入未封裝項目」選這個資料夾
/docs        GitHub Pages 網站 (SPA)           ← Pages 設定選 main 分支的 /docs
/scripts     build.mjs：把 /shared 複製到 extension/shared 與 docs/shared，並產生圖示
```

> 修改 `/shared` 裡的檔案後請執行 `node scripts/build.mjs`，兩端才會拿到新版。

---

## 功能總覽

像 Milanote 一樣的白板筆記：**Board 裡可以再開 Board**，卡片自由擺放。YouTube 側邊面板、彈出視窗、知識庫網站用的是同一套白板，資料互通。

**在 YouTube 上（擴充功能）**
- 播放器控制列的筆記按鈕：右側推薦欄換成白板。**每次打開都從「首頁」開始**，自己選要新增 Board 還是進入舊的 Board（首頁上方有「最近使用」）。
- **`截圖`（或 `Alt+S`）**：用 `<canvas>` 抓 `video.html5-main-video` 的原始畫面（不含控制列、進度條），**直接在目前的 Board 新增一張截圖卡**，自動排在上一張旁邊；卡片記住時間戳和影片，點時間戳跳回那一秒。
- **`總結`**：針對整部影片的總結筆記（不含截圖），卡片上會標示影片，點一下回到影片。
- **可拖曳的分隔線**：播放器和筆記之間拖曳調整比例；雙擊分隔線在 1/3、1/2、2/3 之間切換；比例會記住。
- **彈出成獨立視窗**：面板右上角 ⧉，筆記變成獨立視窗，可拖到第二台螢幕。視窗裡按「截圖」一樣擷取 YouTube 分頁的畫面、點時間戳一樣讓 YouTube 跳轉；按「收回」回到右側。

**白板操作（三處相同）**
- 卡片種類：筆記（Markdown、`#標籤`、`[[連結]]`、`[mm:ss]`）、截圖、圖片、Board、待辦（可直接勾選）、連結（YouTube 連結會顯示縮圖）。
- 介面文字為英文（Milanote 風格）。左側工具除了點擊，也可以**直接拖曳到畫布上**，卡片會建立在放開的位置。
- **自由調整卡片大小**：拖右下角可同時改寬和高，筆記、留言、表格、文件、欄等可以事先拉出比內容更大的空間（縮到比內容小時會貼齊內容）；圖片、影片、地圖、草圖維持原比例只調寬度。
- **Alt + 拖曳**卡片＝複製一份（欄會連同裡面的卡片一起複製；圖片與檔案會複製成獨立的檔案）。
- 右鍵選單有 **Lock Position**（鎖定位置後無法拖曳與調整大小，再按一次解鎖）。卡片不再顯示 ⋯ 按鈕，功能都在右鍵選單。
- **欄（Column）**：滑鼠移到欄上，右上角會出現「−」可摺疊（變成「+」展開）。欄的右鍵選單只保留 Lock Position、拉線、顏色。
- **欄（Column）**：標題置中、顯示卡片數；把卡片拖進欄就會整齊排成一直排，可在欄內上下調整順序、拖出來恢復自由擺放；拖欄的標題可整欄移動，雙擊標題改名。
- **連線（Line）**：工具列「連線」後，從一張卡片拖到另一張卡片（也可以拉到空白處）。卡片移動時線會跟著走；選取後可拖端點重新連接，右鍵可改單向／雙向／無箭頭、反轉方向、改顏色、加文字（也可雙擊線）。
- **留言串（Comment）**：工具列「留言」新增一張留言卡，可以回覆、編輯、刪除，顯示 Google 帳號的名稱與頭像和時間；也能拖進欄裡。（選取文字也能直接加上文字留言。）
- **表格（Table）**：雙擊編輯儲存格（Tab 移到下一格），可加減列與欄；第一列是表頭。
- **草圖（Sketch）**：卡片裡的小畫布，雙擊開始畫，有顏色、粗細、橡皮擦。
- **繪圖（Draw）**：直接在白板上手繪，筆跡可選取、改色、刪除（Esc 結束）。
- **更多（⋯）**：標題（大字、沒有卡片背景）、影片（YouTube／Vimeo 嵌入或上傳影片檔，點一下在卡片裡播放）、地圖（輸入地點，點一下載入 Google 地圖）、音訊（上傳後在卡片裡播放）、文件（卡片顯示摘要，雙擊開啟全螢幕編輯）。
- **上傳**：任何檔案（PDF、音訊、影片…，單檔 25 MB 以內）都能拖進白板或用「上傳」，會同步到 Drive，雙擊下載。
- **色票（Color）**：顏色卡片，雙擊可用調色盤或輸入 `#RRGGBB` 修改並命名，點色碼即可複製。
- **移動畫布**：滾輪、按住**滑鼠中鍵**拖曳，或按住空白鍵拖曳；`Ctrl + 滾輪` 縮放。**左鍵在空白處拖曳＝框選**（Shift 加選）。雙擊空白處新增筆記；雙擊卡片編輯；拖右下角改寬度。
- **把卡片拖到 Board 卡上 → 移進那個 Board**；右鍵或 `⋯` 選單也能「移到 Board…／移到上一層」、改顏色、刪除。
- `Delete` 刪除、`Ctrl + F` 搜尋所有 Board、可直接貼上或拖入圖片與網址。
- 麵包屑顯示目前位置（首頁 › DaVinci 調色 › 節點技巧），雙擊目前的名稱可改名。
- **所見即所得的文字編輯**：雙擊卡片直接在原地編輯；選取文字會浮出格式列——粗體、斜體、刪除線、底線、項目清單、編號清單、置中、行內程式碼、超連結、留言。行首輸入 `- `、`1. `、`[] ` 會自動變成清單／待辦。快捷鍵 `Ctrl+B / I / U`、`Ctrl+Shift+X`（刪除線）、`Ctrl+E`（程式碼）、`Ctrl+K`（連結）。
- **留言**：選取文字 → 留言，文字會以螢光標記，卡片角落顯示留言數，點標記可查看、編輯、刪除。
- **復原／重做**：`Ctrl+Z`、`Ctrl+Y`（移動、刪除、改色、編輯內容都可以復原）。
- **垃圾桶**：刪除的卡片保留 30 天，可以還原；清空後才會從 Drive 移除圖片。

**Lightbox / 畫布編輯器**（雙擊截圖開啟）
- 滾輪縮放、拖曳平移、`← →` 切換同一個 Board 的截圖。
- 裁切、畫筆、螢光筆、箭頭、矩形、圓形、文字；Undo / Redo / Clear All。原始截圖永遠保留，標註可隨時再編輯。

**知識庫網站**
- 全螢幕白板，左側工具列；點時間戳會在右下角開小播放器。
- 匯出目前 Board 為 `.md + 圖片` ZIP。

> 從 0.1 版升級：重新載入擴充功能後，舊的「影片 → 筆記」會自動依分類轉成 Board（例如「DaVinci 調色」），每部影片的筆記變成卡片；Drive 上舊的 `videos/` 檔案原樣保留當備份。

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

## 資料 Schema（v2）

Google Drive 結構（都在你雲端硬碟的 `YT-Vision-Notes/` 內）：

```
YT-Vision-Notes/
├── index.json                    每個 Board 的摘要（標題、顏色、上層、卡片數、updatedAt）
├── boards/{boardId}.json         一個 Board 的所有卡片（首頁的 id 是 home）
├── images/{imageId}.webp         原始截圖（不會被覆寫）
├── images/{imageId}.edit.webp    套用裁切/標註後的成品
└── videos/ , images/{videoId}/   0.1 版的舊資料（只讀、當備份）
```

### `boards/{boardId}.json`
```jsonc
{
  "schemaVersion": 2,
  "id": "b_xxx", "title": "節點技巧", "color": "#3e63dd", "parentId": "home",
  "createdAt": 0, "updatedAt": 0, "metaUpdatedAt": 0, "deleted": false,
  "items": [
    { "id": "i_1", "type": "board", "boardId": "b_child", "x": 40, "y": 40, "w": 120 },
    { "id": "i_2", "type": "note", "text": "Markdown…", "video": { "id": "dQw4w9WgXcQ", "title": "…" },  // video = 總結筆記
      "x": 200, "y": 40, "w": 260, "color": "#f5a524" },
    { "id": "i_3", "type": "shot", "ts": 312, "text": "說明", "video": { "id": "…", "title": "…" },
      "x": 480, "y": 40, "w": 240,
      "image": { "id": "img_x", "w": 1920, "h": 1080, "fileId": "…", "editedFileId": "…", "editedAt": 0,
                 "edits": { "crop": { "x": 0, "y": 0, "w": 800, "h": 450 }, "shapes": [ … ] } } },
    { "id": "i_4", "type": "image", "image": { … } },
    { "id": "i_5", "type": "link", "url": "https://…", "title": "…" },
    { "id": "i_6", "type": "column", "title": "步驟", "x": 0, "y": 0, "w": 300 },
    { "id": "i_7", "type": "note", "col": "i_6", "ord": 0, "text": "…" },                // col = 放在哪個欄、ord = 欄內順序
    { "id": "i_8", "type": "line", "from": { "id": "i_2", "x": 0, "y": 0 }, "to": { "x": 600, "y": 200 },
      "arrow": "end", "label": "因為", "color": null },                                    // 端點黏在卡片 (id) 或空白處 (x,y)
    { "id": "i_9", "type": "color", "hex": "#1e90ff", "name": "天空藍", "w": 160 }
    // 每張卡片都有 createdAt / updatedAt / deleted
  ]
}
```

### 同步方式（Delta Sync）
- 兩端各有自己的 IndexedDB，畫面永遠先讀本機 → 秒開、可離線。
- 同步時：讀 `index.json` → 只下載 `updatedAt` 改變的 Board → 以「卡片為單位、最後修改者勝」合併（刪除用墓碑標記）→ 只上傳有變動的 Board 與新圖片 → 更新 `index.json`。
- 圖片在要顯示時才從 Drive 下載並快取。
- 擴充功能：修改後約 4 秒同步一次，另外每 30 分鐘背景同步。網站：開啟時、修改後、切回分頁時同步。

---

## 已知限制
- **受 DRM 保護的影片**（部分電影、YouTube Premium 內容）瀏覽器不允許讀取畫面，會提示無法擷取。
- 網站的 Google 登入權杖有效約 1 小時，過期後按一下右上角「重新連線」即可（Google 對純前端網站的限制）；擴充功能端不受影響。
- 擴充功能使用 `chrome.identity`，需在 Google Chrome 使用（Edge/Brave 的行為不同）。
- 同一張卡片在兩台裝置上「同時」被修改時（例如一邊移動、一邊改文字），較晚的那次修改整張卡片勝出。
- 白板目前還沒有：表格（Table）、手繪（Draw）。
- YouTube 改版若更動 `.ytp-right-controls`、`#columns`、`#secondary` 或 `--ytd-watch-flexy-sidebar-width` 等，需調整 `extension/content.js` / `content.css`。
