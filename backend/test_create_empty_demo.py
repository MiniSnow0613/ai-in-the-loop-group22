"""create_empty_demo.py. Every test writes to its own temporary folder; the
real board.db, board_demo.db and board_empty_demo.db are never written."""
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import app
import create_empty_demo
import seed_demo

REPO_ROOT = Path(__file__).resolve().parent.parent


def query(db, sql):
    conn = sqlite3.connect(db)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def snapshot(db):
    conn = sqlite3.connect(db)
    try:
        tables = sorted(r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'"))
        return {t: sorted(conn.execute(f'SELECT * FROM "{t}"').fetchall(), key=repr) for t in tables}
    finally:
        conn.close()


def run(db, answer=None):
    lines, asked = [], []

    def ask(prompt):
        asked.append(prompt)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    code = create_empty_demo.main(["--db", str(db)], ask=ask, out=lines.append)
    return code, "\n".join(lines), asked


def client_for(db):
    return app.create_app(db, gpu_detector=lambda: []).test_client()


def make_existing(db):
    """A previously used empty demo: one reviewer task and one booking."""
    assert run(db)[0] == create_empty_demo.EXIT_OK
    client = client_for(db)
    assert client.post("/api/tasks", json={"title": "Reviewer task"}).status_code in (200, 201)
    resp = client.post("/api/gpu-bookings", json={"gpuId": "demo-gpu-0", "label": "Review run",
                                                    "startAt": "2026-12-01T09:00", "endAt": "2026-12-01T10:00"})
    assert resp.status_code in (200, 201), resp.get_json()
    return snapshot(db)


def backups(folder):
    return sorted(folder.glob("*.backup-*.db"))


# ---------- creating a new empty demo ----------

def test_default_path():
    assert create_empty_demo.EMPTY_DEMO_DB_PATH == (Path(app.__file__).resolve().parent / "data" / "board_empty_demo.db")


def test_creates_empty_demo_with_demo_members_and_gpus(tmp_path):
    db = tmp_path / "board_empty_demo.db"
    code, output, asked = run(db)
    assert code == create_empty_demo.EXIT_OK, output
    assert asked == []  # nothing to replace, so no confirmation needed
    assert "0 tasks, 0 task dependencies, 0 GPU bookings" in output

    assert query(db, "SELECT id, name FROM members ORDER BY position") == list(seed_demo.MEMBERS)
    assert query(db, "SELECT id, name, memory_gb FROM gpus ORDER BY position") == list(seed_demo.GPUS)
    for table in ("tasks", "task_dependencies", "gpu_bookings"):
        assert query(db, f"SELECT COUNT(*) FROM {table}") == [(0,)]
    flags = {k for (k,) in query(db, "SELECT key FROM meta")}
    assert {"seeded", "gpus_seeded", "dependencies_migrated"} <= flags
    assert not list(tmp_path.glob("*.tmp-*"))


def test_flask_restart_keeps_board_empty(tmp_path):
    db = tmp_path / "board_empty_demo.db"
    run(db)
    for _ in range(2):  # two starts: init_db must not add example tasks or the default GPU
        client = client_for(db)
        board = client.get("/api/board").get_json()
        schedule = client.get("/api/gpus").get_json()
        assert board["tasks"] == []
        assert [m["name"] for m in board["members"]] == [m[1] for m in seed_demo.MEMBERS]
        assert sorted(g["id"] for g in schedule["gpus"]) == ["demo-gpu-0", "demo-gpu-1"]
        assert schedule["bookings"] == []


def test_empty_demo_is_usable_by_the_app(tmp_path):
    db = tmp_path / "board_empty_demo.db"
    run(db)
    client = client_for(db)
    first = client.post("/api/tasks", json={"title": "Collect data"}).get_json()["createdId"]
    second = client.post("/api/tasks", json={"title": "Train model", "prerequisites": [first]}).get_json()["createdId"]
    board = client.patch(f"/api/tasks/{second}", json={"assigneeId": "member-c"}).get_json()
    train = next(t for t in board["tasks"] if t["id"] == second)
    assert train["assigneeId"] == "member-c" and train["row"] == 2 and train["blocked"] is True
    resp = client.post("/api/gpu-bookings", json={"gpuId": "demo-gpu-1", "taskId": first,
                                                    "startAt": "2026-12-01T09:00", "endAt": "2026-12-01T12:00"})
    assert resp.status_code in (200, 201), resp.get_json()
    assert len(client.get("/api/gpus").get_json()["bookings"]) == 1


# ---------- an existing empty demo ----------

@pytest.mark.parametrize("answer", ["", "replace", "yes", "RESET", EOFError(), KeyboardInterrupt()])
def test_existing_file_is_kept_unless_replace_is_typed(tmp_path, answer):
    db = tmp_path / "board_empty_demo.db"
    before = make_existing(db)
    code, output, asked = run(db, answer)
    assert code == create_empty_demo.EXIT_CANCELLED
    assert "already exists: tasks 1" in output and "gpu_bookings 1" in output
    assert len(asked) == 1 and "REPLACE" in asked[0]
    assert snapshot(db) == before
    assert backups(tmp_path) == []


def test_replace_backs_up_then_recreates(tmp_path):
    db = tmp_path / "board_empty_demo.db"
    before = make_existing(db)
    code, output, _ = run(db, "REPLACE")
    assert code == create_empty_demo.EXIT_OK, output
    [saved] = backups(tmp_path)
    assert f"Backed up the previous file to: {saved}" in output
    assert snapshot(saved) == before  # the reviewer's data is recoverable
    for table in ("tasks", "task_dependencies", "gpu_bookings"):
        assert query(db, f"SELECT COUNT(*) FROM {table}") == [(0,)]
    assert len(query(db, "SELECT id FROM members")) == 4


def test_failed_build_leaves_existing_file_untouched(tmp_path, monkeypatch):
    db = tmp_path / "board_empty_demo.db"
    before = make_existing(db)

    def broken(path):
        raise create_empty_demo.EmptyDemoError("simulated verification failure")

    monkeypatch.setattr(create_empty_demo, "verify", broken)
    code, output, _ = run(db, "REPLACE")
    assert code == create_empty_demo.EXIT_ERROR and "simulated" in output
    assert "The existing database was not changed." in output
    assert snapshot(db) == before
    assert backups(tmp_path) == [] and not list(tmp_path.glob("*.tmp-*"))


def test_failed_swap_leaves_existing_file_untouched(tmp_path, monkeypatch):
    """E.g. Windows refuses the move because the file is open."""
    db = tmp_path / "board_empty_demo.db"
    before = make_existing(db)

    def refuse(src, dst):
        raise PermissionError("file is in use")

    monkeypatch.setattr(create_empty_demo.os, "replace", refuse)
    code, output, _ = run(db, "REPLACE")
    assert code == create_empty_demo.EXIT_ERROR and "file is in use" in output
    assert snapshot(db) == before
    assert not list(tmp_path.glob("*.tmp-*"))


def test_refuses_while_sqlite_journal_exists(tmp_path):
    db = tmp_path / "board_empty_demo.db"
    before = make_existing(db)
    Path(f"{db}-journal").write_bytes(b"")
    code, output, asked = run(db, "REPLACE")
    assert code == create_empty_demo.EXIT_ERROR and "Stop Flask" in output
    assert asked == [] and snapshot(db) == before


@pytest.mark.parametrize("protected", [app.DEFAULT_DB_PATH, seed_demo.DEMO_DB_PATH])
def test_refuses_main_and_demo_databases(protected):
    stat_before = protected.stat() if protected.exists() else None
    code, output, asked = run(protected, "REPLACE")
    assert code == create_empty_demo.EXIT_ERROR and "refusing" in output
    assert asked == []
    if stat_before:
        after = protected.stat()
        assert (after.st_size, after.st_mtime_ns) == (stat_before.st_size, stat_before.st_mtime_ns)


def test_runs_from_project_root_as_a_script(tmp_path):
    db = tmp_path / "board_empty_demo.db"
    script = Path("backend") / "create_empty_demo.py"
    done = subprocess.run([sys.executable, str(script), "--db", str(db)], cwd=REPO_ROOT,
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == create_empty_demo.EXIT_OK, done.stdout + done.stderr
    assert query(db, "SELECT COUNT(*) FROM members") == [(4,)]

    again = subprocess.run([sys.executable, str(script), "--db", str(db)], cwd=REPO_ROOT,
                           input="no\n", capture_output=True, text=True, timeout=120)
    assert again.returncode == create_empty_demo.EXIT_CANCELLED
