"""Run the prompt cases from docs/PROMPT_TESTS.md against the real model.

    backend\\.venv\\Scripts\\python.exe backend\\run_prompt_cases.py          # all cases
    backend\\.venv\\Scripts\\python.exe backend\\run_prompt_cases.py S G1     # only S*, and G1

AI_PROVIDER and its key come from the shell or from backend/.env (the same file
`python backend/app.py` uses). Never commit the key.

Prints each case's expected and observed answer so they can be recorded in
docs/PROMPT_TESTS.md. Uses the same prompts and parsers as the app:
- S cases: task suggestions (SYSTEM_PROMPT), including messages that are not work to plan.
- G and W cases: TASK_ESTIMATE_PROMPT, where one call returns both the GPU part
  and the workload part.
"""
import sys
import time

from ai_suggest import OFF_TOPIC_REPLY, AiSuggester, SuggestionError
from app import sync_local_env

PAUSE_SECONDS = 5  # between calls, to stay under free-plan per-minute rate limits

# Suggestions (SYSTEM_PROMPT): (case id, user message, expect tasks?)
# True: 1-8 candidate tasks. False: no tasks, and the fixed OFF_TOPIC_REPLY.
SUGGEST_CASES = [
    ("S1", "how are you", False),
    ("S2", "你好", False),
    ("S3", "謝謝你的幫忙！", False),
    ("S4", "What's the weather in Hsinchu today?", False),
    ("S5", "What can you do?", False),
    ("S6", "更新資料集，再用新版資料訓練模型", True),
    ("S7", "train the model", True),
]

# GPU part: (case id, title, description, expected needed, expected GPU hours range or None)
GPU_CASES = [
    ("G1", "Fine-tune the driving policy on the new dataset", "Train for about 200k steps with LeRobot.", True, (4, 72)),
    ("G2", "Write the CP2 progress report", "Summarize what each member finished this week.", False, None),
    ("G3", "Collect 500 cup-stacking demos in Isaac Sim", "Run the simulator with randomized cup positions.", True, (2, 48)),
    ("G4", "Clean the raw CSV logs", "Remove empty rows and fix column names in a 2 MB file.", False, None),
    ("G5", "Evaluate checkpoints 10-20 in simulation", "Run 50 rollouts per checkpoint and record success rate.", True, (1, 24)),
    ("G6", "重新訓練模型", "用新版資料集訓練 policy，大約跑 20 個 epoch。", True, (2, 72)),
    ("G7", "整理會議紀錄", "把週會討論的重點整理成文件。", False, None),
]

# Workload part: (case id, title, description, work hours range, difficulty range)
WORK_CASES = [
    ("W1", "Fix a typo in the README", "One wrong word in the setup section.", (0.5, 2), (1, 2)),
    ("W2", "Implement a custom CUDA kernel for the attention layer",
     "Replace the PyTorch attention with a fused kernel and check it matches.", (8, 80), (4, 5)),
    ("W3", "Fine-tune the driving policy on the new dataset", "Train for about 200k steps with LeRobot.", (1, 24), (2, 4)),
    ("W4", "Write the CP2 progress report", "Summarize what each member finished this week.", (1, 8), (1, 2)),
    ("W5", "Label 2,000 images by hand", "Draw a box around the cup in every image.", (10, 100), (1, 2)),
    ("W6", "設計新的 reward function", "讓機械手臂學會疊杯子，並驗證新的 reward 比舊的好。", (8, 80), (4, 5)),
]


def check_gpu(expected_needed, hours_range, est):
    if est is None:
        return "ERROR (no usable GPU part)"
    if est["needed"] != expected_needed:
        return "MISMATCH (needed)"
    if hours_range and est["hours"] is not None and not hours_range[0] <= est["hours"] <= hours_range[1]:
        return "CHECK (hours outside the expected range)"
    return "OK"


def check_work(hours_range, difficulty_range, est):
    if est is None:
        return "ERROR (no usable work part)"
    if est["difficulty"] is None or not difficulty_range[0] <= est["difficulty"] <= difficulty_range[1]:
        return "MISMATCH (difficulty)"
    if est["hours"] is None or not hours_range[0] <= est["hours"] <= hours_range[1]:
        return "CHECK (work hours outside the expected range)"
    return "OK"


def run_suggest(suggester, cid, message, want_tasks):
    expected = "1-8 tasks" if want_tasks else "no tasks, the fixed reply"
    try:
        result = suggester.suggest(message, [])
        tasks = result["tasks"]
        if tasks:
            lines = [f"{t['id']} {t['title']} <- {t['prerequisites']}" for t in tasks]
            observed = f"{len(tasks)} tasks: " + "; ".join(lines)
        else:
            fixed = result["reply"] == OFF_TOPIC_REPLY
            observed = "no tasks, the fixed reply" if fixed else f"no tasks, unexpected reply: {result['reply']!r}"
        verdict = "OK" if bool(tasks) == want_tasks else "MISMATCH"
    except SuggestionError as e:
        observed, verdict = f"error: {e.message}", "ERROR"
    print(f"{cid} {message}\n  expected: {expected}\n  observed: {observed}\n  -> {verdict}\n")


def run_estimate(suggester, cid, title, desc, expected, judge):
    try:
        est = suggester.estimate_task(title, desc)
        observed = f"gpu={est['gpu']}\n            work={est['work']}"
        verdict = judge(est)
    except SuggestionError as e:
        observed, verdict = f"error: {e.message}", "ERROR"
    print(f"{cid} {title}\n  expected: {expected}\n  observed: {observed}\n  -> {verdict}\n")


def main(selected):
    sync_local_env()  # read AI_PROVIDER and the key from backend/.env if the shell has none
    suggester = AiSuggester()
    if not suggester.configured():
        sys.exit("No API key for the selected provider. Set AI_PROVIDER and its key first.")
    print(f"Provider: {suggester.provider_name} · Model: {suggester.model}\n")

    def wanted(cid):
        return not selected or any(cid == s or cid.startswith(s) for s in selected)

    for cid, message, want_tasks in SUGGEST_CASES:
        if wanted(cid):
            run_suggest(suggester, cid, message, want_tasks)
            time.sleep(PAUSE_SECONDS)
    for cid, title, desc, needed, hours in GPU_CASES:
        if wanted(cid):
            expected = f"gpu needed={needed}" + (f", hours {hours[0]}-{hours[1]}" if hours else "")
            run_estimate(suggester, cid, title, desc, expected,
                         lambda est, needed=needed, hours=hours: check_gpu(needed, hours, est["gpu"]))
            time.sleep(PAUSE_SECONDS)
    for cid, title, desc, hours, stars in WORK_CASES:
        if wanted(cid):
            expected = f"work hours {hours[0]}-{hours[1]}, difficulty {stars[0]}-{stars[1]}"
            run_estimate(suggester, cid, title, desc, expected,
                         lambda est, hours=hours, stars=stars: check_work(hours, stars, est["work"]))
            time.sleep(PAUSE_SECONDS)


if __name__ == "__main__":
    main(sys.argv[1:])
