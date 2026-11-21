# Group 22 CP2 — Project Instructions

## Project overview

This project is a shared task board built with React, Flask, and SQLite.
Teammates can assign tasks by drag and drop, track prerequisites, and review
AI-generated task suggestions before adding them to the Task Pool.

## Rules for code changes

- Preserve the Timeline's dependency levels across assignee columns. A task with prerequisites belongs one level after its latest prerequisite.
- Keep AI suggestions in preview until the user selects **Add to Task Pool**. Before saving, validate that prerequisite IDs exist and that the proposed dependencies contain no cycles.
- Keep provider API keys in backend environment variables. Do not expose keys in frontend code, API responses, logs, or committed files.

## AI Assistant prompt

The prompt sent to the model is `SYSTEM_PROMPT` in [`backend/ai_suggest.py`](backend/ai_suggest.py). The function `build_messages()` adds the user's work description and existing board task context.

The prompt requests JSON with 1–8 candidate tasks. Each task has an `id`, `title`, `description`, and `prerequisites`. Prerequisite IDs must refer to another candidate or an existing board task. Titles and descriptions should use the same language as the user's work description.

## Verification

- For backend changes, run `python -m pytest backend` from the repo root with the backend environment active.
- For frontend changes, run `npm run build` from `frontend/`.
- For prompt changes, record the input, expected behavior, and observed output in the prompt test suite. Re-run the affected cases after a fix.