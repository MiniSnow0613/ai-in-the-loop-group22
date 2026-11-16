# CP2 Demo 操作指南

這份指南適用於 Windows PowerShell。Demo 看板有 4 位成員和 13 張任務卡，可以試用拖曳分工和多個前置任務的解鎖流程。設定 API key 後，右側的 AI Assistant 也能依工作描述產生候選任務（見第 4 節）。

## 1. 首次安裝

先切到專案根目錄，也就是同時看得到 `backend` 和 `frontend` 的資料夾。依目前 README，請準備 Python 3.11 以上及 Node.js（含 npm）。若 npm 提示 Node 版本不符，請依該版本的 Vite 要求更新 Node.js。

```powershell
Set-Location backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Set-Location ..\frontend
npm install
npm run build
Set-Location ..
```

## 2. 啟動 Demo

第一次執行時，在專案根目錄建立 Demo 資料。

```powershell
.\backend\.venv\Scripts\python.exe backend\seed_demo.py
```

在同一個 PowerShell 啟動伺服器。之後要繼續上次進度時，可以直接從這裡開始。

```powershell
$env:BOARD_DB_PATH = "backend\data\board_demo.db"
$env:PORT = "5001"
.\backend\.venv\Scripts\python.exe backend\app.py
```

看到伺服器開始執行後，開啟 [http://localhost:5001](http://localhost:5001)。保持 PowerShell 開著，試用結束後按 Ctrl+C。5001 使用獨立的 Demo 資料庫 `backend/data/board_demo.db`。如果要開 5000 的主看板，請使用未設定上述環境變數的 PowerShell。

## 3. 試用多前置任務

介面和 Demo 任務名稱為英文。如果看到的任務名稱仍是中文，表示 Demo 資料庫是在介面改成英文前建立的，先依第 5 節重設即可。

1. 在 Task Pool 的 `Waiting for prerequisites` 找到 `Integrate Chatbot into Task Pool`。初始畫面有 4 張卡在 Task Pool，整合卡應顯示 `Waiting for 2 prerequisites`。
2. 點開 Member B 的 `Build task creation API`，按 Mark as completed。整合卡應改成只等待 Member C，顯示 `Waiting for Member C: Connect AI task suggestions`。
3. 點開 Member C 的 `Connect AI task suggestions`，按 Mark as completed。整合卡應移到 `Ready`，即使 Member D 的 `Implement GPU time-slot overlap check` 仍未完成。
4. 把整合卡拖給任一位成員。它應出現在 `Dependency level` 第 3 層，重新整理後保留負責人和位置。

可在同一台電腦用 Chrome 和 Edge 開啟同一個 5001 網址。一邊完成前置任務，另一邊約 5 秒後會讀取最新狀態，也可按 F5 確認。GPU 相關卡片是展示資料。右側的 AI Assistant 需要設定 API key 才能產生候選任務（見第 4 節）；沒有設定 key 時，Timeline 和 Task Pool 等一般看板功能仍可正常使用。

## 4. 使用 AI Assistant 產生候選任務

在右側 AI Assistant 描述接下來的工作，Flask 會呼叫 AI 產生候選任務，並先顯示預覽。按下 Add to Task Pool 後，任務和前置關係才會寫入資料庫。

API key 只在啟動 Flask 的 PowerShell 視窗中設定，由後端讀取，不會傳到瀏覽器。請不要把 key 寫進程式碼或文件，也不要提交到 Git。

### 4.1 申請 Groq API key

登入 [Groq Console 的 API Keys 頁面](https://console.groq.com/keys)，建立一組新的 key 並複製下來。Groq 的 key 通常以 `gsk_` 開頭。

### 4.2 用 Groq 啟動 Demo

如果 Flask 已在執行，先到那個 PowerShell 視窗按 Ctrl+C 停止。尚未建立 Demo 資料時，先完成第 2 節的 `seed_demo.py`。

在專案根目錄執行下列指令。第一行會提示輸入 key，輸入時畫面不會顯示內容，貼上後按 Enter。

```powershell
$secureKey = Read-Host "Groq API key" -AsSecureString
$env:GROQ_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
Remove-Variable secureKey
$env:AI_PROVIDER = "groq"
$env:BOARD_DB_PATH = "backend\data\board_demo.db"
$env:PORT = "5001"
.\backend\.venv\Scripts\python.exe backend\app.py
```

模型固定為已實測的 `openai/gpt-oss-20b`，不需要另外設定。這些環境變數只在這個 PowerShell 視窗有效，關閉視窗後要重新輸入。之後要在同一個視窗重新啟動時，按 Ctrl+C 後只需再執行最後一行。

### 4.3 試跑範例

1. 開啟 [http://localhost:5001](http://localhost:5001)。確認右側 AI Assistant 右上角顯示 `Groq · openai/gpt-oss-20b`，說明區顯示 `Provider: Groq · Model: openai/gpt-oss-20b`。如果顯示 `API key missing`，請看 4.5。
2. 在 AI Assistant 下方的輸入框輸入「更新資料集，再用新版資料訓練模型」，按 Enter 或 Send。等待幾秒，畫面會顯示正在詢問 Groq。
3. 檢查預覽。上方會顯示 `N candidate tasks` 和 `From Groq · openai/gpt-oss-20b`，每張卡片有暫時編號（T1、T2…）。
   - `Depends on`：這張卡的前置任務。預期「訓練模型」的卡片會依賴「更新資料集」的卡片。
   - `Unlocks`：這張卡完成後可以開始的任務。
   - `On board: 任務名稱`：候選任務依賴看板上原有的任務。
   - 模型每次的輸出可能不同，卡片張數和標題不一定一樣，但前置關係應合理。
   - 這時看板上還沒有新增任何卡片。
4. 按 Add to Task Pool。預覽下方會顯示 `Added to the Task Pool.`，新卡片出現在左下的 Task Pool，第一張會短暫標示。沒有前置任務的卡片在 `Ready`，有前置任務的在 `Waiting for prerequisites`。
5. 把新卡片拖到任一成員欄位，卡片會依前置關係放在對應的相依層級。
6. 按 F5 重新整理，確認新卡片、負責人和前置關係都還在。也可以點開卡片，在 `Prerequisites` 區塊確認前置任務。

如果預覽中出現 `Dependency problems`，表示這批候選任務有不存在的前置任務或循環相依。這時按 Add to Task Pool 會被拒絕，看板不會改變。可以按 Discard，再換個方式描述工作重新送出。

### 4.4 改用 OpenRouter（替代設定）

程式也支援 OpenRouter，目前使用的模型是 `openrouter/free`。這個模型由 OpenRouter 自動分配到可用的免費模型，回應速度和品質可能不穩定。key 請到 [OpenRouter 網站](https://openrouter.ai) 登入後建立。

把 4.2 指令中設定 Groq key 和 `AI_PROVIDER` 的部分換成下列內容，其餘的 `BOARD_DB_PATH`、`PORT` 和啟動指令不變：

```powershell
$secureKey = Read-Host "OpenRouter API key" -AsSecureString
$env:OPENROUTER_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
Remove-Variable secureKey
$env:AI_PROVIDER = "openrouter"
```

啟動後右上角應顯示 `OpenRouter · openrouter/free`，操作步驟和 4.3 相同。沒有設定 `AI_PROVIDER` 時，預設也是 OpenRouter。在同一個視窗切換供應商後，要按 Ctrl+C 重新啟動 Flask 才會生效。

### 4.5 常見狀況

- **`API key missing`**：Flask 讀不到目前供應商的 key。訊息會寫出要設定的變數，Groq 是 `GROQ_API_KEY`，OpenRouter 是 `OPENROUTER_API_KEY`。請確認 key 和 `AI_PROVIDER` 都是在啟動 Flask 的同一個視窗設定，按 Ctrl+C 後重新啟動。這時一般看板仍可正常使用。
- **`429`（畫面顯示 `Rate limited`）**：短時間內送出太多請求，超過免費方案的次數限制。依訊息中的秒數稍候再按 Send；若沒有顯示秒數，約等一分鐘再試。看板上的資料不受影響。

## 5. 重設 Demo

要回到初始狀態時，另開 PowerShell，回到專案根目錄執行下列指令，再到 5001 按 F5。這會清除本次 Demo 的分工和進度，也會清除試跑時用 AI Assistant 加入的任務。

```powershell
.\backend\.venv\Scripts\python.exe backend\seed_demo.py
```

如果更新了前端程式，請在 `frontend` 重新執行 `npm run build`。如果更新了後端程式，請重啟 Flask。
