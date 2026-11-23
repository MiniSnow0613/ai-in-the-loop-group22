"""GPU list and GPU bookings for the shared board.

Rules (deterministic, no AI):
- Two bookings on the same GPU may not overlap while they are planned or
  running. Times are half-open [start, end): one booking may end at 14:00 and
  the next start at 14:00.
- A job may only start (planned -> running) once the linked task's
  prerequisites are all completed. Booking ahead of that is allowed.
- A task may have several bookings (its total GPU hours split into runs).
- A planned booking can move (time and GPU) and change length; a running one
  can only change its end time; a finished one stays as it is.
- A GPU with planned or running bookings cannot be deleted, only deactivated.
  A deactivated GPU keeps its bookings but takes no new ones.

Times are local wall-clock strings "YYYY-MM-DDTHH:MM" (the lab's time zone),
which sort and compare correctly as plain strings.
"""
import re
import shutil
import socket
import subprocess
import uuid
from datetime import datetime, timedelta

from flask import jsonify, request

TIME_FORMAT = "%Y-%m-%dT%H:%M"
ACTIVE_STATUSES = ("planned", "running")
MAX_BOOKING = timedelta(days=14)
MAX_NAME = 80
MAX_MEMORY_GB = 4096

DEFAULT_GPU = ("gpu-0", "GPU 0")


class GpuError(Exception):
    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.message = message
        self.status = status
        self.extra = extra

    def response(self):
        return jsonify(error=self.message, **self.extra), self.status


def seed_default_gpu(conn, ts):
    """Give a fresh board one GPU so the schedule is never empty (once per database)."""
    if conn.execute("SELECT 1 FROM meta WHERE key = 'gpus_seeded'").fetchone():
        return
    if conn.execute("SELECT 1 FROM gpus").fetchone() is None:
        conn.execute(
            "INSERT INTO gpus (id, name, memory_gb, active, position) VALUES (?, ?, NULL, 1, 0)",
            DEFAULT_GPU,
        )
    conn.execute("INSERT INTO meta (key, value) VALUES ('gpus_seeded', ?)", (ts,))


def parse_time(value, field):
    if not isinstance(value, str) or not value.strip():
        raise GpuError(f"{field} is required.")
    try:
        t = datetime.fromisoformat(value.strip())
    except ValueError:
        raise GpuError(f"{field} must look like 2026-11-16T14:00.") from None
    if t.tzinfo is not None:
        raise GpuError(f"{field} must be a local time without a time zone.")
    return t.replace(second=0, microsecond=0).strftime(TIME_FORMAT)


def fmt_range(start, end):
    """2026-11-16 14:00–20:00, or with both dates when it crosses midnight."""
    s, e = start.replace("T", " "), end.replace("T", " ")
    return f"{s}–{e[11:]}" if s[:10] == e[:10] else f"{s} – {e}"


def clean_name(value):
    if not isinstance(value, str) or not value.strip():
        raise GpuError("Enter a GPU name.")
    name = " ".join(value.split())
    if len(name) > MAX_NAME:
        raise GpuError(f"The GPU name is too long (max {MAX_NAME} characters).")
    return name


def clean_memory(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
        raise GpuError("Memory must be a whole number of GB.")
    value = int(value)
    if not 1 <= value <= MAX_MEMORY_GB:
        raise GpuError(f"Memory must be between 1 and {MAX_MEMORY_GB} GB.")
    return value


BOOKING_SELECT = """
    SELECT b.*, g.name AS gpu_name, t.title AS task_title, t.status AS task_status,
           m.name AS assignee_name
    FROM gpu_bookings b
    JOIN gpus g ON g.id = b.gpu_id
    LEFT JOIN tasks t ON t.id = b.task_id
    LEFT JOIN members m ON m.id = t.assignee_id
"""


def unfinished_prerequisites(conn, task_id):
    return conn.execute(
        """SELECT p.title FROM task_dependencies d
           JOIN tasks p ON p.id = d.prerequisite_id
           WHERE d.task_id = ? AND p.status <> 'done'
           ORDER BY p.position""",
        (task_id,),
    ).fetchall()


def booking_owner(row):
    if row["task_id"] is None:
        return row["label"]
    who = row["assignee_name"] or "Task Pool"
    return f"“{row['task_title']}” ({who})"


def booking_json(row, blocked_ids):
    return {
        "id": row["id"],
        "gpuId": row["gpu_id"],
        "gpuName": row["gpu_name"],
        "taskId": row["task_id"],
        "taskTitle": row["task_title"],
        "assigneeName": row["assignee_name"],
        "label": row["label"],
        "startAt": row["start_at"],
        "endAt": row["end_at"],
        "status": row["status"],
        "taskBlocked": row["task_id"] in blocked_ids,
    }


def blocked_task_ids(conn):
    return {
        r["task_id"]
        for r in conn.execute(
            """SELECT DISTINCT d.task_id FROM task_dependencies d
               JOIN tasks p ON p.id = d.prerequisite_id WHERE p.status <> 'done'"""
        )
    }


def task_bookings(conn):
    """{task_id: the booking its card shows}: running, else the next planned, else the last done."""
    rank = {"running": 0, "planned": 1, "done": 2}
    chosen = {}
    blocked = blocked_task_ids(conn)
    for r in conn.execute(BOOKING_SELECT + " WHERE b.task_id IS NOT NULL ORDER BY b.start_at"):
        current = chosen.get(r["task_id"])
        if current is None or rank[r["status"]] < rank[current["status"]] or (
            r["status"] == current["status"] == "done"  # later done booking wins
        ):
            chosen[r["task_id"]] = r
    return {tid: booking_json(r, blocked) for tid, r in chosen.items()}


def booked_hours(conn):
    """{task_id: hours} over planned, running and finished bookings."""
    totals = {}
    for r in conn.execute(
        "SELECT task_id, start_at, end_at FROM gpu_bookings WHERE task_id IS NOT NULL "
        "AND status IN ('planned', 'running', 'done')"
    ):
        span = datetime.strptime(r["end_at"], TIME_FORMAT) - datetime.strptime(r["start_at"], TIME_FORMAT)
        totals[r["task_id"]] = totals.get(r["task_id"], 0) + span.total_seconds() / 3600
    return {tid: round(h, 2) for tid, h in totals.items()}


def build_schedule(conn):
    upcoming = {
        r["gpu_id"]: r["n"]
        for r in conn.execute(
            "SELECT gpu_id, COUNT(*) AS n FROM gpu_bookings WHERE status IN ('planned', 'running') GROUP BY gpu_id"
        )
    }
    gpus = [
        {
            "id": r["id"],
            "name": r["name"],
            "memoryGb": r["memory_gb"],
            "active": bool(r["active"]),
            "upcomingCount": upcoming.get(r["id"], 0),
        }
        for r in conn.execute("SELECT * FROM gpus ORDER BY position, id")
    ]
    blocked = blocked_task_ids(conn)
    bookings = [
        booking_json(r, blocked) for r in conn.execute(BOOKING_SELECT + " ORDER BY b.start_at, b.id")
    ]
    return {"gpus": gpus, "bookings": bookings}


def find_conflicts(conn, gpu_id, start, end, exclude_id=None):
    return conn.execute(
        BOOKING_SELECT
        + """ WHERE b.gpu_id = ? AND b.status IN ('planned', 'running')
              AND b.start_at < ? AND ? < b.end_at AND b.id <> ?
            ORDER BY b.start_at""",
        (gpu_id, end, start, exclude_id or ""),
    ).fetchall()


def check_slot(conn, gpu_id, start, end, exclude_id=None):
    if start >= end:
        raise GpuError("The end time must be after the start time.")
    if datetime.strptime(end, TIME_FORMAT) - datetime.strptime(start, TIME_FORMAT) > MAX_BOOKING:
        raise GpuError("A booking can be at most 14 days long.")
    conflicts = find_conflicts(conn, gpu_id, start, end, exclude_id)
    if conflicts:
        gpu_name = conflicts[0]["gpu_name"]
        listed = "; ".join(f"{booking_owner(c)}, {fmt_range(c['start_at'], c['end_at'])}" for c in conflicts)
        raise GpuError(
            f"This time overlaps another booking on {gpu_name}: {listed}.",
            409,
            code="overlap",
            conflicts=[c["id"] for c in conflicts],
        )


def get_gpu(conn, gpu_id):
    row = conn.execute("SELECT * FROM gpus WHERE id = ?", (gpu_id,)).fetchone()
    if row is None:
        raise GpuError("Unknown GPU.", 404)
    return row


def get_booking(conn, booking_id):
    row = conn.execute(BOOKING_SELECT + " WHERE b.id = ?", (booking_id,)).fetchone()
    if row is None:
        raise GpuError("Booking not found.", 404)
    return row


def active_gpu_count(conn):
    return conn.execute("SELECT COUNT(*) FROM gpus WHERE active = 1").fetchone()[0]


def new_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def detect_local_gpus():
    """[(name, memory_gb)] from nvidia-smi on this machine; GpuError if unavailable."""
    exe = shutil.which("nvidia-smi")
    if exe is None:
        raise GpuError("nvidia-smi was not found on this machine. Add the GPUs by hand instead.", 404,
                       code="no_nvidia_smi")
    try:
        out = subprocess.run(
            [exe, "--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        raise GpuError("nvidia-smi could not list the GPUs on this machine.", 502, code="detect_failed") from None
    host = socket.gethostname()
    found = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        mem = round(float(parts[2]) / 1024) if re.fullmatch(r"\d+(\.\d+)?", parts[2]) else None
        found.append((f"{host} / GPU {parts[0]}", mem or None))
    return found


def register_gpu_routes(app, db, build_board, now_iso, detector=detect_local_gpus):
    """GPU list + booking endpoints. Every write returns the fresh schedule."""

    def handle(fn):
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except GpuError as e:
                db().rollback()
                return e.response()

        wrapper.__name__ = fn.__name__
        return wrapper

    def schedule_response(**extra):
        conn = db()
        return jsonify(schedule=build_schedule(conn), board=build_board(conn), **extra)

    @app.get("/api/gpus")
    def get_schedule():
        return jsonify(build_schedule(db()))

    # ---------- GPU list ----------

    @app.post("/api/gpus")
    @handle
    def create_gpu():
        body = request.get_json(silent=True) or {}
        conn = db()
        name = clean_name(body.get("name"))
        if conn.execute("SELECT 1 FROM gpus WHERE name = ?", (name,)).fetchone():
            raise GpuError(f"A GPU named “{name}” already exists.", 409)
        pos = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM gpus").fetchone()[0]
        conn.execute(
            "INSERT INTO gpus (id, name, memory_gb, active, position) VALUES (?, ?, ?, 1, ?)",
            (new_id("gpu"), name, clean_memory(body.get("memoryGb")), pos),
        )
        conn.commit()
        return schedule_response()

    @app.post("/api/gpus/detect")
    @handle
    def detect_gpus():
        conn = db()
        found = detector()
        taken = {r["name"] for r in conn.execute("SELECT name FROM gpus")}
        pos = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM gpus").fetchone()[0]
        added = []
        for name, mem in found:
            if name in taken:
                continue
            conn.execute(
                "INSERT INTO gpus (id, name, memory_gb, active, position) VALUES (?, ?, ?, 1, ?)",
                (new_id("gpu"), name, mem, pos + len(added)),
            )
            added.append(name)
        conn.commit()
        return schedule_response(found=len(found), added=added)

    @app.patch("/api/gpus/<gpu_id>")
    @handle
    def update_gpu(gpu_id):
        conn = db()
        gpu = get_gpu(conn, gpu_id)
        body = request.get_json(silent=True) or {}
        updates = {}
        if "name" in body:
            name = clean_name(body["name"])
            if conn.execute("SELECT 1 FROM gpus WHERE name = ? AND id <> ?", (name, gpu_id)).fetchone():
                raise GpuError(f"A GPU named “{name}” already exists.", 409)
            updates["name"] = name
        if "memoryGb" in body:
            updates["memory_gb"] = clean_memory(body["memoryGb"])
        if "active" in body:
            if not isinstance(body["active"], bool):
                raise GpuError("active must be true or false.")
            if not body["active"] and gpu["active"] and active_gpu_count(conn) <= 1:
                raise GpuError("Keep at least one active GPU.", 409)
            updates["active"] = int(body["active"])
        if not updates:
            raise GpuError("Nothing to update.")
        cols = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(f"UPDATE gpus SET {cols} WHERE id = ?", (*updates.values(), gpu_id))
        conn.commit()
        return schedule_response()

    @app.delete("/api/gpus/<gpu_id>")
    @handle
    def delete_gpu(gpu_id):
        conn = db()
        gpu = get_gpu(conn, gpu_id)
        upcoming = conn.execute(
            "SELECT COUNT(*) FROM gpu_bookings WHERE gpu_id = ? AND status IN ('planned', 'running')",
            (gpu_id,),
        ).fetchone()[0]
        if upcoming:
            raise GpuError(
                f"“{gpu['name']}” still has {upcoming} planned or running "
                f"booking{'s' if upcoming != 1 else ''}. Cancel or finish them first, or deactivate the GPU instead.",
                409,
            )
        if gpu["active"] and active_gpu_count(conn) <= 1:
            raise GpuError("Keep at least one active GPU.", 409)
        conn.execute("DELETE FROM gpu_bookings WHERE gpu_id = ?", (gpu_id,))
        conn.execute("DELETE FROM gpus WHERE id = ?", (gpu_id,))
        conn.commit()
        return schedule_response()

    # ---------- bookings ----------

    @app.post("/api/gpu-bookings")
    @handle
    def create_booking():
        body = request.get_json(silent=True) or {}
        conn = db()
        gpu = get_gpu(conn, body.get("gpuId"))
        if not gpu["active"]:
            raise GpuError(f"“{gpu['name']}” is deactivated and takes no new bookings.", 409)
        start = parse_time(body.get("startAt"), "Start time")
        end = parse_time(body.get("endAt"), "End time")

        task_id, label, warning = body.get("taskId"), None, None
        if task_id:
            task = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if task is None:
                raise GpuError("Task not found.", 404)
            if task["status"] == "done":
                raise GpuError(f"“{task['title']}” is already completed.", 409)
            if unfinished_prerequisites(conn, task_id):
                warning = (f"Booked. “{task['title']}” still has unfinished prerequisites, "
                           "so the job can't start until they are completed.")
        else:
            task_id = None
            label = body.get("label")
            if not isinstance(label, str) or not label.strip():
                raise GpuError("Choose a task, or describe who else is using the GPU.")
            label = " ".join(label.split())[:MAX_NAME]

        check_slot(conn, gpu["id"], start, end)
        ts = now_iso()
        booking_id = new_id("booking")
        conn.execute(
            """INSERT INTO gpu_bookings
               (id, gpu_id, task_id, label, start_at, end_at, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?)""",
            (booking_id, gpu["id"], task_id, label, start, end, ts, ts),
        )
        if task_id:
            conn.execute("UPDATE tasks SET needs_gpu = 1 WHERE id = ?", (task_id,))
        conn.commit()
        return schedule_response(bookingId=booking_id, warning=warning)

    @app.patch("/api/gpu-bookings/<booking_id>")
    @handle
    def update_booking(booking_id):
        conn = db()
        booking = get_booking(conn, booking_id)
        body = request.get_json(silent=True) or {}
        updates = {}

        if any(k in body for k in ("gpuId", "startAt", "endAt")):
            if booking["status"] == "done":
                raise GpuError("A finished booking can't be changed.", 409)
            if booking["status"] == "running" and (
                body.get("gpuId", booking["gpu_id"]) != booking["gpu_id"]
                or ("startAt" in body and parse_time(body["startAt"], "Start time") != booking["start_at"])
            ):
                raise GpuError("A running job can only change its end time.", 409)
            gpu_id = body.get("gpuId", booking["gpu_id"])
            gpu = get_gpu(conn, gpu_id)
            if gpu_id != booking["gpu_id"] and not gpu["active"]:
                raise GpuError(f"“{gpu['name']}” is deactivated and takes no new bookings.", 409)
            start = parse_time(body["startAt"], "Start time") if "startAt" in body else booking["start_at"]
            end = parse_time(body["endAt"], "End time") if "endAt" in body else booking["end_at"]
            check_slot(conn, gpu_id, start, end, exclude_id=booking_id)
            updates.update(gpu_id=gpu_id, start_at=start, end_at=end)

        if "status" in body:
            status = body["status"]
            allowed = {"planned": {"running"}, "running": {"done"}, "done": set()}
            if status not in ("planned", "running", "done"):
                raise GpuError('Invalid status. Use "running" or "done".')
            if status != booking["status"]:
                if status not in allowed[booking["status"]]:
                    raise GpuError(f"A {booking['status']} booking can't become {status}.", 409)
                if status == "running" and booking["task_id"]:
                    unfinished = unfinished_prerequisites(conn, booking["task_id"])
                    if unfinished:
                        names = ", ".join(f"“{r['title']}”" for r in unfinished)
                        raise GpuError(f"Can't start this job yet. Unfinished prerequisites: {names}.", 409,
                                       code="prerequisites")
                updates["status"] = status

        if not updates:
            raise GpuError("Nothing to update.")
        updates["updated_at"] = now_iso()
        cols = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(f"UPDATE gpu_bookings SET {cols} WHERE id = ?", (*updates.values(), booking_id))
        conn.commit()
        return schedule_response()

    @app.delete("/api/gpu-bookings/<booking_id>")
    @handle
    def delete_booking(booking_id):
        conn = db()
        booking = get_booking(conn, booking_id)
        if booking["status"] == "running":
            raise GpuError("This job is running. Mark it finished first.", 409)
        conn.execute("DELETE FROM gpu_bookings WHERE id = ?", (booking_id,))
        conn.commit()
        return schedule_response()
