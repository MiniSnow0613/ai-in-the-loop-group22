"""Date-based Timeline through the Task API (app.py + schedule.py).

Every test uses its own temporary database; no development or demo database
is opened.
"""
import sqlite3

import pytest

import seed_demo
from app import create_app


def make(tmp_path):
    return create_app(tmp_path / "board.db", gpu_detector=lambda: []).test_client()


def patch(client, task_id, **body):
    return client.patch(f"/api/tasks/{task_id}", json=body)


def task(board, task_id):
    return next(t for t in board["tasks"] if t["id"] == task_id)


def add(client, title, prerequisites=()):
    resp = client.post("/api/tasks", json={"title": title, "prerequisites": list(prerequisites)})
    assert resp.status_code == 201, resp.get_json()
    return resp.get_json()["createdId"]


@pytest.fixture
def chain(tmp_path):
    """data (A, Nov 23-24) -> train (B, Nov 25-27) -> eval (unscheduled)."""
    client = make(tmp_path)
    data = add(client, "Update dataset")
    train = add(client, "Train model", [data])
    ev = add(client, "Evaluate model", [train])
    assert patch(client, data, assigneeId="member-a", plannedStart="2026-11-23", plannedEnd="2026-11-24").status_code == 200
    assert patch(client, train, assigneeId="member-b", plannedStart="2026-11-25", plannedEnd="2026-11-27").status_code == 200
    return client, data, train, ev


def stored(client, task_id):
    return task(client.get("/api/board").get_json(), task_id)


# ---------- fields in the board payload ----------

def test_new_tasks_are_unscheduled(tmp_path):
    client = make(tmp_path)
    for t in client.get("/api/board").get_json()["tasks"]:
        assert (t["plannedStart"], t["plannedEnd"], t["scheduled"], t["workHours"]) == (None, None, False, None)
        assert t["scheduleIssues"] == []
        assert "row" in t  # dependency level is kept for a future graph view


def test_drag_style_assign_and_schedule_in_one_request(tmp_path):
    client = make(tmp_path)
    tid = add(client, "Collect rollouts")
    resp = patch(client, tid, assigneeId="member-b", plannedStart="2026-11-24", plannedEnd="2026-11-24")
    assert resp.status_code == 200
    body = resp.get_json()
    t = task(body, tid)
    assert (t["assigneeId"], t["plannedStart"], t["plannedEnd"], t["scheduled"]) == ("member-b", "2026-11-24", "2026-11-24", True)
    assert body["warnings"] == []
    assert stored(client, tid)["plannedEnd"] == "2026-11-24"  # persisted


def test_dates_are_normalized_and_one_date_can_be_sent_alone(chain):
    client, data, _, _ = chain
    t = task(patch(client, data, plannedEnd=" 2026-11-24 ").get_json(), data)  # start kept as stored
    assert (t["plannedStart"], t["plannedEnd"]) == ("2026-11-23", "2026-11-24")


def test_work_hours_are_independent_of_dates_and_gpu_hours(chain):
    client, data, _, _ = chain
    t = task(patch(client, data, workHours=30).get_json(), data)
    assert t["workHours"] == 30.0
    assert (t["plannedStart"], t["plannedEnd"]) == ("2026-11-23", "2026-11-24")  # 30h does not stretch the range
    assert t["gpuHours"] is None and t["needsGpu"] is False
    t = task(patch(client, data, gpuHours=6).get_json(), data)
    assert (t["workHours"], t["gpuHours"]) == (30.0, 6.0)
    assert task(patch(client, data, workHours=None).get_json(), data)["workHours"] is None


@pytest.mark.parametrize("body, message", [
    ({"plannedStart": "2026-11-25", "plannedEnd": "2026-11-24"}, "before the planned start"),
    ({"plannedStart": "2026/11/24", "plannedEnd": "2026-11-24"}, "YYYY-MM-DD"),
    ({"plannedStart": "2026-02-30", "plannedEnd": "2026-03-01"}, "not a real date"),
    ({"plannedStart": "2026-11-24"}, "Set both"),  # nothing stored yet
    ({"plannedStart": "2026-01-01", "plannedEnd": "2027-06-01"}, "at most 366 days"),
    ({"workHours": -2}, "Work hours"),
    ({"workHours": "many"}, "Work hours"),
])
def test_invalid_schedule_requests_are_rejected_without_saving(tmp_path, body, message):
    client = make(tmp_path)
    tid = add(client, "Collect rollouts")
    before = stored(client, tid)
    resp = patch(client, tid, assigneeId="member-a", **body)
    assert resp.status_code == 400
    assert message in resp.get_json()["error"]
    assert resp.get_json()["code"] in ("invalid_schedule", "invalid_work_hours")
    assert stored(client, tid) == before  # the assignee was not saved either


# ---------- dependency rules ----------

def test_dependent_cannot_start_on_or_before_prerequisite_end(chain):
    client, data, train, _ = chain
    before = stored(client, train)
    resp = patch(client, train, assigneeId="member-a", plannedStart="2026-11-24", plannedEnd="2026-11-26")
    assert resp.status_code == 409
    body = resp.get_json()
    assert body["code"] == "schedule_conflict" and body["error"].startswith("Not saved.")
    assert body["conflicts"][0]["code"] == "starts_before_prerequisite_ends"
    assert "2026-11-25 or later" in body["error"]
    assert stored(client, train) == before  # neither dates nor assignee changed


def test_moving_a_scheduled_task_keeps_rules(chain):
    client, data, train, _ = chain
    resp = patch(client, train, assigneeId="member-a", plannedStart="2026-11-26", plannedEnd="2026-11-28")
    assert resp.status_code == 200
    t = task(resp.get_json(), train)
    assert (t["assigneeId"], t["plannedStart"], t["plannedEnd"]) == ("member-a", "2026-11-26", "2026-11-28")


def test_upstream_task_moved_later_is_checked(chain):
    client, data, train, _ = chain
    resp = patch(client, data, plannedStart="2026-11-23", plannedEnd="2026-11-25")
    assert resp.status_code == 409
    [conflict] = resp.get_json()["conflicts"]
    assert conflict["code"] == "ends_after_dependent_starts" and conflict["taskId"] == train
    assert stored(client, data)["plannedEnd"] == "2026-11-24"
    assert stored(client, train)["plannedStart"] == "2026-11-25"  # nothing rescheduled
    assert patch(client, data, plannedStart="2026-11-20", plannedEnd="2026-11-21").status_code == 200


def test_adding_a_prerequisite_after_dates_are_set_is_checked(chain):
    client, data, train, _ = chain
    report = add(client, "Write report")
    assert patch(client, report, assigneeId="member-a", plannedStart="2026-11-26", plannedEnd="2026-11-26").status_code == 200
    resp = patch(client, report, prerequisites=[train])  # train ends 11-27
    assert resp.status_code == 409 and resp.get_json()["code"] == "schedule_conflict"
    assert stored(client, report)["prerequisites"] == []
    # The edit form sends title + prerequisites together; dropping a prerequisite is fine.
    assert patch(client, report, title="Write weekly report", prerequisites=[data]).status_code == 200


def test_removing_a_prerequisite_is_allowed(chain):
    client, _, train, _ = chain
    resp = patch(client, train, prerequisites=[])
    assert resp.status_code == 200 and task(resp.get_json(), train)["prerequisites"] == []


def test_cycle_detection_still_comes_first(chain):
    client, data, train, _ = chain
    resp = patch(client, data, prerequisites=[train])
    assert resp.status_code == 422 and "Circular dependency" in resp.get_json()["error"]


def test_unscheduled_prerequisite_is_a_warning(chain):
    client, _, train, ev = chain
    assert patch(client, train, plannedStart=None, plannedEnd=None).status_code == 200
    resp = patch(client, ev, assigneeId="member-a", plannedStart="2026-12-01", plannedEnd="2026-12-02")
    assert resp.status_code == 200
    assert [w["code"] for w in resp.get_json()["warnings"]] == ["prerequisite_unscheduled"]


def test_completed_prerequisite_does_not_constrain(chain):
    client, data, train, _ = chain
    assert patch(client, data, status="done").status_code == 200
    assert patch(client, train, plannedStart="2026-11-23", plannedEnd="2026-11-23").status_code == 200


# ---------- clearing dates ----------

def test_clearing_dates_keeps_assignee_dependencies_status_work_and_gpu(chain):
    client, data, train, _ = chain
    patch(client, data, workHours=8, gpuHours=4)
    before = stored(client, data)
    resp = patch(client, data, plannedStart=None, plannedEnd=None)
    assert resp.status_code == 200
    after = task(resp.get_json(), data)
    assert (after["plannedStart"], after["plannedEnd"], after["scheduled"]) == (None, None, False)
    for field in ("assigneeId", "status", "workHours", "gpuHours", "needsGpu", "dependents", "prerequisites"):
        assert after[field] == before[field], field
    # The dependent is warned, on the response and on its card.
    assert [(w["code"], w["taskId"]) for w in resp.get_json()["warnings"]] == [("prerequisite_unscheduled", train)]
    assert [i["code"] for i in task(resp.get_json(), train)["scheduleIssues"]] == ["prerequisite_unscheduled"]


# ---------- overlaps ----------

def test_member_overlap_is_a_warning_and_shown_on_both_cards(chain):
    client, data, _, _ = chain
    report = add(client, "Write report")
    resp = patch(client, report, assigneeId="member-a", plannedStart="2026-11-24", plannedEnd="2026-11-25")
    assert resp.status_code == 200
    assert [w["code"] for w in resp.get_json()["warnings"]] == ["member_overlap"]
    board = resp.get_json()
    assert [i["code"] for i in task(board, report)["scheduleIssues"]] == ["member_overlap"]
    assert [i["code"] for i in task(board, data)["scheduleIssues"]] == ["member_overlap"]


def test_reassigning_only_is_never_blocked_by_an_old_conflict(chain):
    client, data, train, _ = chain
    # A stored conflict appears when a completed prerequisite is reopened.
    patch(client, data, status="done")
    patch(client, train, plannedStart="2026-11-24", plannedEnd="2026-11-26")
    assert patch(client, data, status="todo").status_code == 200  # status stays independent of dates
    issues = stored(client, train)["scheduleIssues"]
    assert [(i["severity"], i["code"]) for i in issues] == [("error", "starts_before_prerequisite_ends")]
    assert patch(client, train, assigneeId="member-a").status_code == 200
    assert patch(client, train, title="Train policy").status_code == 200
    # Changing its dates must fix the conflict, though.
    assert patch(client, train, plannedStart="2026-11-24", plannedEnd="2026-11-27").status_code == 409
    assert patch(client, train, plannedStart="2026-11-25", plannedEnd="2026-11-27").status_code == 200


# ---------- migration and compatibility ----------

def pre_schedule_schema():
    """app.SCHEMA as it was before this change (PR #23 GPU columns, no schedule columns)."""
    import app
    new = ("planned_start", "planned_end", "work_hours", "Date-based Timeline", "scheduled only when",
           "Estimated human work hours")
    lines = [line for line in app.SCHEMA.splitlines() if not any(n in line for n in new)]
    text = "\n".join(lines)
    assert "planned_start" not in text
    return text.replace("gpu_estimate_error  TEXT,\n);", "gpu_estimate_error  TEXT\n);")


def test_migrates_a_database_without_schedule_columns(tmp_path):
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(pre_schedule_schema())
    conn.executescript("""
        INSERT INTO meta VALUES ('seeded', 't'), ('gpus_seeded', 't'), ('dependencies_migrated', 't');
        INSERT INTO members VALUES ('member-a', 'Member A', 0), ('member-b', 'Member B', 1);
        INSERT INTO gpus (id, name, memory_gb, active, position) VALUES ('gpu-0', 'GPU 0', 24, 1, 0);
        INSERT INTO tasks (id, title, assignee_id, status, position, updated_at, needs_gpu, gpu_hours, gpu_hours_source)
            VALUES ('data', 'Update dataset', 'member-a', 'done', 0, 't', 0, NULL, NULL),
                   ('train', 'Train model', 'member-b', 'todo', 1, 't', 1, 6, 'ai');
        INSERT INTO task_dependencies VALUES ('train', 'data');
        INSERT INTO gpu_bookings (id, gpu_id, task_id, label, start_at, end_at, status, created_at, updated_at)
            VALUES ('b1', 'gpu-0', 'train', NULL, '2026-12-01T09:00', '2026-12-01T12:00', 'planned', 't', 't');
    """)
    assert "planned_start" not in {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
    conn.close()

    for _ in range(2):  # upgrade, then a normal restart
        board = create_app(db, gpu_detector=lambda: []).test_client().get("/api/board").get_json()
    conn = sqlite3.connect(db)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
    assert {"planned_start", "planned_end", "work_hours", "gpu_hours", "gpu_hours_source"} <= cols
    counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("tasks", "task_dependencies", "members", "gpu_bookings", "gpus")}
    conn.close()
    assert counts == {"tasks": 2, "task_dependencies": 1, "members": 2, "gpu_bookings": 1, "gpus": 1}
    t = task(board, "train")
    assert (t["assigneeId"], t["gpuHours"], t["gpuHoursSource"], t["bookedGpuHours"]) == ("member-b", 6.0, "ai", 3.0)
    assert (t["plannedStart"], t["plannedEnd"], t["scheduled"], t["workHours"]) == (None, None, False, None)
    assert [p["id"] for p in t["prerequisites"]] == ["data"]


def test_planned_dates_do_not_touch_gpu_bookings(chain):
    client, data, train, _ = chain
    patch(client, train, gpuHours=6)
    resp = client.post("/api/gpu-bookings", json={"gpuId": "gpu-0", "taskId": train,
                                                  "startAt": "2026-12-10T09:00", "endAt": "2026-12-10T12:00"})
    assert resp.status_code in (200, 201), resp.get_json()  # outside the planned days: allowed
    bookings_before = client.get("/api/gpus").get_json()["bookings"]
    assert patch(client, train, plannedStart="2026-11-26", plannedEnd="2026-11-28").status_code == 200
    assert patch(client, train, plannedStart=None, plannedEnd=None).status_code == 200
    assert client.get("/api/gpus").get_json()["bookings"] == bookings_before
    t = stored(client, train)
    assert t["gpuHours"] == 6.0 and t["bookedGpuHours"] == 3.0


def test_demo_seed_is_scheduled_without_conflicts(tmp_path):
    from datetime import date
    db = tmp_path / "demo.db"
    seed_demo.build(db, today=date(2026, 11, 25))  # a Wednesday
    board = create_app(db, gpu_detector=lambda: []).test_client().get("/api/board").get_json()
    errors = [i for t in board["tasks"] for i in t["scheduleIssues"] if i["severity"] == "error"]
    assert errors == []
    unscheduled = {t["title"] for t in board["tasks"] if not t["scheduled"]}
    assert unscheduled == {"Integrate Chatbot into Task Pool", "Add prerequisite picker",
                           "Write 10 prompt test cases", "Test and document GPU conflict cases"}
    ai = task(board, "demo-ai-suggest")
    assert (ai["plannedStart"], ai["plannedEnd"]) == ("2026-11-23", "2026-11-26")  # Mon-Thu of that week
