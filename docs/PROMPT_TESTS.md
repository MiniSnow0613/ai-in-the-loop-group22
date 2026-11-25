# Prompt test suite

Cases for the prompts in [`backend/ai_suggest.py`](../backend/ai_suggest.py). Parsing and validation are covered by the automated tests (`backend/test_ai.py`, `backend/test_gpu_estimate.py`, `backend/test_workload.py`, which use a fake model). This file records how the **real model** answers, as CLAUDE.md asks for prompt changes.

## How to run

Set the provider and key in the shell (see `docs/CP2_DEMO.md` section 4), or have them saved in `backend/.env`, then run:

```powershell
.\backend\.venv\Scripts\python.exe backend\run_prompt_cases.py
```

Add case ids or prefixes to run only some cases, for example `run_prompt_cases.py S` or `run_prompt_cases.py S6 G1`. The script waits a few seconds between calls; Groq's free plan still rate-limits a full run, so a case may need to be re-run. The script prints the expected and observed answer for every case. Copy the observed answers into the tables below, with the date and model. Re-run the affected cases after changing a prompt.

## Messages that are not work to plan (`SYSTEM_PROMPT`)

Added because the assistant used to invent tasks for any message, even "how are you". For greetings, thanks and unrelated questions the model now answers `{"tasks": []}`, and the backend shows the fixed English introduction `OFF_TOPIC_REPLY` (in `backend/ai_suggest.py`) instead of a task preview. The model never writes this text, so it is the same every time, whatever language the message is in. A case passes when tasks are returned exactly when expected.

| Case | User message | Expected | Observed | Date · model |
|---|---|---|---|---|
| S1 | how are you | no tasks, the fixed reply | no tasks, the fixed reply | 2026-11-25 · Groq openai/gpt-oss-20b |
| S2 | 你好 | no tasks, the fixed reply | no tasks, the fixed reply | 2026-11-25 · Groq openai/gpt-oss-20b |
| S3 | 謝謝你的幫忙！ | no tasks, the fixed reply | no tasks, the fixed reply | 2026-11-25 · Groq openai/gpt-oss-20b |
| S4 | What's the weather in Hsinchu today? | no tasks, the fixed reply | no tasks, the fixed reply | 2026-11-25 · Groq openai/gpt-oss-20b |
| S5 | What can you do? | no tasks, the fixed reply | no tasks, the fixed reply | 2026-11-25 · Groq openai/gpt-oss-20b |
| S6 | 更新資料集，再用新版資料訓練模型 | tasks in Chinese; training depends on the dataset task | 2 tasks: 更新資料集 → 用新版資料訓練模型 | 2026-11-25 · Groq openai/gpt-oss-20b |
| S7 | train the model | tasks (short but concrete work) | 4 tasks: Prepare dataset, Design model architecture → Train model → Evaluate model | 2026-11-25 · Groq openai/gpt-oss-20b |

History:
- First version: the model wrote its own reply. With English examples in the prompt, S6 came back with English titles; a stronger language rule ("including its script… The English examples above never change the language") fixed it.
- Current version: the reply is fixed text from the backend, so the model only returns `{"tasks": []}`. In the first full run S6 and S7 each failed once with "not valid JSON"; three more runs of each, and the re-run above, all parsed and gave tasks. Watch for this if it happens again.
- After merging the workload branch (the prompt now also has `WORK_RULES` and a `work` part in shape 1): S1–S7 re-run on 2026-11-25 with Groq openai/gpt-oss-20b, all OK. S1–S5 got the fixed reply; S6 gave 2 Chinese tasks (更新資料集 → 用新版資料訓練模型); S7 gave 5 tasks.

## GPU estimate (the `gpu` part of `TASK_ESTIMATE_PROMPT` and of `SYSTEM_PROMPT`)

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

## Workload estimate (the `work` part of `TASK_ESTIMATE_PROMPT` and of `SYSTEM_PROMPT`)

Added when tasks got estimated work hours and a 1–5 star difficulty. To keep repeated estimates close together, single-task estimates use temperature 0, the prompt asks for hours from the scale 1, 2, 4, 8, 16, 32, 64, 128 with reference examples, and AI hours are snapped to that scale in `normalize_work`. The same call also returns the GPU part. A case passes when the difficulty falls in the expected range and the work hours are plausible. The pairs W1/W2 and W4/W5 check that difficulty is independent of hours (a long but easy task, a short but hard one), and W3 checks that waiting for a training run is not counted as human work.

| Case | Task (title · description) | Expected | Observed | Date · model |
|---|---|---|---|---|
| W1 | Fix a typo in the README · One wrong word in the setup section. | 0.5–2 h, ★1–2 | Not run yet | |
| W2 | Implement a custom CUDA kernel for the attention layer · Replace the PyTorch attention with a fused kernel and check it matches. | 8–80 h, ★4–5 | Not run yet | |
| W3 | Fine-tune the driving policy on the new dataset · Train for about 200k steps with LeRobot. | 1–24 h of work (not the GPU time), ★2–4 | Not run yet | |
| W4 | Write the CP2 progress report · Summarize what each member finished this week. | 1–8 h, ★1–2 | Not run yet | |
| W5 | Label 2,000 images by hand · Draw a box around the cup in every image. | 10–100 h, ★1–2 | Not run yet | |
| W6 | 設計新的 reward function · 讓機械手臂學會疊杯子，並驗證新的 reward 比舊的好。 | 8–80 h, ★4–5; reason in Chinese | Not run yet | |

To check that estimates are steady, run the script twice and compare: the same case should land on the same or a neighbouring step of the scale (for example 8 and 16, not 4 and 64).
