# Decisions Log

## 2026-09-21 — Initial code steward
**What:** YinXuan1223 is the initial code steward for the team.
**Why:** Just a coincidence.

## 2026-09-21 — Modify md files structure.
**What:** Modify md files structure. Only PULL_REQUEST_TEMPLATE.md will be kept in /.github. Others are moved to /docs
**Why:** Only files recognized by GitHub automatically should be placed in /.github. Other documentations for team member to read, discuss, track can be stored in /docs. 

## 2026-11-15 — Timeline organized by dependency level
**What:** Organize the Timeline by dependency level. Place tasks with prerequisites one level after their latest prerequisite.
**Why:** Aligning levels across teammates’ columns makes it easier to see which tasks must happen in order and which can proceed in parallel.

## 2026-11-16 — Preview AI task suggestions before adding them
**What:** Show a preview of AI-generated tasks and their dependencies. Validate and save them only after a user selects "Add to Task Pool".
**Why:** Teammates can check the suggested tasks and their prerequisites before they appear on the shared board.

## 2026-11-21 — Transfer code steward
**What:** Handed over the code steward role from YinXuan1223 to GalahadJr-1214.
**Why:** Routine role rotation / workload balancing.

## 2026-11-23 — Date-based Timeline (replaces the 2026-11-15 dependency-level layout)
**What:** The Timeline shows members as columns and calendar dates as rows (7 days, Monday first, with previous/next week). Tasks have nullable `planned_start` / `planned_end` (inclusive) and `work_hours`. A task is on the Timeline only when both dates are set; every unscheduled task, assigned or not, stays in the Task Pool. Dropping a card on a member and day assigns and schedules it in one request (a new card covers one day; a moved card keeps its length); dropping it on the Task Pool clears only its dates. The backend checks every schedule change before saving (`backend/schedule.py`): a task must start after the planned end of each unfinished prerequisite, which also covers prerequisite edits and moving a prerequisite later. Unscheduled prerequisites and overlapping tasks for one member are warnings. Other tasks are never rescheduled automatically.
**Why:** Dependency levels showed order but not when work happens or who is overloaded. Dates make conflicts visible while still letting people decide how to fix them.
**Also:** Dependency levels (`row`) are still computed for a future dependency graph view but no longer position cards. Human work hours are separate from GPU hours and never decide the dates; planned dates do not create or change GPU bookings.
