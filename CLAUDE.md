# Group 22 CP2 — Project Instructions

## Project overview

This project is a shared task board built with React, Flask, and SQLite.
Teammates can schedule tasks by dragging them onto a member and a date, track
prerequisites, and review AI-generated task suggestions before adding them to
the Task Pool.

## Rules for code changes

- The Timeline is date-based: members are columns and the 7 days of a week (Monday first) are rows. A task is on the Timeline only when both `planned_start` and `planned_end` are set (`YYYY-MM-DD`, end inclusive); otherwise it is in the Task Pool, even if it has an assignee.
- Validate every schedule change on the backend with [`backend/schedule.py`](backend/schedule.py) before saving, including dependency edits and upstream date changes. A task must start after (not on) the planned end of each unfinished prerequisite. Unscheduled prerequisites and overlapping tasks for one member are warnings, not errors. Never reschedule other tasks automatically; report the conflict instead.
- Keep the dependency-level calculation (`compute_rows`, the `row` field) for a future dependency graph view, but do not use it to place Timeline cards.
- Keep estimated human work hours (`work_hours`) separate from GPU hours (`gpu_hours`). Work hours never decide the planned dates, and planned dates never create or move GPU bookings.
- Keep AI suggestions in preview until the user selects **Add to Task Pool**. Before saving, validate that prerequisite IDs exist and that the proposed dependencies contain no cycles.
- Keep provider API keys in backend environment variables. Do not expose keys in frontend code, API responses, logs, or committed files.

## AI Assistant prompt

The prompt sent to the model is `SYSTEM_PROMPT` in [`backend/ai_suggest.py`](backend/ai_suggest.py). The function `build_messages()` adds the user's work description and existing board task context.

The prompt requests JSON with 1–8 candidate tasks. Each task has an `id`, `title`, `description`, and `prerequisites`. Prerequisite IDs must refer to another candidate or an existing board task. Titles and descriptions should use the same language as the user's work description.

When the message is not work to plan (a greeting, thanks, an unrelated question), the model returns `{"tasks": []}` instead of inventing tasks. `/api/suggestions` then returns the fixed English text `OFF_TOPIC_REPLY` as `reply`, and the AI Assistant shows it as a chat message with no preview. Keep this text fixed, and update it when the tool's features change.

## Verification

- For backend changes, run `python -m pytest backend` from the repo root with the backend environment active.
- For frontend changes, run `npm run build` from `frontend/`.
- For prompt changes, record the input, expected behavior, and observed output in the prompt test suite. Re-run the affected cases after a fix.