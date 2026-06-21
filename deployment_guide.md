# GlowUp 健身 PWA - 部署與配置指南

本指南將引導您如何完成 Supabase 的後端資料庫配置、Storage 儲存庫建立，以及如何將本專案部署至 GitHub Pages，使其在手機上可安裝為離線優先（Offline-First）的 PWA 應用程式。

---

## 步驟 1：配置 Supabase 後端

1. **建立專案**：
   - 註冊並登入 [Supabase 官網](https://supabase.com/)。
   - 點擊 **New Project**，填寫專案名稱（例如：`GlowUp`）、設定密碼並選擇離您最近的伺服器節點，最後點擊建立。

2. **執行 SQL 結構設定**：
   - 在左側選單中，點擊 **SQL Editor** -> **New Query**。
   - 將本專案下的 [schema.sql](file:///e:/@project/gym-web/schema.sql) 檔案內容全部複製並貼上到 SQL 編輯器中。
   - 點擊右上角的 **Run** 按鈕執行。這將自動為您建立 `groups`、`profiles`、`master_workouts` 及 `student_active_logs` 資料表，並配置好 Row Level Security (RLS) 安全防護與 Trigger 觸發器。

3. **建立 Storage 影音媒體桶**：
   - 在左側選單中，點擊 **Storage**。
   - 點擊 **New Bucket**，並將儲存桶命名為 `exercise-videos`（此名稱需與您的影音上傳路徑呼應）。
   - **重要**：將此儲存桶的權限設定為 **Public**（公開），確保在地下室有網路預載時，App 能夠不需要複雜的登入 Token 就能直接下載影音。
   - 您可以將訓練所需的動畫影片（MP4）或圖片上傳至此儲存桶，並確保檔名與 `Exercise_ID` 一致（例如：`EX_SQUAT_01.mp4`）。

---

## 步驟 2：本地測試與連線驗證

1. **獲取 API 憑證**：
   - 在 Supabase 後端左下角點擊 **Project Settings** (齒輪圖示) -> **API**。
   - 複製 **Project URL** 以及 **anon/public API Key**。

2. **啟動本地伺服器**：
   - 因為 PWA 必須在安全上下文環境（`localhost` 或 `https://`）下才能註冊 Service Worker，建議使用 `npx` 啟動輕量網頁伺服器：
     ```bash
     npx serve
     ```
   - 在瀏覽器中打開主頁（通常是 `http://localhost:3000` 或 `http://localhost:5000`）。

3. **連接 Supabase**：
   - 在頁面底部點擊 **個人設定 (Settings)**。
   - 貼上您的 **Supabase URL** 與 **Anon Key**。
   - 填寫您的測試 Email、角色設定（Coach 或 Student），並任意填寫一個 Group ID（需與 schema.sql 內一致，或使用 demo 數據）。
   - 點擊 **儲存並重新載入**。
   - 您可以點擊 **載入體驗模擬數據**，App 會自動在 IndexedDB 內生成幾筆今天與昨天的訓練課表模板，您可以點擊「Claim Workout」進行測試。

---

## 步驟 3：部署至 GitHub Pages

由於 PWA 要求必須在 `https://` 安全協議下才能啟用，GitHub Pages 提供免費且自動升級的 HTTPS 網址，是部署本專案的完美選擇。

1. **建立 GitHub 儲存庫 (Repository)**：
   - 在您的 GitHub 上建立一個新的公開儲存庫，命名為 `glowup`。

2. **上傳程式碼**：
   - 在您的本地終端機（專案目錄下）執行：
     ```bash
     git init
     git add .
     git commit -m "feat: GlowUp PWA initial version"
     git branch -M main
     git remote add origin https://github.com/您的帳號/glowup.git
     git push -u origin main
     ```

3. **啟用 GitHub Pages**：
   - 進入您的 GitHub 儲存庫頁面。
   - 點擊 **Settings** (設定) -> 選擇左側選單的 **Pages**。
   - 在 **Build and deployment** 底下的 Source 選擇 **Deploy from a branch**。
   - Branch 選擇 `main`，路徑選擇 `/ (root)`，點擊 **Save**。
   - 等待大約 1-2 分鐘，GitHub 會為您生成一個專屬連結，例如：`https://您的帳號.github.io/glowup/`。

---

## 步驟 4：安裝至手機桌面體驗 (地下室實測)

1. **在有訊號處開啟網址**：
   - 用手機瀏覽器（iOS 建議使用 Safari，Android 使用 Chrome）打開您的 GitHub Pages 部署網址。
2. **安裝 PWA**：
   - **iOS (Safari)**：點擊瀏覽器底部的 **分享 (Share)** 按鈕 -> 選擇 **加入主畫面 (Add to Home Screen)**。
   - **Android (Chrome)**：點擊右上角選單 -> 選擇 **安裝應用程式 (Install App)**。
3. **預先下載動作 (上樓連線)**：
   - 在一樓（有網路時）點擊進入「今日訓練」分頁，點擊「Claim Workout」領取今日訓練。
   - 此時 App 會解析今日的所有動作 ID，並**自動預載**對應的影音教學到手機內部的 `Cache Storage` 裡。
4. **離線訓練 (下樓健身)**：
   - 帶著手機走入完全沒訊號的地下室健身房。
   - 打開桌面的 GlowUp 圖示，介面依然能完美加載，且您可以流暢地撥放剛才預先快取的動作教學影片！
   - 您可以自由填寫每組的重量、次數，並勾選完成。所有更改都會立即儲存在本地的 `IndexedDB` 中，並顯示為「⚡ 僅儲存於本地」。
5. **回歸連線批次同步 (上樓回家)**：
   - 健身完畢，回到一樓或回到家手機重新連上 Wi-Fi。
   - 網路狀態指示器會自動轉為「連線中」，同步引擎會瞬間在背景啟動，將您剛剛在地下室記錄的所有組數數據批次 upsert 上傳回 Supabase 雲端！教練與朋友此時便能看到您的今日训练進度！
