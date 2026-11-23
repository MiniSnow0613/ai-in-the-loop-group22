# CP2 Demo 操作指南

這份指南適用於 Windows PowerShell。Demo 看板有 4 位成員和 13 張任務卡，可以試用拖曳分工、多個前置任務的解鎖流程，以及 GPU 預約（見第 5 節）。設定 API key 後，右側的 AI Assistant 也能依工作描述產生候選任務（見第 4 節）。

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

### 區域網路連線

要讓組員從自己的電腦連進 Demo 時，主機改從 repo 根目錄用下列指令啟動 5001。Flask 會接受區網內其他裝置的連線。

```powershell
$env:BOARD_DB_PATH = "backend\data\board_demo.db"
.\backend\.venv\Scripts\python.exe -m flask --app backend\app.py run --host 0.0.0.0 --port 5001
```

1. 主機和組員接上同一個、可以互相連線的區網，例如同一個 Wi-Fi。
2. 主機在 PowerShell 執行 `ipconfig`，找到目前使用中網卡的 IPv4 位址。
3. 組員在瀏覽器開啟 `http://<主機IPv4>:5001`。

第一次啟動時若 Windows 防火牆詢問是否允許存取，請只允許私人網路。這個模式下，區網內的人都能修改看板，請只在信任的網路使用。

若要使用 AI Assistant，由主機在啟動 Flask 的同一個 PowerShell 先依第 4 節設定 key 和 `AI_PROVIDER`，再執行上面的啟動指令。

最後請組員移動一張卡，確認主機的畫面也看得到變更。

## 3. 試用多前置任務

介面和 Demo 任務名稱為英文。如果看到的任務名稱仍是中文，表示 Demo 資料庫是在介面改成英文前建立的，先依第 6 節重設即可。

1. 在 Task Pool 的 `Waiting for prerequisites` 找到 `Integrate Chatbot into Task Pool`。初始畫面有 4 張卡在 Task Pool，整合卡應顯示 `Waiting for 2 prerequisites`。
2. 點開 Member B 的 `Build task creation API`，按 Mark as completed。整合卡應改成只等待 Member C，顯示 `Waiting for Member C: Connect AI task suggestions`。
3. 點開 Member C 的 `Connect AI task suggestions`，按 Mark as completed。整合卡應移到 `Ready`，即使 Member D 的 `Implement GPU time-slot overlap check` 仍未完成。
4. 把整合卡拖給任一位成員。它應出現在 `Dependency level` 第 3 層，重新整理後保留負責人和位置。


可在同一台電腦用 Chrome 和 Edge 開啟同一個 5001 網址。一邊完成前置任務，另一邊約 5 秒後會讀取最新狀態，也可按 F5 確認。GPU 相關卡片是展示資料，第 5 節會用它們試用 GPU 預約。

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

1. 開啟 [http://localhost:5001](http://localhost:5001)，確認右側 AI Assistant 顯示 `Groq · openai/gpt-oss-20b`。
2. 在輸入框輸入「更新資料集，再用新版資料訓練模型」，按 Enter 或 Send。
3. 檢查預覽中的前置關係。`Depends on` 列出每張卡的前置任務，預期「訓練模型」依賴「更新資料集」；依賴看板原有任務時會顯示 `On board: 任務名稱`。模型每次的輸出可能不同，但前置關係應合理。這時看板還沒有新增任何卡片。
4. 按 Add to Task Pool，新卡片會出現在 Task Pool。
5. 把新卡片拖到任一成員欄位，再按 F5，確認卡片、負責人和前置關係都還在。

如果預覽出現 `Dependency problems`，這批任務無法加入。可以按 Discard，換個方式描述工作再送出。

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

## 5. 試用 GPU 預約

上方的 `GPU schedule` 分頁是 GPU 時間表，每張 GPU 一列，顯示一天 00–24 點的預約。同一張 GPU 的預約時段不能重疊，任務卡底部的橘色色條會顯示這張卡的 GPU 預約。初始 Demo 有 `lab-server / GPU 0` 和 `lab-server / GPU 1` 兩張 GPU，沒有任何預約。如果只看到一張 `GPU 0`，表示 Demo 資料庫是在加入 GPU 功能前建立的，先依第 6 節重設即可。

1. 在 Tasks 分頁點開 Member D 的 `Implement GPU time-slot overlap check`，在最下方的 GPU 區塊按 Needs a GPU，Total GPU hours 輸入 4 後按 Save。卡片底部應出現 `Needs a GPU · 4h`。
2. 按 Schedule on GPU，畫面會切到 GPU schedule，時間軸上出現綠色虛線的 4 小時方格，New booking 也已填好最早的空檔。可以拖曳方格換時段或換到另一張 GPU，拖左右邊緣調整長度，表單會跟著更新。按 Book 後，方格變成橘色的預約，卡片底部的色條也會顯示 GPU 和時段。
3. 在同一列 GPU 上，點第一筆預約開始前一小時的空白處。新預約預設為 2 小時，會和第一筆重疊。Task 選 `Not a board task (other use)`，Used by 輸入「Lab shared job」。畫面應顯示紅色的 `Overlaps` 提示，按 Book 也會被拒絕。按 `Use earliest free slot` 改成最早可用的時段後，再按 Book 即可預約。
4. 回到 Tasks 分頁，點開 Task Pool 的 `Test and document GPU conflict cases`，依步驟 1、2 預約。因為它還在等 Member D 的卡，色條會是虛線並顯示 `can't start yet`。在時間軸點這筆預約並按 Start job，畫面應列出尚未完成的前置任務。
5. 把步驟 2 的預約拖到步驟 3 那筆預約的位置後放開。預約應彈回原位，並顯示和哪一筆重疊。拖到空的位置則會直接儲存。
6. 在時間軸點步驟 2 的預約，按 Start job，預約會變成深橘色的 `Running`。執行中的預約只能拖右邊延長或縮短，結束後按 Mark finished。

設定 API key 後，AI 也會估計任務需不需要 GPU、大約要幾小時。AI Assistant 的候選任務會附上 GPU 估計和紫色的 `AI estimate` 標籤，按 Edit 可以修改。用 + New task 手動新增的任務，會在背景自動請 AI 估計：卡片先顯示 `Estimating GPU need…`，幾秒後改成類似 `Needs a GPU · ~6h · AI estimate` 的內容。在任務的 GPU 區塊可以按 Confirm 採用、按 Edit hours 修改，或按 Ask AI again 重新估計。沒有設定 key 時不會自動估計，可以自己填時數。

右上方的 Manage GPUs 可以新增、改名、停用或刪除 GPU。還有預約的 GPU 只能停用，不能刪除。Detect GPUs on this machine 會在執行 Flask 的電腦上用 `nvidia-smi` 找出 GPU；沒有 NVIDIA GPU 時會顯示找不到 `nvidia-smi`，改用手動新增即可。

## 6. 重設 Demo

要回到初始狀態時，另開 PowerShell，回到專案根目錄執行下列指令，再到 5001 按 F5。這會清除本次 Demo 的分工、進度和 GPU 預約，GPU 也會回到初始的兩張，試跑時用 AI Assistant 加入的任務同樣會被清除。

```powershell
.\backend\.venv\Scripts\python.exe backend\seed_demo.py
```

如果更新了前端程式，請在 `frontend` 重新執行 `npm run build`。如果更新了後端程式，請重啟 Flask。
