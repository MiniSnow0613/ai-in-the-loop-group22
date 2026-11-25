"""Workload: estimated work hours and 1-5 star difficulty, from the AI or set by a person.

The AI estimates the GPU need and the workload in one call; each part is
checked and protected on its own (see run_task_estimate in app.py).
"""
import pytest

import ai_suggest
from app import create_app
from test_gpu_estimate import FakeEstimator, card, inline

TRAIN_GPU = {"needed": True, "hours": 6, "reason": "Fine-tunes the policy", "source": "ai"}
TRAIN_WORK = {"hours": 4, "difficulty": 3, "reason": "Set up the training config", "source": "ai"}


def make(tmp_path, suggester, runner=inline):
    return create_app(tmp_path / "w.db", suggester=suggester, gpu_estimate_runner=runner,
                      estimate_backlog=False).test_client()


# ---------- parsing ----------

@pytest.mark.parametrize(
    "value, expected",
    [
        ({"hours": 4, "difficulty": 3, "reason": " setup  work "},
         {"hours": 4, "difficulty": 3, "reason": "setup work", "source": "ai"}),
        # AI hours snap to 1, 2, 4, 8, 16, 32, 64, 128 (nearest on a log scale).
        ({"hours": "2.3", "difficulty": "4"}, {"hours": 2, "difficulty": 4, "reason": "", "source": "ai"}),
        ({"hours": 3, "difficulty": 9}, {"hours": 4, "difficulty": None, "reason": "", "source": "ai"}),
        ({"hours": 20, "difficulty": 3}, {"hours": 16, "difficulty": 3, "reason": "", "source": "ai"}),
        ({"hours": 0.5, "difficulty": 1}, {"hours": 1, "difficulty": 1, "reason": "", "source": "ai"}),
        ({"hours": 900, "difficulty": 5}, {"hours": 128, "difficulty": 5, "reason": "", "source": "ai"}),
        ({"hours": 0, "difficulty": 2}, {"hours": None, "difficulty": 2, "reason": "", "source": "ai"}),
        ({"hours": 5000, "difficulty": 1.4}, {"hours": None, "difficulty": 1, "reason": "", "source": "ai"}),
        # A person's own hours are kept as typed.
        ({"hours": 7.5, "difficulty": 5, "source": "user"}, {"hours": 7.5, "difficulty": 5, "reason": "", "source": "user"}),
        ({"hours": "lots", "difficulty": True}, None),
        ("hard", None),
        (None, None),
    ],
)
def test_normalize_work(value, expected):
    assert ai_suggest.normalize_work(value) == expected


def test_prompts_ask_for_work_separately_from_gpu():
    for prompt in (ai_suggest.SYSTEM_PROMPT, ai_suggest.TASK_ESTIMATE_PROMPT):
        assert '"work"' in prompt and '"difficulty"' in prompt and "1 to 5" in prompt
        assert "separate from any GPU" in prompt


def test_one_broken_part_keeps_the_other():
    est = ai_suggest.parse_task_estimate('{"gpu": "?", "work": {"hours": 2, "difficulty": 1}}')
    assert est["gpu"] is None and est["work"]["hours"] == 2
    est = ai_suggest.parse_task_estimate('{"gpu": {"needed": false}, "work": "lots"}')
    assert est["gpu"]["needed"] is False and est["work"] is None


def test_bad_work_field_does_not_reject_the_batch():
    tasks = ai_suggest.normalize_tasks([
        {"id": "T1", "title": "Train", "prerequisites": [], "work": {"hours": 3, "difficulty": 4}},
        {"id": "T2", "title": "Report", "prerequisites": [], "work": "easy"},
    ])
    assert tasks[0]["work"]["difficulty"] == 4 and "work" not in tasks[1]


# ---------- suggestions ----------

def test_suggestion_preview_and_accept_keep_work(tmp_path):
    tasks = [
        {"id": "T1", "title": "Train policy", "prerequisites": [],
         "gpu": {"needed": True, "hours": 6}, "work": {"hours": 4, "difficulty": 3, "reason": "config"}},
        {"id": "T2", "title": "Write report", "prerequisites": ["T1"], "work": {"hours": 2, "difficulty": 1}},
    ]
    client = make(tmp_path, FakeEstimator(tasks=tasks))
    preview = client.post("/api/suggestions", json={"description": "plan"}).get_json()
    assert preview["tasks"][0]["work"] == {"hours": 4, "difficulty": 3, "reason": "config", "source": "ai"}

    # Difficulty of T2 changed in the preview: saved as the person's own value.
    edited = [preview["tasks"][0], dict(preview["tasks"][1], work={"hours": 2, "difficulty": 2, "source": "user"})]
    body = client.post("/api/suggestions/accept", json={"tasks": edited}).get_json()
    t1, t2 = (card(body["board"], body["idMap"][k]) for k in ("T1", "T2"))
    assert (t1["workHours"], t1["difficulty"], t1["workSource"]) == (4, 3, "ai")
    assert t1["workEstimate"]["reason"] == "config"
    assert (t1["gpuHours"], t1["needsGpu"]) == (6, True)  # GPU part unaffected
    assert (t2["workHours"], t2["difficulty"], t2["workSource"]) == (2, 2, "user")


# ---------- hand-made tasks: one call fills both parts ----------

def test_new_task_gets_gpu_and_work_in_one_call(tmp_path):
    fake = FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK)
    client = make(tmp_path, fake)
    body = client.post("/api/tasks", json={"title": "Train policy"}).get_json()
    t = card(body["board"], body["createdId"])
    assert len(fake.estimate_calls) == 1
    assert (t["gpuHours"], t["gpuHoursSource"]) == (6, "ai")
    assert (t["workHours"], t["difficulty"], t["workSource"]) == (4, 3, "ai")
    assert t["workEstimate"] == {"status": "done", "reason": "Set up the training config", "error": None}
    # Work hours never decide the dates.
    assert (t["plannedStart"], t["plannedEnd"]) == (None, None)


def test_editing_gpu_while_pending_still_fills_the_workload(tmp_path):
    queued = []
    client = make(tmp_path, FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK), runner=queued.append)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    t = card(client.patch(f"/api/tasks/{tid}", json={"gpuHours": 20}).get_json(), tid)
    assert t["gpuEstimate"]["status"] is None and t["workEstimate"]["status"] == "pending"
    queued.pop()()
    t = card(client.get("/api/board").get_json(), tid)
    assert (t["gpuHours"], t["gpuHoursSource"]) == (20, "user")
    assert (t["workHours"], t["difficulty"], t["workSource"]) == (4, 3, "ai")


def test_editing_work_while_pending_still_fills_the_gpu(tmp_path):
    queued = []
    client = make(tmp_path, FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK), runner=queued.append)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    client.patch(f"/api/tasks/{tid}", json={"difficulty": 5})
    queued.pop()()
    t = card(client.get("/api/board").get_json(), tid)
    assert (t["difficulty"], t["difficultySource"], t["workHours"], t["workSource"]) == (5, "user", None, None)
    assert (t["gpuHours"], t["gpuHoursSource"]) == (6, "ai")


def test_missing_work_part_keeps_stored_values(tmp_path):
    fake = FakeEstimator(estimate=TRAIN_GPU, work=None)
    client = make(tmp_path, fake)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    t = card(client.get("/api/board").get_json(), tid)
    assert (t["gpuHours"], t["workHours"], t["difficulty"], t["workSource"]) == (6, None, None, None)
    assert t["workEstimate"]["status"] == "done"


def test_ask_again_only_overwrites_the_chosen_part(tmp_path):
    fake = FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK)
    client = make(tmp_path, fake)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    client.patch(f"/api/tasks/{tid}", json={"gpuHours": 30, "workHours": 10})
    fake.estimate = dict(TRAIN_GPU, hours=2)
    fake.work = dict(TRAIN_WORK, hours=1, difficulty=1)

    assert client.post(f"/api/tasks/{tid}/estimate", json={"parts": ["work"]}).status_code == 202
    t = card(client.get("/api/board").get_json(), tid)
    assert (t["workHours"], t["difficulty"], t["workSource"]) == (1, 1, "ai")
    assert (t["gpuHours"], t["gpuHoursSource"]) == (30, "user")

    client.patch(f"/api/tasks/{tid}", json={"workHours": 7})
    assert client.post(f"/api/tasks/{tid}/gpu-estimate").status_code == 202  # GPU part only
    t = card(client.get("/api/board").get_json(), tid)
    assert (t["gpuHours"], t["gpuHoursSource"]) == (2, "ai")
    assert (t["workHours"], t["workSource"]) == (7, "user")

    assert client.post(f"/api/tasks/{tid}/estimate", json={"parts": ["gpu", "work"]}).status_code == 202
    assert client.post(f"/api/tasks/{tid}/estimate", json={"parts": ["dates"]}).status_code == 400
    assert client.post(f"/api/tasks/{tid}/estimate", json={"parts": []}).status_code == 400


def test_failed_call_marks_both_parts(tmp_path):
    from ai_suggest import SuggestionError

    fake = FakeEstimator(error=SuggestionError("invalid_key", "Groq rejected the API key.", 502))
    client = make(tmp_path, fake)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    t = card(client.get("/api/board").get_json(), tid)
    assert t["gpuEstimate"]["status"] == t["workEstimate"]["status"] == "failed"
    assert "rejected" in t["workEstimate"]["error"]


# ---------- people set or confirm the workload ----------

def test_set_and_validate_difficulty(tmp_path):
    client = make(tmp_path, FakeEstimator(configured=False))
    t = card(client.patch("/api/tasks/example-train-model", json={"difficulty": 4}).get_json(), "example-train-model")
    assert (t["difficulty"], t["difficultySource"], t["workSource"]) == (4, "user", None)
    for bad in (0, 6, 2.5, "3", True):
        resp = client.patch("/api/tasks/example-train-model", json={"difficulty": bad})
        assert resp.status_code == 400 and resp.get_json()["code"] == "invalid_difficulty", bad
    t = card(client.patch("/api/tasks/example-train-model", json={"difficulty": None}).get_json(), "example-train-model")
    assert t["difficulty"] is None


def test_resending_the_same_hours_does_not_confirm_an_ai_estimate(tmp_path):
    client = make(tmp_path, FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK))
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    # e.g. the schedule form saves new dates and sends the hours it showed
    t = card(client.patch(f"/api/tasks/{tid}", json={"workHours": 4}).get_json(), tid)
    assert t["workSource"] == "ai"
    t = card(client.patch(f"/api/tasks/{tid}", json={"confirmWork": True}).get_json(), tid)
    assert (t["workHours"], t["difficulty"], t["workSource"]) == (4, 3, "user")
    assert client.patch(f"/api/tasks/{tid}", json={"confirmWork": False}).status_code == 400


def test_work_and_gpu_hours_stay_independent(tmp_path):
    client = make(tmp_path, FakeEstimator(configured=False))
    tid = "example-train-model"
    client.patch(f"/api/tasks/{tid}", json={"gpuHours": 12})
    t = card(client.patch(f"/api/tasks/{tid}", json={"workHours": 3, "difficulty": 2}).get_json(), tid)
    assert (t["gpuHours"], t["gpuHoursSource"], t["workHours"], t["difficulty"]) == (12, "user", 3, 2)
    t = card(client.patch(f"/api/tasks/{tid}", json={"needsGpu": False}).get_json(), tid)
    assert (t["workHours"], t["difficulty"], t["workSource"]) == (3, 2, "user")


# ---------- steadier estimates ----------

def test_estimates_use_temperature_zero_and_the_hour_scale():
    import json

    sent = []

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            body = '{"gpu": {"needed": false}, "work": {"hours": 20, "difficulty": 3}}'
            return json.dumps({"choices": [{"message": {"content": body}, "finish_reason": "stop"}]}).encode()

    def urlopen(req, timeout):
        sent.append(json.loads(req.data))
        return Resp()

    s = ai_suggest.AiSuggester(urlopen=urlopen, environ={"AI_PROVIDER": "groq", "GROQ_API_KEY": "gsk-test"})
    assert s.estimate_task("Build a page", "")["work"]["hours"] == 16  # snapped from 20
    assert sent[0]["temperature"] == 0
    assert "1, 2, 4, 8, 16, 32, 64, 128" in ai_suggest.TASK_ESTIMATE_PROMPT
    assert "Reference points" in ai_suggest.TASK_ESTIMATE_PROMPT


# ---------- automatic backfill of missing estimates ----------

def backfill_app(tmp_path, fake, db_name="b.db"):
    """An app whose start-up backfill runs inline, without pauses."""
    return create_app(tmp_path / db_name, suggester=fake, gpu_estimate_runner=inline,
                      estimate_backlog=True, backlog_pause=0).test_client()


def test_backfill_estimates_old_tasks_at_start(tmp_path):
    fake = FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK)
    board = backfill_app(tmp_path, fake).get("/api/board").get_json()
    assert sorted(title for title, _ in fake.estimate_calls) == ["Train model", "Update dataset"]
    for t in board["tasks"]:
        assert (t["workHours"], t["difficulty"], t["workSource"], t["difficultySource"]) == (4, 3, "ai", "ai")
        assert (t["gpuHours"], t["gpuHoursSource"]) == (6, "ai")
        assert t["gpuEstimate"]["status"] == "done"


def test_backfill_only_fills_empty_fields(tmp_path):
    # A person's work hours and GPU decision stay; only the missing difficulty is filled.
    db = tmp_path / "b.db"
    plain = create_app(db, suggester=FakeEstimator(configured=False)).test_client()
    plain.patch("/api/tasks/example-train-model", json={"workHours": 10, "gpuHours": 30})
    plain.patch("/api/tasks/example-update-dataset", json={"status": "done"})

    fake = FakeEstimator(estimate=dict(TRAIN_GPU, hours=2), work=TRAIN_WORK)
    t = card(backfill_app(tmp_path, fake).get("/api/board").get_json(), "example-train-model")
    assert [title for title, _ in fake.estimate_calls] == ["Train model"]  # the done task is skipped
    assert (t["workHours"], t["workSource"]) == (10, "user")
    assert (t["difficulty"], t["difficultySource"]) == (3, "ai")
    assert (t["gpuHours"], t["gpuHoursSource"]) == (30, "user")


def test_backfill_runs_once_per_task(tmp_path):
    fake = FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK)
    backfill_app(tmp_path, fake)
    backfill_app(tmp_path, fake)  # a restart: everything already has an estimate
    assert len(fake.estimate_calls) == 2


def test_backfill_skips_complete_tasks(tmp_path):
    db = tmp_path / "b.db"
    plain = create_app(db, suggester=FakeEstimator(configured=False)).test_client()
    for tid in ("example-train-model", "example-update-dataset"):
        plain.patch(f"/api/tasks/{tid}", json={"workHours": 3, "difficulty": 2, "needsGpu": False})
    fake = FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK)
    backfill_app(tmp_path, fake)
    assert fake.estimate_calls == []


def test_backfill_stops_when_the_key_is_rejected(tmp_path):
    from ai_suggest import SuggestionError

    fake = FakeEstimator(error=SuggestionError("invalid_key", "Groq rejected the API key.", 502))
    board = backfill_app(tmp_path, fake).get("/api/board").get_json()
    assert len(fake.estimate_calls) == 1  # no point trying the other task
    assert sorted(t["gpuEstimate"]["status"] or "" for t in board["tasks"]) == ["", "failed"]


def test_backfill_waits_and_retries_after_a_rate_limit(tmp_path):
    from ai_suggest import SuggestionError

    class Flaky(FakeEstimator):
        def estimate_task(self, title, description):
            self.estimate_calls.append((title, description))
            if len(self.estimate_calls) == 1:
                raise SuggestionError("rate_limited", "Slow down.", 429, retry_after=0)
            return {"gpu": self.estimate, "work": self.work}

    fake = Flaky(estimate=TRAIN_GPU, work=TRAIN_WORK)
    board = backfill_app(tmp_path, fake).get("/api/board").get_json()
    assert len(fake.estimate_calls) == 3  # first task twice, second once
    assert all(t["difficulty"] == 3 for t in board["tasks"])


def test_backfill_is_off_without_a_key(tmp_path):
    fake = FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK, configured=False)
    backfill_app(tmp_path, fake)
    assert fake.estimate_calls == []


def test_backfill_switch_from_the_environment(tmp_path, monkeypatch):
    fake = FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK)
    monkeypatch.setenv("BOARD_ESTIMATE_BACKLOG", "1")
    create_app(tmp_path / "on.db", suggester=fake, gpu_estimate_runner=inline, backlog_pause=0)
    assert len(fake.estimate_calls) == 2
    monkeypatch.setenv("BOARD_ESTIMATE_BACKLOG", "0")
    create_app(tmp_path / "off.db", suggester=fake, gpu_estimate_runner=inline, backlog_pause=0)
    assert len(fake.estimate_calls) == 2


def test_confirm_marks_both_fields_as_a_persons(tmp_path):
    fake = FakeEstimator(estimate=TRAIN_GPU, work=TRAIN_WORK)
    client = make(tmp_path, fake)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    t = card(client.patch(f"/api/tasks/{tid}", json={"difficulty": 4}).get_json(), tid)
    assert (t["workSource"], t["difficultySource"]) == ("ai", "user")  # hours still the AI's
    t = card(client.patch(f"/api/tasks/{tid}", json={"confirmWork": True}).get_json(), tid)
    assert (t["workSource"], t["difficultySource"]) == ("user", "user")
