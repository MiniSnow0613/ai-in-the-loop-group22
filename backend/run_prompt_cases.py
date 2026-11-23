"""Run the GPU-estimate prompt cases from docs/PROMPT_TESTS.md against the real model.

    set AI_PROVIDER=groq
    set GROQ_API_KEY=...            (never commit the key)
    backend\\.venv\\Scripts\\python.exe backend\\run_prompt_cases.py

Prints each case's expected and observed answer so they can be recorded in
docs/PROMPT_TESTS.md. Uses the same prompt and parser as the app.
"""
import sys

from ai_suggest import AiSuggester, SuggestionError

# (case id, title, description, expected needed, expected hours range or None)
CASES = [
    ("G1", "Fine-tune the driving policy on the new dataset", "Train for about 200k steps with LeRobot.", True, (4, 72)),
    ("G2", "Write the CP2 progress report", "Summarize what each member finished this week.", False, None),
    ("G3", "Collect 500 cup-stacking demos in Isaac Sim", "Run the simulator with randomized cup positions.", True, (2, 48)),
    ("G4", "Clean the raw CSV logs", "Remove empty rows and fix column names in a 2 MB file.", False, None),
    ("G5", "Evaluate checkpoints 10-20 in simulation", "Run 50 rollouts per checkpoint and record success rate.", True, (1, 24)),
    ("G6", "重新訓練模型", "用新版資料集訓練 policy，大約跑 20 個 epoch。", True, (2, 72)),
    ("G7", "整理會議紀錄", "把週會討論的重點整理成文件。", False, None),
]


def check(expected_needed, hours_range, est):
    if est["needed"] != expected_needed:
        return "MISMATCH (needed)"
    if hours_range and est["hours"] is not None and not hours_range[0] <= est["hours"] <= hours_range[1]:
        return "CHECK (hours outside the expected range)"
    return "OK"


def main():
    suggester = AiSuggester()
    if not suggester.configured():
        sys.exit("No API key for the selected provider. Set AI_PROVIDER and its key first.")
    print(f"Provider: {suggester.provider_name} · Model: {suggester.model}\n")
    for cid, title, desc, needed, hours in CASES:
        expected = f"needed={needed}" + (f", hours {hours[0]}-{hours[1]}" if hours else "")
        try:
            est = suggester.estimate_gpu(title, desc)
            observed = f"needed={est['needed']}, hours={est['hours']}, reason={est['reason']!r}"
            verdict = check(needed, hours, est)
        except SuggestionError as e:
            observed, verdict = f"error: {e.message}", "ERROR"
        print(f"{cid} {title}\n  expected: {expected}\n  observed: {observed}\n  -> {verdict}\n")


if __name__ == "__main__":
    main()
