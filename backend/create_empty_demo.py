"""Create an empty demo board for peer review: backend/data/board_empty_demo.db.

    .\\backend\\.venv\\Scripts\\python.exe backend\\create_empty_demo.py
    .\\backend\\.venv\\Scripts\\python.exe backend\\create_empty_demo.py --db PATH

The new database has the demo's four members and two GPUs (taken from
seed_demo.py), and no tasks, task dependencies or GPU bookings. It is built
with the application's own init_db(), and the meta flags that stop init_db
from re-adding the example cards or the default GPU are set first, so starting
Flask on it keeps the board empty.

Safety:
- Never touches board.db or board_demo.db (refuses those paths).
- If the target already exists, it is only replaced after you type REPLACE.
  The old file is backed up first (board_empty_demo.backup-<time>.db), and the
  new database is built and checked in a temporary file, then moved into place
  in one step, so a failure leaves the existing file as it was.
- Refuses to replace a database that SQLite may still be writing
  (-journal / -wal file next to it): stop Flask first.
Needs the backend virtual environment (it uses app.py, so Flask must be installed).
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import app
import seed_demo

DATA_DIR = Path(__file__).resolve().parent / "data"
EMPTY_DEMO_DB_PATH = DATA_DIR / "board_empty_demo.db"
PROTECTED = (app.DEFAULT_DB_PATH.resolve(), seed_demo.DEMO_DB_PATH.resolve())
CONFIRM_WORD = "REPLACE"
EXIT_OK, EXIT_ERROR, EXIT_CANCELLED = 0, 1, 2

# init_db() seeds example tasks/members, the default GPU, and migrates the old
# depends_on column unless these flags exist. Set them before it runs.
META_FLAGS = ("seeded", "gpus_seeded", "dependencies_migrated")


class EmptyDemoError(Exception):
    pass


def sidecar_files(path):
    """SQLite journal files that mean the database may be open or mid-write."""
    return [p for p in (Path(f"{path}-journal"), Path(f"{path}-wal")) if p.exists()]


def describe_existing(path):
    """Row counts of an existing database, opened read-only. Never raises."""
    try:
        conn = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
        try:
            parts = []
            for table in ("tasks", "task_dependencies", "members", "gpus", "gpu_bookings"):
                try:
                    parts.append(f"{table} {conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]}")
                except sqlite3.Error:
                    parts.append(f"{table} (missing)")
            return ", ".join(parts)
        finally:
            conn.close()
    except sqlite3.Error as e:
        return f"could not read it ({e})"


def build_empty(path):
    """Create a new empty demo database at `path` (which must not exist yet)."""
    ts = app.now_iso()
    conn = app.connect(path)
    try:
        conn.executescript(app.SCHEMA)
        conn.executemany(
            "INSERT INTO meta (key, value) VALUES (?, ?)",
            [(flag, ts) for flag in META_FLAGS] + [("demo", "group22-empty-review")],
        )
        conn.commit()
    finally:
        conn.close()

    app.init_db(str(path))  # the application's own initialization and upgrades

    conn = app.connect(path)
    try:
        conn.executemany(
            "INSERT INTO members (id, name, position) VALUES (?, ?, ?)",
            [(mid, name, i) for i, (mid, name) in enumerate(seed_demo.MEMBERS)],
        )
        conn.executemany(
            "INSERT INTO gpus (id, name, memory_gb, active, position) VALUES (?, ?, ?, 1, ?)",
            [(gid, name, mem, i) for i, (gid, name, mem) in enumerate(seed_demo.GPUS)],
        )
        conn.commit()
    finally:
        conn.close()


def verify(path):
    """Open the database the way the Flask app does and check it is empty and usable."""
    client = app.create_app(path, gpu_detector=lambda: []).test_client()
    board = client.get("/api/board")
    schedule = client.get("/api/gpus")
    if board.status_code != 200 or schedule.status_code != 200:
        raise EmptyDemoError(f"the app could not read the new database (HTTP {board.status_code}/{schedule.status_code})")
    board, schedule = board.get_json(), schedule.get_json()
    problems = []
    if board["tasks"]:
        problems.append(f"{len(board['tasks'])} tasks")
    if schedule["bookings"]:
        problems.append(f"{len(schedule['bookings'])} GPU bookings")
    if [m["id"] for m in board["members"]] != [m[0] for m in seed_demo.MEMBERS]:
        problems.append("members differ from the demo")
    if sorted(g["id"] for g in schedule["gpus"]) != sorted(g[0] for g in seed_demo.GPUS):
        problems.append("GPUs differ from the demo")
    conn = sqlite3.connect(path)
    try:
        deps = conn.execute("SELECT COUNT(*) FROM task_dependencies").fetchone()[0]
    finally:
        conn.close()
    if deps:
        problems.append(f"{deps} task dependencies")
    if problems:
        raise EmptyDemoError("the new database is not empty as expected: " + ", ".join(problems))
    return board, schedule


def backup_path(target):
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = target.with_name(f"{target.stem}.backup-{stamp}{target.suffix}")
    n = 1
    while candidate.exists():
        candidate = target.with_name(f"{target.stem}.backup-{stamp}-{n}{target.suffix}")
        n += 1
    return candidate


def backup(target):
    """Consistent copy of the existing database using SQLite's backup API."""
    dest = backup_path(target)
    src = sqlite3.connect(f"{target.as_uri()}?mode=ro", uri=True)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return dest


def create(target, ask=input, out=print):
    target = Path(target).resolve()
    out(f"Empty demo database: {target}")
    if target in PROTECTED:
        out("Error: refusing to write to board.db or board_demo.db. Choose another path.")
        return EXIT_ERROR

    replacing = target.exists()
    if replacing:
        out(f"It already exists: {describe_existing(target)}")
        if sidecar_files(target):
            out("Error: SQLite journal files exist next to it, so it may still be in use. "
                "Stop Flask (Ctrl+C) and try again. Nothing was changed.")
            return EXIT_ERROR
        try:
            answer = ask(f"Type {CONFIRM_WORD} to back it up and replace it with an empty demo, or anything else to cancel: ")
        except (EOFError, KeyboardInterrupt):
            answer = ""
        if answer.strip() != CONFIRM_WORD:
            out("Cancelled. Nothing was changed.")
            return EXIT_CANCELLED

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    try:
        for leftover in (tmp, *sidecar_files(tmp)):
            leftover.unlink(missing_ok=True)
        build_empty(tmp)
        board, schedule = verify(tmp)
        saved = backup(target) if replacing else None
        os.replace(tmp, target)  # atomic: the target is either the old or the new file
    except (EmptyDemoError, sqlite3.Error, OSError) as e:
        out(f"Error: {e}")
        out("The existing database was not changed." if replacing else "No database was created.")
        return EXIT_ERROR
    finally:
        for leftover in (tmp, *sidecar_files(tmp)):
            try:
                leftover.unlink(missing_ok=True)
            except OSError:
                pass

    if saved:
        out(f"Backed up the previous file to: {saved}")
    out(f"{'Replaced' if replacing else 'Created'} the empty demo: {len(board['members'])} members, "
        f"{len(schedule['gpus'])} GPUs, 0 tasks, 0 task dependencies, 0 GPU bookings.")
    return EXIT_OK


def main(argv=None, ask=input, out=print):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=EMPTY_DEMO_DB_PATH,
                        help="output path (default: backend/data/board_empty_demo.db)")
    return create(parser.parse_args(argv).db, ask=ask, out=out)


if __name__ == "__main__":
    sys.exit(main())
