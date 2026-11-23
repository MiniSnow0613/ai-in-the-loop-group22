"""GPU list and booking rules (see gpu.py)."""
import sqlite3

import pytest

import seed_demo
from app import create_app
from gpu import GpuError


def detector_with(found):
    return lambda: found


@pytest.fixture
def client(tmp_path):
    return create_app(tmp_path / "gpu.db", gpu_detector=detector_with([])).test_client()


def schedule(client):
    return client.get("/api/gpus").get_json()


def add_gpu(client, name, memory=None):
    resp = client.post("/api/gpus", json={"name": name, "memoryGb": memory})
    assert resp.status_code == 200, resp.get_json()
    return next(g["id"] for g in resp.get_json()["schedule"]["gpus"] if g["name"] == name)


def book(client, gpu_id, start, end, task_id=None, label=None):
    body = {"gpuId": gpu_id, "startAt": start, "endAt": end}
    if task_id:
        body["taskId"] = task_id
    if label:
        body["label"] = label
    return client.post("/api/gpu-bookings", json=body)


def booking_id(resp):
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()["bookingId"]


def card(board, task_id):
    return next(t for t in board["tasks"] if t["id"] == task_id)


DAY = "2026-11-16"


# ---------- default GPU ----------

def test_new_board_has_one_gpu_and_no_bookings(client):
    data = schedule(client)
    assert [g["name"] for g in data["gpus"]] == ["GPU 0"]
    assert data["gpus"][0]["active"] is True
    assert data["bookings"] == []


def test_default_gpu_seeded_once(tmp_path):
    db = tmp_path / "once.db"
    c = create_app(db).test_client()
    gid = schedule(c)["gpus"][0]["id"]
    add_gpu(c, "GPU 1")
    c.delete(f"/api/gpus/{gid}")
    assert [g["name"] for g in schedule(create_app(db).test_client())["gpus"]] == ["GPU 1"]


def test_board_cards_report_gpu_fields(client):
    board = client.get("/api/board").get_json()
    for t in board["tasks"]:
        assert t["needsGpu"] is False and t["gpuBooking"] is None


# ---------- overlap check ----------

def test_overlap_on_same_gpu_is_rejected(client):
    gid = schedule(client)["gpus"][0]["id"]
    booking_id(book(client, gid, f"{DAY}T14:00", f"{DAY}T20:00", label="Lab job"))
    for start, end in [("13:00", "15:00"), ("19:00", "21:00"), ("15:00", "16:00"), ("12:00", "22:00")]:
        resp = book(client, gid, f"{DAY}T{start}", f"{DAY}T{end}", label="Other")
        assert resp.status_code == 409, (start, end)
        body = resp.get_json()
        assert body["code"] == "overlap" and "Lab job" in body["error"]


def test_touching_boundaries_do_not_overlap(client):
    gid = schedule(client)["gpus"][0]["id"]
    booking_id(book(client, gid, f"{DAY}T14:00", f"{DAY}T20:00", label="Middle"))
    booking_id(book(client, gid, f"{DAY}T09:00", f"{DAY}T14:00", label="Before"))
    booking_id(book(client, gid, f"{DAY}T20:00", f"{DAY}T22:00", label="After"))
    assert len(schedule(client)["bookings"]) == 3


def test_other_gpu_is_independent(client):
    g0 = schedule(client)["gpus"][0]["id"]
    g1 = add_gpu(client, "GPU 1", 24)
    booking_id(book(client, g0, f"{DAY}T14:00", f"{DAY}T20:00", label="A"))
    booking_id(book(client, g1, f"{DAY}T14:00", f"{DAY}T20:00", label="B"))


def test_overnight_booking_conflicts_next_morning(client):
    gid = schedule(client)["gpus"][0]["id"]
    booking_id(book(client, gid, f"{DAY}T22:00", "2026-11-17T06:00", label="Overnight"))
    assert book(client, gid, "2026-11-17T05:00", "2026-11-17T07:00", label="Early").status_code == 409
    booking_id(book(client, gid, "2026-11-17T06:00", "2026-11-17T07:00", label="Early"))


def test_done_and_cancelled_bookings_free_the_slot(client):
    c = client
    gid = schedule(c)["gpus"][0]["id"]
    first = booking_id(book(c, gid, f"{DAY}T10:00", f"{DAY}T12:00", label="First"))
    c.patch(f"/api/gpu-bookings/{first}", json={"status": "running"})
    assert c.patch(f"/api/gpu-bookings/{first}", json={"status": "done"}).status_code == 200
    second = booking_id(book(c, gid, f"{DAY}T10:00", f"{DAY}T12:00", label="Second"))
    assert c.delete(f"/api/gpu-bookings/{second}").status_code == 200
    booking_id(book(c, gid, f"{DAY}T10:00", f"{DAY}T12:00", label="Third"))


def test_invalid_times_rejected(client):
    gid = schedule(client)["gpus"][0]["id"]
    assert book(client, gid, f"{DAY}T12:00", f"{DAY}T12:00", label="x").status_code == 400
    assert book(client, gid, f"{DAY}T12:00", f"{DAY}T10:00", label="x").status_code == 400
    assert book(client, gid, "tomorrow", f"{DAY}T10:00", label="x").status_code == 400
    assert book(client, gid, f"{DAY}T12:00+08:00", f"{DAY}T13:00", label="x").status_code == 400
    assert book(client, gid, f"{DAY}T00:00", "2026-12-16T00:00", label="x").status_code == 400
    assert book(client, gid, f"{DAY}T10:00", f"{DAY}T11:00").status_code == 400  # no task, no label
    assert book(client, "nope", f"{DAY}T10:00", f"{DAY}T11:00", label="x").status_code == 404


def test_moving_a_booking_rechecks_overlap(client):
    gid = schedule(client)["gpus"][0]["id"]
    a = booking_id(book(client, gid, f"{DAY}T08:00", f"{DAY}T10:00", label="A"))
    booking_id(book(client, gid, f"{DAY}T12:00", f"{DAY}T14:00", label="B"))
    assert client.patch(f"/api/gpu-bookings/{a}", json={"endAt": f"{DAY}T13:00"}).status_code == 409
    # Moving within its own slot does not conflict with itself.
    assert client.patch(f"/api/gpu-bookings/{a}", json={"startAt": f"{DAY}T09:00"}).status_code == 200


# ---------- prerequisites ----------

def test_booking_waits_for_prerequisites_before_running(client):
    gid = schedule(client)["gpus"][0]["id"]
    resp = book(client, gid, f"{DAY}T14:00", f"{DAY}T20:00", task_id="example-train-model")
    bid = booking_id(resp)
    assert "unfinished prerequisites" in resp.get_json()["warning"]
    train = card(resp.get_json()["board"], "example-train-model")
    assert train["needsGpu"] is True
    assert train["gpuBooking"]["id"] == bid and train["gpuBooking"]["taskBlocked"] is True

    resp = client.patch(f"/api/gpu-bookings/{bid}", json={"status": "running"})
    assert resp.status_code == 409 and resp.get_json()["code"] == "prerequisites"
    assert "Update dataset" in resp.get_json()["error"]

    client.patch("/api/tasks/example-update-dataset", json={"status": "done"})
    resp = client.patch(f"/api/gpu-bookings/{bid}", json={"status": "running"})
    assert resp.status_code == 200
    assert card(resp.get_json()["board"], "example-train-model")["gpuBooking"]["status"] == "running"
    assert client.delete(f"/api/gpu-bookings/{bid}").status_code == 409  # running: finish first


def test_task_can_have_several_bookings_and_counts_hours(client):
    gid = schedule(client)["gpus"][0]["id"]
    booking_id(book(client, gid, f"{DAY}T08:00", f"{DAY}T10:00", task_id="example-update-dataset"))
    resp = book(client, gid, f"{DAY}T12:00", f"{DAY}T15:30", task_id="example-update-dataset")
    booking_id(resp)
    assert card(resp.get_json()["board"], "example-update-dataset")["bookedGpuHours"] == 5.5


def test_cannot_book_completed_task(client):
    client.patch("/api/tasks/example-update-dataset", json={"status": "done"})
    gid = schedule(client)["gpus"][0]["id"]
    assert book(client, gid, f"{DAY}T08:00", f"{DAY}T10:00", task_id="example-update-dataset").status_code == 409


def test_status_transitions(client):
    gid = schedule(client)["gpus"][0]["id"]
    bid = booking_id(book(client, gid, f"{DAY}T08:00", f"{DAY}T10:00", label="Job"))
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"status": "done"}).status_code == 409
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"status": "running"}).status_code == 200
    # A running job can run longer or shorter, but not move.
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"endAt": f"{DAY}T11:00"}).status_code == 200
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"startAt": f"{DAY}T09:00"}).status_code == 409
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"status": "done"}).status_code == 200
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"status": "running"}).status_code == 409
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"endAt": f"{DAY}T12:00"}).status_code == 409


def test_running_job_end_cannot_overlap_next_booking(client):
    gid = schedule(client)["gpus"][0]["id"]
    bid = booking_id(book(client, gid, f"{DAY}T08:00", f"{DAY}T10:00", label="Job"))
    booking_id(book(client, gid, f"{DAY}T12:00", f"{DAY}T14:00", label="Next"))
    client.patch(f"/api/gpu-bookings/{bid}", json={"status": "running"})
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"endAt": f"{DAY}T13:00"}).status_code == 409
    assert client.patch(f"/api/gpu-bookings/{bid}", json={"endAt": f"{DAY}T12:00"}).status_code == 200


def test_moving_to_another_gpu_checks_that_gpu(client):
    g0 = schedule(client)["gpus"][0]["id"]
    g1 = add_gpu(client, "GPU 1")
    moving = booking_id(book(client, g0, f"{DAY}T08:00", f"{DAY}T10:00", label="Moving"))
    booking_id(book(client, g1, f"{DAY}T09:00", f"{DAY}T11:00", label="There"))
    resp = client.patch(f"/api/gpu-bookings/{moving}", json={"gpuId": g1})
    assert resp.status_code == 409 and "There" in resp.get_json()["error"]
    resp = client.patch(f"/api/gpu-bookings/{moving}",
                        json={"gpuId": g1, "startAt": f"{DAY}T11:00", "endAt": f"{DAY}T13:00"})
    assert resp.status_code == 200
    moved = next(b for b in resp.get_json()["schedule"]["bookings"] if b["id"] == moving)
    assert (moved["gpuId"], moved["startAt"], moved["endAt"]) == (g1, f"{DAY}T11:00", f"{DAY}T13:00")


def test_needs_gpu_flag(client):
    resp = client.patch("/api/tasks/example-train-model", json={"needsGpu": True})
    assert resp.status_code == 200 and card(resp.get_json(), "example-train-model")["needsGpu"] is True
    assert client.patch("/api/tasks/example-train-model", json={"needsGpu": "yes"}).status_code == 400

    gid = schedule(client)["gpus"][0]["id"]
    bid = booking_id(book(client, gid, f"{DAY}T08:00", f"{DAY}T10:00", task_id="example-train-model"))
    assert client.patch("/api/tasks/example-train-model", json={"needsGpu": False}).status_code == 409
    client.delete(f"/api/gpu-bookings/{bid}")
    resp = client.patch("/api/tasks/example-train-model", json={"needsGpu": False})
    assert card(resp.get_json(), "example-train-model")["needsGpu"] is False


# ---------- managing GPUs ----------

def test_add_rename_and_validate_gpus(client):
    gid = add_gpu(client, "lab-server / GPU 1", 24)
    assert client.post("/api/gpus", json={"name": "lab-server / GPU 1"}).status_code == 409
    assert client.post("/api/gpus", json={"name": "  "}).status_code == 400
    assert client.post("/api/gpus", json={"name": "x", "memoryGb": 0}).status_code == 400
    assert client.post("/api/gpus", json={"name": "x", "memoryGb": 1.5}).status_code == 400
    resp = client.patch(f"/api/gpus/{gid}", json={"name": "lab-server / RTX 4090", "memoryGb": 24})
    gpu = next(g for g in resp.get_json()["schedule"]["gpus"] if g["id"] == gid)
    assert gpu["name"] == "lab-server / RTX 4090" and gpu["memoryGb"] == 24


def test_deactivated_gpu_keeps_bookings_but_takes_no_new_ones(client):
    g0 = schedule(client)["gpus"][0]["id"]
    g1 = add_gpu(client, "GPU 1")
    booking_id(book(client, g1, f"{DAY}T08:00", f"{DAY}T10:00", label="Kept"))
    assert client.patch(f"/api/gpus/{g1}", json={"active": False}).status_code == 200
    assert book(client, g1, f"{DAY}T12:00", f"{DAY}T14:00", label="New").status_code == 409
    assert [b["label"] for b in schedule(client)["bookings"]] == ["Kept"]
    # The last active GPU cannot be switched off.
    assert client.patch(f"/api/gpus/{g0}", json={"active": False}).status_code == 409


def test_gpu_with_upcoming_bookings_cannot_be_deleted(client):
    g0 = schedule(client)["gpus"][0]["id"]
    g1 = add_gpu(client, "GPU 1")
    bid = booking_id(book(client, g1, f"{DAY}T08:00", f"{DAY}T10:00", label="Job"))
    resp = client.delete(f"/api/gpus/{g1}")
    assert resp.status_code == 409 and "1 planned or running booking" in resp.get_json()["error"]
    client.delete(f"/api/gpu-bookings/{bid}")
    assert client.delete(f"/api/gpus/{g1}").status_code == 200
    assert client.delete(f"/api/gpus/{g0}").status_code == 409  # last active GPU


def test_detect_adds_only_new_gpus(tmp_path):
    found = [("host / GPU 0", 24), ("host / GPU 1", 80)]
    c = create_app(tmp_path / "d.db", gpu_detector=detector_with(found)).test_client()
    body = c.post("/api/gpus/detect").get_json()
    assert body["found"] == 2 and body["added"] == ["host / GPU 0", "host / GPU 1"]
    assert c.post("/api/gpus/detect").get_json()["added"] == []


def test_detect_without_nvidia_smi(tmp_path):
    def missing():
        raise GpuError("nvidia-smi was not found on this machine.", 404, code="no_nvidia_smi")

    c = create_app(tmp_path / "n.db", gpu_detector=missing).test_client()
    resp = c.post("/api/gpus/detect")
    assert resp.status_code == 404 and resp.get_json()["code"] == "no_nvidia_smi"


# ---------- older databases and the demo board ----------

def test_existing_database_gets_gpu_tables(tmp_path):
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, is_example INTEGER NOT NULL DEFAULT 0,
            assignee_id TEXT, status TEXT NOT NULL DEFAULT 'todo', waiting_text TEXT,
            position INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
            description TEXT, summary TEXT);
        CREATE TABLE task_dependencies (task_id TEXT, prerequisite_id TEXT, PRIMARY KEY (task_id, prerequisite_id));
        INSERT INTO meta VALUES ('seeded', 't'), ('dependencies_migrated', 't');
        INSERT INTO tasks VALUES ('t1', 'Old task', 0, NULL, 'todo', NULL, 0, 't', NULL, NULL);
        """
    )
    conn.close()
    c = create_app(db).test_client()
    assert card(c.get("/api/board").get_json(), "t1")["needsGpu"] is False
    assert [g["name"] for g in schedule(c)["gpus"]] == ["GPU 0"]


def test_demo_board_has_two_gpus_and_reset_clears_bookings(tmp_path):
    db = tmp_path / "demo.db"
    seed_demo.build(db)
    c = create_app(db).test_client()
    gpus = schedule(c)["gpus"]
    assert [g["name"] for g in gpus] == ["lab-server / GPU 0", "lab-server / GPU 1"]
    booking_id(book(c, gpus[0]["id"], f"{DAY}T08:00", f"{DAY}T10:00", task_id="demo-gpu-overlap"))
    seed_demo.build(db)
    data = schedule(create_app(db).test_client())
    assert len(data["gpus"]) == 2 and data["bookings"] == []
