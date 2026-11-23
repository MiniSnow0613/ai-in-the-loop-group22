# Prompt test suite

Cases for the prompts in [`backend/ai_suggest.py`](../backend/ai_suggest.py). Parsing and validation are covered by the automated tests (`backend/test_ai.py`, `backend/test_gpu_estimate.py`, which use a fake model). This file records how the **real model** answers, as CLAUDE.md asks for prompt changes.

## How to run

In the window that starts Flask, set the provider and key (see `docs/CP2_DEMO.md` section 4), then run:

```powershell
.\backend\.venv\Scripts\python.exe backend\run_prompt_cases.py
```

The script prints the expected and observed answer for every case. Copy the observed answers into the table below, with the date and model. Re-run the affected cases after changing a prompt.

## GPU estimate (`GPU_ESTIMATE_PROMPT`, and the `gpu` field of `SYSTEM_PROMPT`)

Added when the board started asking the AI whether a task needs a GPU and for how long. The hours are rough: a case passes when "needed" matches and the hours fall inside a wide, plausible range.

| Case | Task (title · description) | Expected | Observed | Date · model |
|---|---|---|---|---|
| G1 | Fine-tune the driving policy on the new dataset · Train for about 200k steps with LeRobot. | needed, 4–72 h | Not run yet | |
| G2 | Write the CP2 progress report · Summarize what each member finished this week. | not needed | Not run yet | |
| G3 | Collect 500 cup-stacking demos in Isaac Sim · Run the simulator with randomized cup positions. | needed, 2–48 h | Not run yet | |
| G4 | Clean the raw CSV logs · Remove empty rows and fix column names in a 2 MB file. | not needed | Not run yet | |
| G5 | Evaluate checkpoints 10-20 in simulation · Run 50 rollouts per checkpoint and record success rate. | needed, 1–24 h | Not run yet | |
| G6 | 重新訓練模型 · 用新版資料集訓練 policy，大約跑 20 個 epoch。 | needed, 2–72 h; reason in Chinese | Not run yet | |
| G7 | 整理會議紀錄 · 把週會討論的重點整理成文件。 | not needed; reason in Chinese | Not run yet | |

Also check by hand in the AI Assistant: send 「更新資料集，再用新版資料訓練模型」. Expected: the training task is marked as needing a GPU with an hour estimate; the dataset task is usually not, unless its description mentions simulation or GPU work.
