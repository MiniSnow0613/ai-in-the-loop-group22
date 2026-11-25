"""Build (or reset) the Group 22 demo board in backend/data/board_demo.db.

    python backend/seed_demo.py             # rebuild the demo database
    python backend/seed_demo.py --db PATH   # rebuild at another path

Every run restores the same starting point. Tables are dropped and recreated
inside the existing file, so a reset also works while the demo server is
running (refresh the page afterwards). The main board (data/board.db) is
never touched: the script refuses to write to it.

The cards are demo development tasks from building this coordination tool;
"Connect AI task suggestions" here is only a card on the board, not a real
integration.

Scenario: "Integrate Chatbot into Task Pool" starts in the Task Pool and needs
three independent prerequisites (A completed, B and C not yet), while D's GPU
work runs on its own chain.
"""
import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

import schedule
from app import DEFAULT_DB_PATH, SCHEMA, connect, now_iso

DEMO_DB_PATH = Path(__file__).resolve().parent / "data" / "board_demo.db"

MEMBERS = [
    ("member-a", "Member A"),
    ("member-b", "Member B"),
    ("member-c", "Member C"),
    ("member-d", "Member D"),
]

# id, title, assignee (None = Task Pool), status, prerequisite ids, description.
TASKS = [
    # A
    ("demo-shared-timeline", "Build shared Timeline", "member-a", "done", [],
     "Give all members one shared set of dependency levels and place cards by their prerequisites."),
    ("demo-pool-ui", "Build Task Pool UI", "member-a", "done", ["demo-shared-timeline"],
     "Show unassigned tasks in the Task Pool, grouped into Ready and Waiting for prerequisites."),
    ("demo-manual-edit", "Add manual task editing", "member-a", "todo", ["demo-pool-ui"],
     "Edit a task's name, description, and owner directly on the board."),
    # B
    ("demo-task-api", "Build shared task API", "member-b", "done", [],
     "Provide a shared API to read the board and update task owners and status."),
    ("demo-create-api", "Build task creation API", "member-b", "todo", ["demo-task-api"],
     "Add an endpoint that creates tasks, validates the fields, and saves them to SQLite."),
    # C
    ("demo-ai-format", "Define AI task output format", "member-c", "done", [],
     "Define the JSON fields the AI returns for each task: name, description, and prerequisites."),
    ("demo-ai-suggest", "Connect AI task suggestions", "member-c", "todo", ["demo-ai-format"],
     "Call the AI with the work a user describes in the Chatbot and return candidate tasks in the agreed format."),
    # D: GPU work, independent of the Chatbot integration
    ("demo-gpu-fields", "Design GPU booking fields", "member-d", "done", [],
     "Decide the fields a GPU booking needs: GPU ID, start and end time, and owner."),
    ("demo-gpu-overlap", "Implement GPU time-slot overlap check", "member-d", "todo", ["demo-gpu-fields"],
     "When booking, check whether the time slot overlaps an existing booking on the same GPU."),
    # Task Pool (unassigned)
    ("demo-integrate-chatbot", "Integrate Chatbot into Task Pool", None, "todo",
     ["demo-pool-ui", "demo-create-api", "demo-ai-suggest"],
     "Send the Chatbot's candidate tasks through the task creation API into the Task Pool, "
     "so users can drag them onto the Timeline."),
    ("demo-prereq-select", "Add prerequisite picker", None, "todo", ["demo-create-api"],
     "Let users pick prerequisites from a menu when creating or editing a task."),
    ("demo-prompt-tests", "Write 10 prompt test cases", None, "todo", ["demo-ai-suggest"],
     "Prepare 10 work descriptions and check whether the AI's candidate tasks make sense."),
    ("demo-gpu-conflict-tests", "Test and document GPU conflict cases", None, "todo", ["demo-gpu-overlap"],
     "Simulate overlapping bookings and boundary times, and record how the system handles them."),
]

# GPUs on the GPU schedule tab. No bookings: they depend on the date of the demo.
GPUS = [
    ("demo-gpu-0", "lab-server / GPU 0", 24),
    ("demo-gpu-1", "lab-server / GPU 1", 24),
]


# Planned dates on the Timeline, as (first day, last day) counted from Monday of
# the week the demo is built (0 = that Monday), plus estimated human work hours.
# Finished work is in the past; the four Task Pool cards have no dates.
PLAN = {
    "demo-shared-timeline": (-7, -5, 12),
    "demo-pool-ui": (-4, -2, 10),
    "demo-manual-edit": (1, 2, 8),
    "demo-task-api": (-6, -4, 10),
    "demo-create-api": (0, 2, 12),
    "demo-ai-format": (-5, -3, 6),
    "demo-ai-suggest": (0, 3, 16),
    "demo-gpu-fields": (-4, -3, 4),
    "demo-gpu-overlap": (1, 3, 10),
}


def planned_dates(today=None):
    """{task id: (planned_start, planned_end, work_hours)} for the week of `today`."""
    today = today or date.today()
    monday = today - timedelta(days=today.weekday())
    return {
        tid: ((monday + timedelta(days=a)).isoformat(), (monday + timedelta(days=b)).isoformat(), hours)
        for tid, (a, b, hours) in PLAN.items()
    }


def check_scenario(today=None):
    """Fail loudly if the seed data contradicts the board's own rules."""
    status = {t[0]: t[3] for t in TASKS}
    prereqs = {t[0]: t[4] for t in TASKS}
    for tid, deps in prereqs.items():
        unknown = [d for d in deps if d not in status]
        if unknown:
            raise ValueError(f"{tid} depends on unknown task(s): {unknown}")
        if status[tid] == "done" and any(status[d] != "done" for d in deps):
            raise ValueError(f"{tid} is done but has an unfinished prerequisite")
    plans = planned_dates(today)
    unknown = set(plans) - set(status)
    if unknown:
        raise ValueError(f"PLAN names unknown task(s): {sorted(unknown)}")
    board = {
        tid: {"id": tid, "title": title, "status": st, "assignee_id": who,
              "planned_start": plans.get(tid, (None,))[0], "planned_end": plans.get(tid, (None, None))[1],
              "prerequisites": deps}
        for tid, title, who, st, deps, _ in TASKS
    }
    errors = [i for issues in schedule.board_issues(board).values() for i in issues if i["severity"] == "error"]
    if errors:
        raise ValueError("Demo dates break the schedule rules: " + "; ".join(i["message"] for i in errors))


def build(db_path, today=None):
    db_path = Path(db_path).resolve()
    if db_path == DEFAULT_DB_PATH.resolve():
        sys.exit(f"Refusing to overwrite the main board database: {db_path}")
    check_scenario(today)
    plans = planned_dates(today)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = OFF")  # allow dropping in any order
        for table in ("gpu_bookings", "gpus", "task_dependencies", "tasks", "members", "meta"):
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA foreign_keys = ON")

        ts = now_iso()
        # Mark as seeded (so app.init_db() never adds the two example cards here)
        # and as already using task_dependencies (nothing legacy to migrate).
        conn.executemany(
            "INSERT INTO meta (key, value) VALUES (?, ?)",
            [("seeded", ts), ("dependencies_migrated", ts), ("demo", "group22-dev"), ("gpus_seeded", ts)],
        )
        conn.executemany(
            "INSERT INTO gpus (id, name, memory_gb, active, position) VALUES (?, ?, ?, 1, ?)",
            [(gid, name, mem, i) for i, (gid, name, mem) in enumerate(GPUS)],
        )
        conn.executemany(
            "INSERT INTO members (id, name, position) VALUES (?, ?, ?)",
            [(mid, name, i) for i, (mid, name) in enumerate(MEMBERS)],
        )
        conn.executemany(
            """INSERT INTO tasks
               (id, title, is_example, assignee_id, status, waiting_text,
                position, updated_at, description, summary,
                planned_start, planned_end, work_hours)
               VALUES (?, ?, 0, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)""",
            [
                (tid, title, assignee, status, position, ts, desc, *plans.get(tid, (None, None, None)))
                for position, (tid, title, assignee, status, _, desc) in enumerate(TASKS)
            ],
        )
        conn.executemany(
            "INSERT INTO task_dependencies (task_id, prerequisite_id) VALUES (?, ?)",
            [(tid, dep) for tid, _, _, _, deps, _ in TASKS for dep in deps],
        )
        conn.commit()
    finally:
        conn.close()
    return db_path


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=DEMO_DB_PATH, help="output path (default: data/board_demo.db)")
    path = build(parser.parse_args().db)
    print(f"Demo board rebuilt: {path} ({len(MEMBERS)} members, {len(TASKS)} tasks)")


if __name__ == "__main__":
    main()
