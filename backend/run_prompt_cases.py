"""Run the prompt cases from docs/PROMPT_TESTS.md against the real model.

    backend\\.venv\\Scripts\\python.exe backend\\run_prompt_cases.py          # all cases
    backend\\.venv\\Scripts\\python.exe backend\\run_prompt_cases.py S G1     # only S*, and G1

AI_PROVIDER and its key come from the shell or from backend/.env (the same file
`python backend/app.py` uses). Never commit the key.

Prints each case's expected and observed answer so they can be recorded in
docs/PROMPT_TESTS.md. Uses the same prompts and parsers as the app.
"""
import sys

from ai_suggest import OFF_TOPIC_REPLY, AiSuggester, SuggestionError
from app import sync_local_env

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

# GPU estimate: (case id, title, description, expected needed, expected hours range or None)
GPU_CASES = [
    ("G1", "Fine-tune the driving policy on the new dataset", "Train for about 200k steps with LeRobot.", True, (4, 72)),
    ("G2", "Write the CP2 progress report", "Summarize what each member finished this week.", False, None),
    ("G3", "Collect 500 cup-stacking demos in Isaac Sim", "Run the simulator with randomized cup positions.", True, (2, 48)),
    ("G4", "Clean the raw CSV logs", "Remove empty rows and fix column names in a 2 MB file.", False, None),
    ("G5", "Evaluate checkpoints 10-20 in simulation", "Run 50 rollouts per checkpoint and record success rate.", True, (1, 24)),
    ("G6", "重新訓練模型", "用新版資料集訓練 policy，大約跑 20 個 epoch。", True, (2, 72)),
    ("G7", "整理會議紀錄", "把週會討論的重點整理成文件。", False, None),
]


def check_gpu(expected_needed, hours_range, est):
    if est["needed"] != expected_needed:
        return "MISMATCH (needed)"
    if hours_range and est["hours"] is not None and not hours_range[0] <= est["hours"] <= hours_range[1]:
        return "CHECK (hours outside the expected range)"
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


def run_gpu(suggester, cid, title, desc, needed, hours):
    expected = f"needed={needed}" + (f", hours {hours[0]}-{hours[1]}" if hours else "")
    try:
        est = suggester.estimate_gpu(title, desc)
        observed = f"needed={est['needed']}, hours={est['hours']}, reason={est['reason']!r}"
        verdict = check_gpu(needed, hours, est)
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
    for cid, title, desc, needed, hours in GPU_CASES:
        if wanted(cid):
            run_gpu(suggester, cid, title, desc, needed, hours)


if __name__ == "__main__":
    main(sys.argv[1:])
