"""Run the task-estimate prompt cases from docs/PROMPT_TESTS.md against the real model.

    set AI_PROVIDER=groq
    set GROQ_API_KEY=...            (never commit the key)
    backend\\.venv\\Scripts\\python.exe backend\\run_prompt_cases.py

Prints each case's expected and observed answer so they can be recorded in
docs/PROMPT_TESTS.md. Uses the same prompt (TASK_ESTIMATE_PROMPT) and parser
as the app: one call returns both the GPU part and the workload part.
"""
import sys

from ai_suggest import AiSuggester, SuggestionError

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


def run(suggester, cid, title, desc, expected, judge):
    try:
        est = suggester.estimate_task(title, desc)
        observed = f"gpu={est['gpu']}\n            work={est['work']}"
        verdict = judge(est)
    except SuggestionError as e:
        observed, verdict = f"error: {e.message}", "ERROR"
    print(f"{cid} {title}\n  expected: {expected}\n  observed: {observed}\n  -> {verdict}\n")


def main():
    suggester = AiSuggester()
    if not suggester.configured():
        sys.exit("No API key for the selected provider. Set AI_PROVIDER and its key first.")
    print(f"Provider: {suggester.provider_name} · Model: {suggester.model}\n")
    for cid, title, desc, needed, hours in GPU_CASES:
        expected = f"gpu needed={needed}" + (f", hours {hours[0]}-{hours[1]}" if hours else "")
        run(suggester, cid, title, desc, expected, lambda est: check_gpu(needed, hours, est["gpu"]))
    for cid, title, desc, hours, stars in WORK_CASES:
        expected = f"work hours {hours[0]}-{hours[1]}, difficulty {stars[0]}-{stars[1]}"
        run(suggester, cid, title, desc, expected, lambda est: check_work(hours, stars, est["work"]))


if __name__ == "__main__":
    main()
