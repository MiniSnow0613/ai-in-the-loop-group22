"""Tests for member add, rename, and delete endpoints."""
import pytest

from app import MAX_MEMBER_NAME, create_app


def make_client(tmp_path):
    return create_app(tmp_path / "members.db").test_client()


def task(board, task_id):
    return next(t for t in board["tasks"] if t["id"] == task_id)


def test_create_member_appends_and_persists(tmp_path):
    db = tmp_path / "persist.db"
    client = create_app(db).test_client()
    resp = client.post("/api/members", json={"name": "  Alice   Chen  "})
    assert resp.status_code == 201, resp.get_json()
    body = resp.get_json()
    assert body["memberId"].startswith("member-")
    assert [m["name"] for m in body["board"]["members"]] == ["Member A", "Member B", "Alice Chen"]

    # Survives restart.
    board = create_app(db).test_client().get("/api/board").get_json()
    assert [m["name"] for m in board["members"]] == ["Member A", "Member B", "Alice Chen"]


@pytest.mark.parametrize("name", ["", "   ", None, 123, "x" * (MAX_MEMBER_NAME + 1)])
def test_create_member_rejects_invalid_name(tmp_path, name):
    client = make_client(tmp_path)
    resp = client.post("/api/members", json={"name": name})
    assert resp.status_code == 400


def test_create_member_rejects_case_insensitive_duplicate(tmp_path):
    client = make_client(tmp_path)
    resp = client.post("/api/members", json={"name": "member a"})
    assert resp.status_code == 409


def test_rename_member_updates_board_and_gpu_bookings(tmp_path):
    client = make_client(tmp_path)
    # Assign example-update-dataset to Member A, and book a GPU for it.
    client.patch("/api/tasks/example-update-dataset", json={"assigneeId": "member-a"})
    gpu_id = client.get("/api/gpus").get_json()["gpus"][0]["id"]
    client.post(
        "/api/gpu-bookings",
        json={
            "gpuId": gpu_id,
            "taskId": "example-update-dataset",
            "startAt": "2026-11-16T10:00",
            "endAt": "2026-11-16T12:00",
        },
    )

    resp = client.patch("/api/members/member-a", json={"name": "  Dr.   Alice  "})
    assert resp.status_code == 200, resp.get_json()
    board = resp.get_json()
    assert next(m for m in board["members"] if m["id"] == "member-a")["name"] == "Dr. Alice"
    train = task(board, "example-train-model")
    assert train["prerequisites"][0]["assigneeName"] == "Dr. Alice"
    update = task(board, "example-update-dataset")
    assert update["gpuBooking"]["assigneeName"] == "Dr. Alice"

    # Casing-only rename on the same member is allowed.
    resp2 = client.patch("/api/members/member-a", json={"name": "dr. alice"})
    assert resp2.status_code == 200
    assert next(m for m in resp2.get_json()["members"] if m["id"] == "member-a")["name"] == "dr. alice"


def test_rename_member_validation(tmp_path):
    client = make_client(tmp_path)
    assert client.patch("/api/members/missing", json={"name": "New"}).status_code == 404
    assert client.patch("/api/members/member-a", json={}).status_code == 400
    assert client.patch("/api/members/member-a", json={"name": "   "}).status_code == 400
    assert client.patch("/api/members/member-a", json={"name": "MEMBER B"}).status_code == 409


def test_delete_member_unassigns_and_unschedules_tasks(tmp_path):
    client = make_client(tmp_path)
    # Schedule example-update-dataset for Member A and example-train-model for Member B after it.
    assert client.patch(
        "/api/tasks/example-update-dataset",
        json={
            "assigneeId": "member-a",
            "plannedStart": "2026-11-16",
            "plannedEnd": "2026-11-17",
            "workHours": 6,
        },
    ).status_code == 200
    assert client.patch(
        "/api/tasks/example-train-model",
        json={
            "assigneeId": "member-b",
            "plannedStart": "2026-11-18",
            "plannedEnd": "2026-11-19",
        },
    ).status_code == 200
    gpu_id = client.get("/api/gpus").get_json()["gpus"][0]["id"]
    assert client.post(
        "/api/gpu-bookings",
        json={
            "gpuId": gpu_id,
            "taskId": "example-update-dataset",
            "startAt": "2026-11-16T10:00",
            "endAt": "2026-11-16T12:00",
        },
    ).status_code == 200

    resp = client.delete("/api/members/member-a")
    assert resp.status_code == 200, resp.get_json()
    board = resp.get_json()
    assert [m["id"] for m in board["members"]] == ["member-b"]

    update = task(board, "example-update-dataset")
    assert update["assigneeId"] is None
    assert update["plannedStart"] is None
    assert update["plannedEnd"] is None
    assert update["scheduled"] is False
    # Work hours, prerequisites, and GPU booking are preserved.
    assert update["workHours"] == 6
    assert update["gpuBooking"] is not None

    train = task(board, "example-train-model")
    assert train["prerequisites"][0]["id"] == "example-update-dataset"
    assert any(i["code"] == "prerequisite_unscheduled" for i in train["scheduleIssues"])


def test_cannot_delete_last_remaining_member(tmp_path):
    client = make_client(tmp_path)
    assert client.delete("/api/members/member-a").status_code == 200
    resp = client.delete("/api/members/member-b")
    assert resp.status_code == 409
    assert "at least one member" in resp.get_json()["error"].lower()
    assert client.delete("/api/members/missing").status_code == 404
