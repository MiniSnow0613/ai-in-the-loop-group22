"""CP2 prototype backend: shared task board stored in SQLite.

Run:  python app.py   (serves the API, and the built frontend if frontend/dist exists)
"""
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_from_directory

import ai_suggest
import gpu
from ai_suggest import AiSuggester, SuggestionError

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"
DEFAULT_DB_PATH = BASE_DIR / "data" / "board.db"

VALID_STATUSES = {"todo", "done"}

# Databases created before multi-prerequisite support also have a legacy
# tasks.depends_on column. It is copied into task_dependencies once (see
# migrate_legacy_dependencies) and is no longer read or written afterwards.
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    is_example   INTEGER NOT NULL DEFAULT 0,
    assignee_id  TEXT REFERENCES members(id),
    status       TEXT NOT NULL DEFAULT 'todo',
    waiting_text TEXT,
    position     INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL,
    description  TEXT,
    summary      TEXT,
    needs_gpu    INTEGER NOT NULL DEFAULT 0,
    -- Total GPU hours the task needs; "ai" = AI estimate, "user" = set or confirmed by a person.
    gpu_hours           REAL,
    gpu_hours_source    TEXT,
    -- Background AI estimate for hand-made tasks: NULL, 'pending', 'done' or 'failed'.
    gpu_estimate_status TEXT,
    gpu_estimate_reason TEXT,
    gpu_estimate_error  TEXT
);
CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    prerequisite_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, prerequisite_id),
    CHECK (task_id <> prerequisite_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_prerequisite
    ON task_dependencies (prerequisite_id);
-- GPU schedule (rules in gpu.py). Times are local "YYYY-MM-DDTHH:MM" strings.
CREATE TABLE IF NOT EXISTS gpus (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    memory_gb INTEGER,
    active    INTEGER NOT NULL DEFAULT 1,
    position  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS gpu_bookings (
    id         TEXT PRIMARY KEY,
    gpu_id     TEXT NOT NULL REFERENCES gpus(id),
    task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    label      TEXT,
    start_at   TEXT NOT NULL,
    end_at     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (start_at < end_at),
    CHECK (task_id IS NOT NULL OR label IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_gpu_bookings_gpu ON gpu_bookings (gpu_id, start_at);
CREATE INDEX IF NOT EXISTS idx_gpu_bookings_task ON gpu_bookings (task_id);
"""

# Columns added after the first CP2 version; added in place to older databases.
ADDED_TASK_COLUMNS = {
    "description": "TEXT",
    "summary": "TEXT",
    "needs_gpu": "INTEGER NOT NULL DEFAULT 0",
    "gpu_hours": "REAL",
    "gpu_hours_source": "TEXT",
    "gpu_estimate_status": "TEXT",
    "gpu_estimate_reason": "TEXT",
    "gpu_estimate_error": "TEXT",
}

ESTIMATE_INTERRUPTED = "The estimate was interrupted because the server restarted. Ask AI again."

SEED_MEMBERS = [
    ("member-a", "Member A", 0),
    ("member-b", "Member B", 1),
]

# Task IDs are stable: dragging a card only changes assignee_id, so
# dependencies (task_dependencies rows) keep pointing at the same tasks.
SEED_TASKS = [
    # id, title, prerequisite ids, waiting_text, position
    ("example-update-dataset", "Update dataset", [], None, 0),
    ("example-train-model", "Train model", ["example-update-dataset"], "Waiting for dataset update", 1),
]

SEED_DESCRIPTIONS = {
    "example-update-dataset": "Re-collect and clean the experiment data to produce a new dataset for training.",
    "example-train-model": "Train the model on the updated dataset and save a checkpoint for evaluation.",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def task_columns(conn):
    return {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}


def migrate_legacy_dependencies(conn):
    """Copy tasks.depends_on into task_dependencies, once per database.

    The meta flag makes this a one-time step, so a dependency removed later
    (e.g. by a future editor) is never brought back from the old column.
    """
    if conn.execute("SELECT 1 FROM meta WHERE key = 'dependencies_migrated'").fetchone():
        return
    if "depends_on" in task_columns(conn):
        conn.execute(
            """INSERT OR IGNORE INTO task_dependencies (task_id, prerequisite_id)
               SELECT id, depends_on FROM tasks
               WHERE depends_on IS NOT NULL AND depends_on <> id
                 AND depends_on IN (SELECT id FROM tasks)"""
        )
    conn.execute("INSERT INTO meta (key, value) VALUES ('dependencies_migrated', ?)", (now_iso(),))


def init_db(db_path):
    """Create/upgrade tables and insert example data exactly once (tracked in meta)."""
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA)
        existing = task_columns(conn)
        for col, col_type in ADDED_TASK_COLUMNS.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {col_type}")
        migrate_legacy_dependencies(conn)

        if conn.execute("SELECT 1 FROM meta WHERE key = 'seeded'").fetchone() is None:
            conn.executemany(
                "INSERT INTO members (id, name, position) VALUES (?, ?, ?)", SEED_MEMBERS
            )
            ts = now_iso()
            conn.executemany(
                """INSERT INTO tasks
                   (id, title, is_example, assignee_id, status, waiting_text, position, updated_at)
                   VALUES (?, ?, 1, NULL, 'todo', ?, ?, ?)""",
                [(tid, title, wait, pos, ts) for tid, title, _, wait, pos in SEED_TASKS],
            )
            conn.executemany(
                "INSERT INTO task_dependencies (task_id, prerequisite_id) VALUES (?, ?)",
                [(tid, dep) for tid, _, deps, _, _ in SEED_TASKS for dep in deps],
            )
            conn.execute("INSERT INTO meta (key, value) VALUES ('seeded', ?)", (ts,))
        # Fill descriptions of example tasks (also for databases created before
        # the column existed); never overwrites a description already stored.
        conn.executemany(
            "UPDATE tasks SET description = ? WHERE id = ? AND is_example = 1 AND description IS NULL",
            [(desc, tid) for tid, desc in SEED_DESCRIPTIONS.items()],
        )
        gpu.seed_default_gpu(conn, now_iso())
        # An estimate still "pending" belonged to a server that has stopped.
        conn.execute(
            "UPDATE tasks SET gpu_estimate_status = 'failed', gpu_estimate_error = ? "
            "WHERE gpu_estimate_status = 'pending'",
            (ESTIMATE_INTERRUPTED,),
        )
        conn.commit()
    finally:
        conn.close()


def load_prerequisites(conn, task_ids):
    """{task_id: [prerequisite ids]} for every task, ordered like the board."""
    prereqs = {tid: [] for tid in task_ids}
    for r in conn.execute(
        """SELECT d.task_id, d.prerequisite_id FROM task_dependencies d
           JOIN tasks p ON p.id = d.prerequisite_id
           ORDER BY p.position, p.id"""
    ):
        if r["task_id"] in prereqs:
            prereqs[r["task_id"]].append(r["prerequisite_id"])
    return prereqs


def compute_rows(prereqs):
    """Shared Timeline row ("dependency level", 1-based) for every task.

    `prereqs` maps every task id to its prerequisite ids. No prerequisites ->
    row 1; otherwise one after the latest prerequisite row. Uses all tasks
    (assigned or still in the Task Pool) and ignores assignee and status, so
    completing or moving a task never shifts any card's row.
    """
    rows, visiting = {}, set()

    def row_of(task_id):
        if task_id in rows:
            return rows[task_id]
        if task_id in visiting:  # dependency cycle: break it instead of recursing forever
            return 0
        visiting.add(task_id)
        deps = [d for d in prereqs.get(task_id, []) if d in prereqs]
        rows[task_id] = 1 + max((row_of(d) for d in deps), default=0)
        visiting.discard(task_id)
        return rows[task_id]

    for task_id in prereqs:
        row_of(task_id)
    return rows


def state_text(row, pending, member_names):
    """Short card status: what the task is actually waiting for."""
    if row["status"] == "done":
        return "Completed"
    if not pending:
        return "Ready"
    if len(pending) > 1:
        return f"Waiting for {len(pending)} prerequisites"
    dep = pending[0]
    owner = member_names.get(dep["assignee_id"])
    default = f"Waiting for {owner}: {dep['title']}" if owner else f"Waiting for “{dep['title']}”"
    # A task's own waiting_text (e.g. "Waiting for dataset update") wins for its single blocker.
    return row["waiting_text"] or default


def build_board(conn):
    members = [dict(r) for r in conn.execute("SELECT id, name FROM members ORDER BY position")]
    names = {m["id"]: m["name"] for m in members}
    rows = conn.execute("SELECT * FROM tasks ORDER BY position, id").fetchall()
    by_id = {r["id"]: r for r in rows}
    prereqs = load_prerequisites(conn, by_id)
    dependents = {tid: [] for tid in by_id}
    for tid in by_id:  # board order, so dependents are listed in a stable order
        for p in prereqs[tid]:
            dependents[p].append(tid)
    timeline_rows = compute_rows(prereqs)
    gpu_bookings = gpu.task_bookings(conn)
    booked_hours = gpu.booked_hours(conn)

    def ref(tid):
        t = by_id[tid]
        return {
            "id": tid,
            "title": t["title"],
            "assigneeId": t["assignee_id"],
            "assigneeName": names.get(t["assignee_id"]),
            "status": t["status"],
        }

    tasks = []
    for r in rows:
        pending = [by_id[p] for p in prereqs[r["id"]] if by_id[p]["status"] != "done"]
        tasks.append(
            {
                "id": r["id"],
                "title": r["title"],
                "description": r["description"],
                "summary": r["summary"],
                "isExample": bool(r["is_example"]),
                "assigneeId": r["assignee_id"],
                "status": r["status"],
                "prerequisites": [ref(p) for p in prereqs[r["id"]]],
                "dependents": [ref(d) for d in dependents[r["id"]]],
                "pendingCount": len(pending),
                "blocked": bool(pending),
                "stateText": state_text(r, pending, names),
                "row": timeline_rows[r["id"]],
                "updatedAt": r["updated_at"],
                "needsGpu": bool(r["needs_gpu"]) or r["id"] in gpu_bookings,
                "gpuBooking": gpu_bookings.get(r["id"]),
                "gpuHours": r["gpu_hours"],
                "gpuHoursSource": r["gpu_hours_source"],
                "bookedGpuHours": booked_hours.get(r["id"], 0),
                "gpuEstimate": {
                    "status": r["gpu_estimate_status"],
                    "reason": r["gpu_estimate_reason"],
                    "error": r["gpu_estimate_error"],
                },
            }
        )
    return {"members": members, "tasks": tasks}


def titles(rows):
    return ", ".join(f"“{r['title']}”" for r in rows)


def suggestion_preview(tasks, existing_titles):
    """Candidate tasks plus what the browser needs to show who depends on whom."""
    batch = {t["id"]: t for t in tasks}
    unlocks = {t["id"]: [] for t in tasks}
    for t in tasks:
        for p in t["prerequisites"]:
            if p in unlocks:
                unlocks[p].append(t["id"])

    def ref(pid):
        if pid in batch:
            return {"id": pid, "kind": "new", "title": batch[pid]["title"]}
        if pid in existing_titles:
            return {"id": pid, "kind": "existing", "title": existing_titles[pid]}
        return {"id": pid, "kind": "unknown", "title": None}

    return [
        {**t, "prerequisiteRefs": [ref(p) for p in t["prerequisites"]], "unlocks": unlocks[t["id"]]}
        for t in tasks
    ]


def new_task_id(taken, prefix="ai"):
    while True:
        tid = f"{prefix}-{uuid.uuid4().hex[:8]}"
        if tid not in taken:
            taken.add(tid)
            return tid


def insert_tasks(conn, tasks, id_map):
    """Insert unassigned tasks and their prerequisites at the end of the board.

    `tasks` are normalized dicts (id, title, description, prerequisites, and
    optionally gpu); `id_map` maps each task's temporary id to its new board id.
    Prerequisites not in id_map are existing board ids. The caller commits or
    rolls back.
    """
    start = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM tasks").fetchone()[0]
    ts = now_iso()

    def gpu_columns(t):
        g = t.get("gpu")
        if not g:
            return (0, None, None, None)
        return (int(g["needed"]), g["hours"], g["source"], g["reason"] or None)

    conn.executemany(
        """INSERT INTO tasks
           (id, title, is_example, assignee_id, status, waiting_text,
            position, updated_at, description, summary,
            needs_gpu, gpu_hours, gpu_hours_source, gpu_estimate_reason)
           VALUES (?, ?, 0, NULL, 'todo', NULL, ?, ?, ?, NULL, ?, ?, ?, ?)""",
        [
            (id_map[t["id"]], t["title"], start + i, ts, t["description"] or None, *gpu_columns(t))
            for i, t in enumerate(tasks)
        ],
    )
    conn.executemany(
        "INSERT INTO task_dependencies (task_id, prerequisite_id) VALUES (?, ?)",
        [(id_map[t["id"]], id_map.get(p, p)) for t in tasks for p in t["prerequisites"]],
    )


def prerequisite_problem(conn, task_id, prereqs, status):
    """(message, http status) if `prereqs` can't be the prerequisites of `task_id`, else None."""
    by_id = {r["id"]: r for r in conn.execute("SELECT id, title, status FROM tasks")}
    missing = [p for p in prereqs if p not in by_id]
    if missing:
        return f"Unknown prerequisite: {', '.join(missing)}.", 422
    if task_id in prereqs:
        return "A task cannot depend on itself.", 422
    # Tasks that (directly or indirectly) depend on task_id can't become its prerequisites.
    dependents = {}
    for r in conn.execute("SELECT task_id, prerequisite_id FROM task_dependencies"):
        dependents.setdefault(r["prerequisite_id"], []).append(r["task_id"])
    downstream, stack = set(), [task_id]
    while stack:
        for d in dependents.get(stack.pop(), []):
            if d not in downstream:
                downstream.add(d)
                stack.append(d)
    loops = [p for p in prereqs if p in downstream]
    if loops:
        return f"Circular dependency: {titles([by_id[p] for p in loops])} already depends on this task.", 422
    if status == "done":
        unfinished = [by_id[p] for p in prereqs if by_id[p]["status"] != "done"]
        if unfinished:
            return (
                f"This task is completed, so its prerequisites must be completed too: {titles(unfinished)}. Undo completion first.",
                409,
            )
    return None


def run_gpu_estimate(db_path, suggester, task_id):
    """Ask the AI about one task and store the answer, unless a person decided meanwhile.

    Runs outside any request, so it opens its own connection. Only a task whose
    estimate is still "pending" is updated: editing the GPU fields by hand
    clears that status, and a deleted task simply matches nothing.
    """
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT title, description FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            return
        try:
            est = suggester.estimate_gpu(row["title"], row["description"] or "")
        except SuggestionError as e:
            conn.execute(
                "UPDATE tasks SET gpu_estimate_status = 'failed', gpu_estimate_error = ? "
                "WHERE id = ? AND gpu_estimate_status = 'pending'",
                (e.message, task_id),
            )
        except Exception:  # never leave the card stuck on "Estimating…"
            conn.execute(
                "UPDATE tasks SET gpu_estimate_status = 'failed', gpu_estimate_error = ? "
                "WHERE id = ? AND gpu_estimate_status = 'pending'",
                ("The GPU estimate failed unexpectedly. Ask AI again.", task_id),
            )
        else:
            conn.execute(
                """UPDATE tasks SET needs_gpu = ?, gpu_hours = ?, gpu_hours_source = 'ai',
                       gpu_estimate_status = 'done', gpu_estimate_reason = ?, gpu_estimate_error = NULL
                   WHERE id = ? AND gpu_estimate_status = 'pending'""",
                (int(est["needed"]), est["hours"], est["reason"] or None, task_id),
            )
        conn.commit()
    finally:
        conn.close()


def run_in_background(job):
    threading.Thread(target=job, daemon=True).start()


def create_app(db_path=None, suggester=None, gpu_detector=None, gpu_estimate_runner=None):
    app = Flask(__name__, static_folder=None)
    app.config["DB_PATH"] = str(db_path or os.environ.get("BOARD_DB_PATH") or DEFAULT_DB_PATH)
    # Tests pass a fake suggester; the real one calls the provider set by AI_PROVIDER.
    app.config["SUGGESTER"] = suggester or AiSuggester()
    # Tests run GPU estimates inline; the server runs them on a background thread.
    app.config["GPU_ESTIMATE_RUNNER"] = gpu_estimate_runner or run_in_background
    init_db(app.config["DB_PATH"])

    def db():
        if "db" not in g:
            g.db = connect(app.config["DB_PATH"])
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    @app.get("/api/board")
    def get_board():
        return jsonify(build_board(db()))

    @app.patch("/api/tasks/<task_id>")
    def update_task(task_id):
        row = db().execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            abort(404, description="Task not found.")
        body = request.get_json(silent=True) or {}
        updates = {}

        if "assigneeId" in body:
            assignee = body["assigneeId"]
            if assignee is not None:
                exists = db().execute("SELECT 1 FROM members WHERE id = ?", (assignee,)).fetchone()
                if exists is None:
                    return jsonify(error="Unknown member."), 400
            updates["assignee_id"] = assignee

        if "status" in body:
            status = body["status"]
            if status not in VALID_STATUSES:
                return jsonify(error="Invalid status. Use \"todo\" or \"done\"."), 400
            if status == "done":
                unfinished = db().execute(
                    """SELECT p.title FROM task_dependencies d
                       JOIN tasks p ON p.id = d.prerequisite_id
                       WHERE d.task_id = ? AND p.status <> 'done'
                       ORDER BY p.position""",
                    (task_id,),
                ).fetchall()
                if unfinished:
                    return jsonify(error=f"Cannot complete this task yet. Unfinished prerequisites: {titles(unfinished)}."), 409
            if status == "todo":
                done_dependents = db().execute(
                    """SELECT t.title FROM task_dependencies d
                       JOIN tasks t ON t.id = d.task_id
                       WHERE d.prerequisite_id = ? AND t.status = 'done'
                       ORDER BY t.position""",
                    (task_id,),
                ).fetchall()
                if done_dependents:
                    return (
                        jsonify(error=f"Undo completion of {titles(done_dependents)} first. It depends on this task and is already completed."),
                        409,
                    )
            updates["status"] = status

        if "needsGpu" in body:
            needs = body["needsGpu"]
            if not isinstance(needs, bool):
                return jsonify(error="needsGpu must be true or false."), 400
            if not needs and db().execute(
                "SELECT 1 FROM gpu_bookings WHERE task_id = ? AND status IN ('planned', 'running')",
                (task_id,),
            ).fetchone():
                return jsonify(error="This task has a planned or running GPU booking. Cancel it first."), 409
            updates["needs_gpu"] = int(needs)
            updates["gpu_hours_source"] = "user"

        if "gpuHours" in body:
            # A person sets or confirms the total GPU hours; null = "needs a GPU, time unknown".
            raw = body["gpuHours"]
            hours = None if raw is None else ai_suggest.gpu_hours_value(raw)
            if raw is not None and hours is None:
                return jsonify(
                    error=f"GPU hours must be a number from {ai_suggest.MIN_GPU_HOURS:g} to {ai_suggest.MAX_GPU_HOURS}."
                ), 400
            updates.update(gpu_hours=hours, gpu_hours_source="user")
            if updates.get("needs_gpu") != 0:
                updates["needs_gpu"] = 1

        if "needs_gpu" in updates and row["gpu_estimate_status"] == "pending":
            # The person decided; a late AI answer must not overwrite it.
            updates["gpu_estimate_status"] = None

        if "title" in body:
            title = body["title"]
            if not isinstance(title, str) or not title.strip():
                return jsonify(error="Give the task a title."), 400
            updates["title"] = " ".join(title.split())[: ai_suggest.MAX_TITLE]

        if "description" in body:
            description = body["description"] or ""
            if not isinstance(description, str):
                return jsonify(error="The description must be text."), 400
            updates["description"] = " ".join(description.split())[: ai_suggest.MAX_DESCRIPTION] or None

        new_prereqs = None
        if "prerequisites" in body:
            prereqs = body["prerequisites"]
            if not isinstance(prereqs, list) or not all(isinstance(p, str) for p in prereqs):
                return jsonify(error="Prerequisites must be a list of task ids."), 400
            new_prereqs = list(dict.fromkeys(p.strip() for p in prereqs if p.strip()))
            problem = prerequisite_problem(db(), task_id, new_prereqs, row["status"])
            if problem:
                return jsonify(error=problem[0]), problem[1]

        if not updates and new_prereqs is None:
            return jsonify(error="Nothing to update."), 400

        updates["updated_at"] = now_iso()
        cols = ", ".join(f"{k} = ?" for k in updates)
        db().execute(f"UPDATE tasks SET {cols} WHERE id = ?", (*updates.values(), task_id))
        if new_prereqs is not None:
            db().execute("DELETE FROM task_dependencies WHERE task_id = ?", (task_id,))
            db().executemany(
                "INSERT INTO task_dependencies (task_id, prerequisite_id) VALUES (?, ?)",
                [(task_id, p) for p in new_prereqs],
            )
        db().commit()
        return jsonify(build_board(db()))

    @app.delete("/api/tasks/<task_id>")
    def delete_task(task_id):
        """Delete a task. Tasks that depended on it lose that prerequisite; its GPU bookings go too."""
        conn = db()
        if conn.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)).fetchone() is None:
            abort(404, description="Task not found.")
        # task_dependencies and gpu_bookings rows go with it (ON DELETE CASCADE).
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        return jsonify(build_board(conn))

    def existing_titles():
        return {r["id"]: r["title"] for r in db().execute("SELECT id, title FROM tasks")}

    @app.post("/api/tasks")
    def create_task():
        """Add one task by hand. It goes to the Task Pool; prerequisites must be board tasks."""
        body = request.get_json(silent=True) or {}
        title = body.get("title")
        description = body.get("description") or ""
        prereqs = body.get("prerequisites") or []
        if not isinstance(title, str) or not title.strip():
            return jsonify(error="Give the task a title.", code="invalid_task"), 400
        if not isinstance(description, str):
            return jsonify(error="The description must be text.", code="invalid_task"), 400
        if not isinstance(prereqs, list) or not all(isinstance(p, str) for p in prereqs):
            return jsonify(error="Prerequisites must be a list of task ids.", code="invalid_task"), 400
        task = {
            "id": "new",
            "title": " ".join(title.split())[: ai_suggest.MAX_TITLE],
            "description": " ".join(description.split())[: ai_suggest.MAX_DESCRIPTION],
            "prerequisites": list(dict.fromkeys(p.strip() for p in prereqs if p.strip())),
        }

        conn = db()
        titles_by_id = existing_titles()
        missing = [p for p in task["prerequisites"] if p not in titles_by_id]
        if missing:
            return jsonify(error=f"Unknown prerequisite: {', '.join(missing)}.", code="invalid_dependencies"), 422

        id_map = {"new": new_task_id(set(titles_by_id), prefix="task")}
        try:
            insert_tasks(conn, [task], id_map)
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            return jsonify(error=f"The task was not added: the database rejected it ({e}).", code="db_error"), 500
        # Ask the AI about GPU use in the background; the card shows up right away.
        if can_estimate():
            start_gpu_estimate(conn, id_map["new"])
        return jsonify(board=build_board(conn), createdId=id_map["new"]), 201

    # ---------- AI GPU estimate for one task (runs in the background) ----------

    def can_estimate():
        suggester = app.config["SUGGESTER"]
        return hasattr(suggester, "estimate_gpu") and suggester.configured()

    def start_gpu_estimate(conn, task_id):
        conn.execute(
            "UPDATE tasks SET gpu_estimate_status = 'pending', gpu_estimate_error = NULL WHERE id = ?",
            (task_id,),
        )
        conn.commit()
        app.config["GPU_ESTIMATE_RUNNER"](
            lambda: run_gpu_estimate(app.config["DB_PATH"], app.config["SUGGESTER"], task_id)
        )

    @app.post("/api/tasks/<task_id>/gpu-estimate")
    def request_gpu_estimate(task_id):
        """Ask the AI again whether this task needs a GPU and for how long."""
        conn = db()
        row = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            abort(404, description="Task not found.")
        if row["status"] == "done":
            return jsonify(error="This task is already completed.", code="task_done"), 409
        if not hasattr(app.config["SUGGESTER"], "estimate_gpu"):
            return jsonify(error="GPU estimates are not available.", code="unavailable"), 503
        status = app.config["SUGGESTER"].status()
        if not status.get("configured"):
            key_env = status.get("keyEnv") or "the API key"
            return (
                jsonify(error=f"The AI assistant has no API key. Set {key_env} and restart the server.",
                        code="missing_key"),
                503,
            )
        start_gpu_estimate(conn, task_id)
        return jsonify(build_board(conn)), 202

    # ---------- AI task suggestions (OpenRouter or Groq, see AI_PROVIDER) ----------

    @app.get("/api/ai/status")
    def ai_status():
        """Provider, model and whether its key is set. Never returns the key."""
        return jsonify(app.config["SUGGESTER"].status())

    @app.post("/api/suggestions")
    def suggest_tasks():
        """Ask the model for candidate tasks. Read-only: nothing is saved."""
        body = request.get_json(silent=True) or {}
        description = body.get("description")
        if not isinstance(description, str) or not description.strip():
            return jsonify(error="Describe the work you want to plan first.", code="empty_input"), 400
        description = description.strip()
        if len(description) > ai_suggest.MAX_INPUT:
            return (
                jsonify(error=f"The description is too long (max {ai_suggest.MAX_INPUT} characters).", code="too_long"),
                400,
            )
        board_tasks = [
            dict(r) for r in db().execute("SELECT id, title, status FROM tasks ORDER BY position, id")
        ]
        try:
            tasks = app.config["SUGGESTER"].suggest(description, board_tasks)
        except SuggestionError as e:
            return jsonify(e.to_json()), e.http_status
        titles_by_id = {t["id"]: t["title"] for t in board_tasks}
        return jsonify(
            provider=app.config["SUGGESTER"].provider_name,
            model=app.config["SUGGESTER"].model,
            tasks=suggestion_preview(tasks, titles_by_id),
            issues=ai_suggest.validate_batch(tasks, titles_by_id),
        )

    @app.post("/api/suggestions/accept")
    def accept_suggestions():
        """Validate the previewed batch and save tasks + dependencies together."""
        body = request.get_json(silent=True) or {}

        def invalid(reason):
            return SuggestionError("invalid_batch", f"The task list is invalid: {reason}.", 400)

        try:
            tasks = ai_suggest.normalize_tasks(body.get("tasks"), error=invalid)
        except SuggestionError as e:
            return jsonify(e.to_json()), e.http_status

        conn = db()
        titles_by_id = existing_titles()
        problems = ai_suggest.validate_batch(tasks, titles_by_id)
        if problems:
            return (
                jsonify(
                    error="Nothing was added. " + " ".join(problems),
                    code="invalid_dependencies",
                    problems=problems,
                ),
                422,
            )

        taken = set(titles_by_id)
        id_map = {t["id"]: new_task_id(taken) for t in tasks}
        try:
            insert_tasks(conn, tasks, id_map)
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            return jsonify(error=f"Nothing was added: the database rejected the tasks ({e}).", code="db_error"), 500

        return jsonify(board=build_board(conn), createdIds=[id_map[t["id"]] for t in tasks], idMap=id_map)

    # ---------- GPU list and bookings (rules in gpu.py) ----------
    # Tests pass a fake detector; the real one runs nvidia-smi on this machine.
    gpu.register_gpu_routes(app, db, build_board, now_iso, detector=gpu_detector or gpu.detect_local_gpus)

    # Serve the built React app (npm run build) so one URL is enough.
    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def frontend(path):
        if not FRONTEND_DIST.exists():
            return (
                "Frontend not built. Run `npm install` and `npm run build` in frontend/, "
                "or use the Vite dev server (npm run dev).",
                404,
            )
        target = FRONTEND_DIST / path
        if path and target.is_file():
            return send_from_directory(FRONTEND_DIST, path)
        return send_from_directory(FRONTEND_DIST, "index.html")

    return app


LOCAL_ENV_PATH = BASE_DIR / ".env"
SAVED_ENV_KEYS = ("AI_PROVIDER", "GROQ_API_KEY", "OPENROUTER_API_KEY")


def sync_local_env(env_path=LOCAL_ENV_PATH, environ=os.environ):
    """Load saved AI settings from backend/.env, and persist any newly provided ones."""
    path = Path(env_path)
    stored = {}
    if path.is_file():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key:
                stored[key] = val

    updated = dict(stored)
    for key in SAVED_ENV_KEYS:
        current = (environ.get(key) or "").strip()
        if current:
            updated[key] = current

    if updated != stored:
        lines = [f"{k}={v}" for k, v in updated.items()]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    for key, val in updated.items():
        if val and not (environ.get(key) or "").strip():
            environ[key] = val


if __name__ == "__main__":
    sync_local_env()
    port = int(os.environ.get("PORT", "5000"))
    create_app().run(host="127.0.0.1", port=port, debug=False)

