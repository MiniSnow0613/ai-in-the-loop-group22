import sqlite3

import pytest

import seed_demo
from app import DEFAULT_DB_PATH, compute_rows, create_app


def make_client(tmp_path):
    return create_app(tmp_path / "test.db").test_client()


def task(board, task_id):
    return next(t for t in board["tasks"] if t["id"] == task_id)


def ids(refs):
    return [r["id"] for r in refs]


def patch(client, task_id, **body):
    return client.patch(f"/api/tasks/{task_id}", json=body)


# ---------- example board (two cards) ----------

def test_seeds_example_tasks_with_dependency(tmp_path):
    board = make_client(tmp_path).get("/api/board").get_json()
    assert [m["id"] for m in board["members"]] == ["member-a", "member-b"]
    update = task(board, "example-update-dataset")
    train = task(board, "example-train-model")
    assert update["isExample"] and train["isExample"]
    assert update["assigneeId"] is None and train["assigneeId"] is None
    assert ids(train["prerequisites"]) == ["example-update-dataset"]
    assert ids(update["dependents"]) == ["example-train-model"]
    assert train["blocked"] is True and train["pendingCount"] == 1
    assert train["stateText"] == "Waiting for dataset update"


def test_assign_keeps_id_and_waiting_state(tmp_path):
    client = make_client(tmp_path)
    resp = patch(client, "example-train-model", assigneeId="member-b")
    assert resp.status_code == 200
    train = task(resp.get_json(), "example-train-model")
    assert train["assigneeId"] == "member-b"
    assert ids(train["prerequisites"]) == ["example-update-dataset"]
    assert train["stateText"] == "Waiting for dataset update"


def test_cannot_finish_blocked_task(tmp_path):
    assert patch(make_client(tmp_path), "example-train-model", status="done").status_code == 409


def test_completing_dataset_unblocks_training(tmp_path):
    client = make_client(tmp_path)
    patch(client, "example-update-dataset", status="done")
    board = client.get("/api/board").get_json()
    assert task(board, "example-update-dataset")["status"] == "done"
    train = task(board, "example-train-model")
    assert train["blocked"] is False
    assert train["stateText"] == "Ready"
    assert train["prerequisites"][0]["status"] == "done"


def test_state_survives_restart_and_seed_runs_once(tmp_path):
    db = tmp_path / "persist.db"
    patch(create_app(db).test_client(), "example-update-dataset", assigneeId="member-a", status="done")

    board = create_app(db).test_client().get("/api/board").get_json()  # simulate restart
    assert len(board["tasks"]) == 2
    update = task(board, "example-update-dataset")
    assert update["assigneeId"] == "member-a" and update["status"] == "done"
    assert ids(task(board, "example-train-model")["prerequisites"]) == ["example-update-dataset"]


def test_cannot_reopen_task_while_dependent_is_done(tmp_path):
    client = make_client(tmp_path)
    patch(client, "example-update-dataset", status="done")
    patch(client, "example-train-model", status="done")
    assert patch(client, "example-update-dataset", status="todo").status_code == 409
    # Reopening in dependency order works.
    assert patch(client, "example-train-model", status="todo").status_code == 200
    assert patch(client, "example-update-dataset", status="todo").status_code == 200


def test_example_tasks_have_description(tmp_path):
    board = make_client(tmp_path).get("/api/board").get_json()
    for t in board["tasks"]:
        assert t["description"]
        assert t["summary"] is None


def test_rows_follow_dependencies_not_assignment_or_status(tmp_path):
    client = make_client(tmp_path)
    rows = lambda b: {t["id"]: t["row"] for t in b["tasks"]}
    expected = {"example-update-dataset": 1, "example-train-model": 2}

    # Training assigned to B while the dataset task is still in the pool.
    board = patch(client, "example-train-model", assigneeId="member-b").get_json()
    assert rows(board) == expected
    assert task(board, "example-train-model")["stateText"] == "Waiting for dataset update"

    board = patch(client, "example-update-dataset", assigneeId="member-a").get_json()
    assert rows(board) == expected

    board = patch(client, "example-update-dataset", status="done").get_json()
    assert rows(board) == expected
    assert task(board, "example-train-model")["stateText"] == "Ready"


def test_rejects_unknown_member(tmp_path):
    assert patch(make_client(tmp_path), "example-train-model", assigneeId="nobody").status_code == 400


# ---------- upgrading databases from earlier CP2 versions ----------

LEGACY_SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, is_example INTEGER NOT NULL DEFAULT 0,
    assignee_id TEXT REFERENCES members(id), status TEXT NOT NULL DEFAULT 'todo',
    depends_on TEXT REFERENCES tasks(id), waiting_text TEXT,
    position INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
INSERT INTO meta VALUES ('seeded', '2026-11-15T00:00:00+00:00');
INSERT INTO members VALUES ('member-a', 'Member A', 0), ('member-b', 'Member B', 1);
INSERT INTO tasks VALUES
  ('example-update-dataset', 'Update dataset', 1, 'member-a', 'done', NULL, NULL, 0, 't'),
  ('example-train-model', 'Train model', 1, 'member-b', 'todo', 'example-update-dataset', 'Waiting for dataset update', 1, 't');
"""


def make_legacy_db(path):
    """A database as written by the first CP2 version (depends_on, no description)."""
    conn = sqlite3.connect(path)
    conn.executescript(LEGACY_SCHEMA)
    conn.close()


def test_upgrades_legacy_database(tmp_path):
    db = tmp_path / "legacy.db"
    make_legacy_db(db)

    board = create_app(db).test_client().get("/api/board").get_json()
    assert len(board["tasks"]) == 2  # no example cards re-seeded
    update, train = task(board, "example-update-dataset"), task(board, "example-train-model")
    assert (update["assigneeId"], update["status"]) == ("member-a", "done")
    assert (train["assigneeId"], train["status"]) == ("member-b", "todo")
    assert ids(train["prerequisites"]) == ["example-update-dataset"]
    assert ids(update["dependents"]) == ["example-train-model"]
    assert train["description"]  # description column added and filled
    assert train["stateText"] == "Ready" and train["row"] == 2

    # Restart: still one dependency, nothing duplicated.
    board = create_app(db).test_client().get("/api/board").get_json()
    assert ids(task(board, "example-train-model")["prerequisites"]) == ["example-update-dataset"]
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM task_dependencies").fetchone()[0] == 1
    conn.close()


def test_legacy_migration_runs_only_once(tmp_path):
    db = tmp_path / "legacy.db"
    make_legacy_db(db)
    create_app(db)
    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM task_dependencies")  # e.g. removed by a future editor
    conn.commit()
    conn.close()

    board = create_app(db).test_client().get("/api/board").get_json()
    assert task(board, "example-train-model")["prerequisites"] == []


# ---------- multiple prerequisites (demo scenario) ----------

@pytest.fixture
def demo(tmp_path):
    db = tmp_path / "demo.db"
    seed_demo.build(db)
    return create_app(db).test_client()


def test_demo_integration_waits_for_all_prerequisites(demo):
    board = demo.get("/api/board").get_json()
    integ = task(board, "demo-integrate-chatbot")
    assert integ["assigneeId"] is None
    assert [(p["title"], p["assigneeName"], p["status"]) for p in integ["prerequisites"]] == [
        ("Build Task Pool UI", "Member A", "done"),
        ("Build task creation API", "Member B", "todo"),
        ("Connect AI task suggestions", "Member C", "todo"),
    ]
    assert integ["pendingCount"] == 2 and integ["stateText"] == "Waiting for 2 prerequisites"
    assert patch(demo, "demo-integrate-chatbot", status="done").status_code == 409

    # The three prerequisites can each start on their own.
    for tid in ("demo-create-api", "demo-ai-suggest"):
        assert task(board, tid)["stateText"] == "Ready"
    assert "demo-integrate-chatbot" in ids(task(board, "demo-ai-suggest")["dependents"])

    board = patch(demo, "demo-create-api", status="done").get_json()
    integ = task(board, "demo-integrate-chatbot")
    assert integ["pendingCount"] == 1
    assert integ["stateText"] == "Waiting for Member C: Connect AI task suggestions"
    assert patch(demo, "demo-integrate-chatbot", status="done").status_code == 409

    board = patch(demo, "demo-ai-suggest", status="done").get_json()
    integ = task(board, "demo-integrate-chatbot")
    assert integ["blocked"] is False and integ["stateText"] == "Ready"
    # D's GPU work is unrelated and still unfinished.
    assert task(board, "demo-gpu-overlap")["status"] == "todo"
    assert patch(demo, "demo-integrate-chatbot", status="done").status_code == 200


def test_demo_rows_use_latest_prerequisite_and_stay_put(demo):
    rows = lambda: {t["id"]: t["row"] for t in demo.get("/api/board").get_json()["tasks"]}
    before = rows()
    assert before["demo-integrate-chatbot"] == 1 + max(
        before[p] for p in ("demo-pool-ui", "demo-create-api", "demo-ai-suggest")
    )
    patch(demo, "demo-create-api", status="done")
    patch(demo, "demo-integrate-chatbot", assigneeId="member-d")
    assert rows() == before


def test_reopen_blocked_by_any_done_dependent(demo):
    patch(demo, "demo-create-api", status="done")
    patch(demo, "demo-ai-suggest", status="done")
    patch(demo, "demo-integrate-chatbot", status="done")
    resp = patch(demo, "demo-pool-ui", status="todo")
    assert resp.status_code == 409 and "Integrate Chatbot into Task Pool" in resp.get_json()["error"]


def test_english_waiting_text_and_errors(demo):
    # Prerequisite moved back to the pool: no owner to name.
    board = patch(demo, "demo-create-api", assigneeId=None).get_json()
    assert task(board, "demo-prereq-select")["stateText"] == "Waiting for “Build task creation API”"

    resp = patch(demo, "demo-integrate-chatbot", status="done")
    assert resp.status_code == 409
    assert resp.get_json()["error"] == (
        "Cannot complete this task yet. Unfinished prerequisites: "
        "“Build task creation API”, “Connect AI task suggestions”."
    )
    assert patch(demo, "demo-pool-ui", assigneeId="nobody").get_json()["error"] == "Unknown member."


def test_demo_seed_layout_and_reset(tmp_path):
    db = tmp_path / "demo.db"
    seed_demo.build(db)
    client = create_app(db).test_client()
    board = client.get("/api/board").get_json()
    assert [m["name"] for m in board["members"]] == ["Member A", "Member B", "Member C", "Member D"]
    assert len(board["tasks"]) == 13  # no example cards added by init_db
    pool = {t["title"] for t in board["tasks"] if t["assigneeId"] is None}
    assert pool == {"Integrate Chatbot into Task Pool", "Add prerequisite picker",
                    "Write 10 prompt test cases", "Test and document GPU conflict cases"}

    # Change things, then reset: same starting point again.
    patch(client, "demo-create-api", status="done")
    patch(client, "demo-integrate-chatbot", assigneeId="member-b")
    seed_demo.build(db)
    assert create_app(db).test_client().get("/api/board").get_json() == board


def test_demo_seed_refuses_main_database():
    with pytest.raises(SystemExit):
        seed_demo.build(DEFAULT_DB_PATH)


# ---------- compute_rows ----------

def test_compute_rows_chain_and_independent():
    prereqs = {"a": [], "b": ["a"], "c": ["b"], "x": [], "y": ["a"]}
    assert compute_rows(prereqs) == {"a": 1, "b": 2, "c": 3, "x": 1, "y": 2}


def test_compute_rows_multiple_prerequisites_use_latest():
    prereqs = {"a": [], "b": ["a"], "c": ["b"], "x": [], "m": ["x", "c", "a"]}
    assert compute_rows(prereqs)["m"] == 4


def test_compute_rows_survives_cycle():
    rows = compute_rows({"a": ["b"], "b": ["a"]})
    assert set(rows) == {"a", "b"} and all(r >= 1 for r in rows.values())
