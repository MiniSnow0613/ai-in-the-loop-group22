# CP2 Demo 操作指南

這份指南適用於 Windows PowerShell。Demo 看板有 4 位成員和 13 張任務卡，可以試用拖曳分工和多個前置任務的解鎖流程。

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

1. 在 Task Pool 的「等待前置」找到「整合 Chatbot 到 Task Pool」。初始畫面有 4 張卡在 Task Pool，整合卡應顯示「等待 2 項前置任務」。
2. 點開成員 B 的「完成任務新增 API」並標為完成。整合卡應改成只等待成員 C。
3. 點開成員 C 的「完成 AI 任務建議串接」並標為完成。整合卡應變成「可開始」，即使成員 D 的 GPU 任務仍未完成。
4. 把整合卡拖給任一位成員。它應出現在第 3 層，重新整理後保留負責人和位置。

可在同一台電腦用 Chrome 和 Edge 開啟同一個 5001 網址。一邊完成前置任務，另一邊約 5 秒後會讀取最新狀態，也可按 F5 確認。Chatbot 在這版是介面預覽，GPU 相關卡片是展示資料。

## 4. 重設 Demo

要回到初始狀態時，另開 PowerShell，回到專案根目錄執行下列指令，再到 5001 按 F5。這會清除本次 Demo 的分工和進度。

```powershell
.\backend\.venv\Scripts\python.exe backend\seed_demo.py
```

如果更新了前端程式，請在 `frontend` 重新執行 `npm run build`。如果更新了後端程式，請重啟 Flask。
