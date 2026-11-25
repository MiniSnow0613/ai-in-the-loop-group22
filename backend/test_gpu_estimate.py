"""AI GPU estimates: in the suggestion batch, for hand-made tasks, and edits by people."""
import json
import sqlite3

import pytest

import ai_suggest
from ai_suggest import AiSuggester, SuggestionError
from app import create_app


class FakeEstimator:
    """AI stand-in with both suggest() and estimate_task() (GPU part + workload part)."""

    model = "openai/gpt-oss-20b"
    provider_name = "Groq"

    def __init__(self, tasks=None, estimate=None, error=None, configured=True, work=None):
        self.tasks, self.estimate, self.error, self._configured = tasks, estimate, error, configured
        self.work = work
        self.estimate_calls = []

    def configured(self):
        return self._configured

    def status(self):
        return {"configured": self._configured, "provider": "groq", "providerName": self.provider_name,
                "model": self.model, "keyEnv": "GROQ_API_KEY"}

    def suggest(self, description, existing_tasks):
        return {"tasks": ai_suggest.normalize_tasks(self.tasks), "reply": None}

    def estimate_task(self, title, description):
        self.estimate_calls.append((title, description))
        if self.error:
            raise self.error
        return {"gpu": self.estimate, "work": self.work}


def inline(job):
    job()


def make(tmp_path, suggester, runner=inline):
    return create_app(tmp_path / "est.db", suggester=suggester, gpu_estimate_runner=runner,
                      estimate_backlog=False).test_client()


def card(board, task_id):
    return next(t for t in board["tasks"] if t["id"] == task_id)


TRAIN = {"needed": True, "hours": 6, "reason": "Fine-tunes the policy", "source": "ai"}


# ---------- parsing the gpu field ----------

@pytest.mark.parametrize(
    "value, expected",
    [
        ({"needed": True, "hours": 6, "reason": " Train  policy "},
         {"needed": True, "hours": 6, "reason": "Train policy", "source": "ai"}),
        ({"needed": "yes", "hours": "2.3"}, {"needed": True, "hours": 2.5, "reason": "", "source": "ai"}),
        ({"needed": True, "hours": 0.1}, {"needed": True, "hours": None, "reason": "", "source": "ai"}),
        ({"needed": True, "hours": 1000}, {"needed": True, "hours": None, "reason": "", "source": "ai"}),
        ({"needed": True, "hours": "lots"}, {"needed": True, "hours": None, "reason": "", "source": "ai"}),
        ({"needed": False, "hours": 5}, {"needed": False, "hours": None, "reason": "", "source": "ai"}),
        ({"needed": True, "hours": 4, "source": "user"}, {"needed": True, "hours": 4, "reason": "", "source": "user"}),
        ({"needed": "maybe"}, None),
        ("yes", None),
        (None, None),
    ],
)
def test_normalize_gpu(value, expected):
    assert ai_suggest.normalize_gpu(value) == expected


def test_bad_gpu_field_does_not_reject_the_batch():
    tasks = ai_suggest.normalize_tasks([
        {"id": "T1", "title": "Train", "prerequisites": [], "gpu": {"needed": True, "hours": 8}},
        {"id": "T2", "title": "Write report", "prerequisites": [], "gpu": "no idea"},
        {"id": "T3", "title": "Plan", "prerequisites": []},
    ])
    assert tasks[0]["gpu"]["hours"] == 8
    assert "gpu" not in tasks[1] and "gpu" not in tasks[2]


def test_prompts_ask_for_gpu():
    assert '"gpu"' in ai_suggest.SYSTEM_PROMPT and "0.5 to 336" in ai_suggest.SYSTEM_PROMPT
    messages = ai_suggest.build_estimate_messages("Train policy", "On the new rollouts")
    assert messages[0]["content"] == ai_suggest.TASK_ESTIMATE_PROMPT
    assert '"gpu"' in ai_suggest.TASK_ESTIMATE_PROMPT
    assert "Train policy" in messages[1]["content"] and "On the new rollouts" in messages[1]["content"]


@pytest.mark.parametrize(
    "content, hours",
    [
        ('{"gpu": {"needed": true, "hours": 12, "reason": "training"}}', 12),
        ('Sure: {"needed": true, "hours": 3}', 3),
    ],
)
def test_parse_gpu_part(content, hours):
    assert ai_suggest.parse_task_estimate(content)["gpu"]["hours"] == hours


def test_parse_estimate_rejects_an_unusable_answer():
    with pytest.raises(SuggestionError) as e:
        ai_suggest.parse_task_estimate('{"gpu": {}}')
    assert e.value.code == "bad_format"


def test_real_suggester_estimate_sends_one_task(tmp_path):
    captured = []

    def urlopen(req, timeout):
        captured.append(json.loads(req.data))
        body = {"choices": [{"message": {"content": '{"gpu": {"needed": false, "hours": null, "reason": "writing"}}'},
                             "finish_reason": "stop"}]}

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps(body).encode()

        return Resp()

    s = AiSuggester(urlopen=urlopen, environ={"AI_PROVIDER": "groq", "GROQ_API_KEY": "gsk-test"})
    assert s.estimate_task("Write report", "") == {
        "gpu": {"needed": False, "hours": None, "reason": "writing", "source": "ai"},
        "work": None,
    }
    assert captured[0]["messages"][0]["content"] == ai_suggest.TASK_ESTIMATE_PROMPT


# ---------- suggestions: estimate in the preview, saved on accept ----------

def test_suggestion_preview_and_accept_keep_gpu(tmp_path):
    tasks = [
        {"id": "T1", "title": "Train policy", "prerequisites": [], "gpu": {"needed": True, "hours": 6, "reason": "r"}},
        {"id": "T2", "title": "Write report", "prerequisites": ["T1"], "gpu": {"needed": False}},
    ]
    client = make(tmp_path, FakeEstimator(tasks=tasks))
    preview = client.post("/api/suggestions", json={"description": "plan"}).get_json()
    assert preview["tasks"][0]["gpu"] == {"needed": True, "hours": 6, "reason": "r", "source": "ai"}

    # The user changed T1's hours in the preview: it is saved as their own number.
    edited = [dict(preview["tasks"][0], gpu={"needed": True, "hours": 10, "reason": "r", "source": "user"}),
              preview["tasks"][1]]
    body = client.post("/api/suggestions/accept", json={"tasks": edited}).get_json()
    t1, t2 = (card(body["board"], body["idMap"][k]) for k in ("T1", "T2"))
    assert (t1["needsGpu"], t1["gpuHours"], t1["gpuHoursSource"]) == (True, 10, "user")
    assert (t2["needsGpu"], t2["gpuHours"], t2["gpuHoursSource"]) == (False, None, "ai")


# ---------- hand-made tasks: background estimate ----------

def test_new_task_gets_an_ai_estimate(tmp_path):
    fake = FakeEstimator(estimate=TRAIN)
    client = make(tmp_path, fake)
    body = client.post("/api/tasks", json={"title": "Train policy", "description": "On new data"}).get_json()
    t = card(body["board"], body["createdId"])
    assert fake.estimate_calls == [("Train policy", "On new data")]
    assert (t["needsGpu"], t["gpuHours"], t["gpuHoursSource"]) == (True, 6, "ai")
    assert t["gpuEstimate"] == {"status": "done", "reason": "Fine-tunes the policy", "error": None}


def test_task_is_created_before_the_estimate_finishes(tmp_path):
    queued = []
    client = make(tmp_path, FakeEstimator(estimate=TRAIN), runner=queued.append)
    body = client.post("/api/tasks", json={"title": "Train policy"}).get_json()
    tid = body["createdId"]
    assert card(body["board"], tid)["gpuEstimate"]["status"] == "pending"
    queued.pop()()  # the background job finishes later
    assert card(client.get("/api/board").get_json(), tid)["gpuHours"] == 6


def test_failed_estimate_is_reported_and_can_be_retried(tmp_path):
    fake = FakeEstimator(error=SuggestionError("rate_limited", "Groq rate limit reached.", 429))
    client = make(tmp_path, fake)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    t = card(client.get("/api/board").get_json(), tid)
    assert t["gpuEstimate"]["status"] == "failed" and "rate limit" in t["gpuEstimate"]["error"]
    assert t["needsGpu"] is False

    fake.error, fake.estimate = None, TRAIN
    resp = client.post(f"/api/tasks/{tid}/gpu-estimate")
    assert resp.status_code == 202
    assert card(client.get("/api/board").get_json(), tid)["gpuHours"] == 6


def test_no_estimate_without_api_key(tmp_path):
    fake = FakeEstimator(estimate=TRAIN, configured=False)
    client = make(tmp_path, fake)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    assert fake.estimate_calls == []
    assert card(client.get("/api/board").get_json(), tid)["gpuEstimate"]["status"] is None
    resp = client.post(f"/api/tasks/{tid}/gpu-estimate")
    assert resp.status_code == 503 and "GROQ_API_KEY" in resp.get_json()["error"]


def test_person_decides_before_the_ai_answers(tmp_path):
    queued = []
    client = make(tmp_path, FakeEstimator(estimate=TRAIN), runner=queued.append)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    client.patch(f"/api/tasks/{tid}", json={"gpuHours": 20})
    queued.pop()()  # late AI answer
    t = card(client.get("/api/board").get_json(), tid)
    assert (t["gpuHours"], t["gpuHoursSource"]) == (20, "user")


def test_deleted_task_ignores_the_late_answer(tmp_path):
    queued = []
    client = make(tmp_path, FakeEstimator(estimate=TRAIN), runner=queued.append)
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    client.delete(f"/api/tasks/{tid}")
    queued.pop()()  # must not fail or recreate anything
    assert all(t["id"] != tid for t in client.get("/api/board").get_json()["tasks"])


def test_pending_estimate_is_marked_failed_after_restart(tmp_path):
    queued = []
    db = tmp_path / "est.db"
    client = create_app(db, suggester=FakeEstimator(estimate=TRAIN), gpu_estimate_runner=queued.append,
                        estimate_backlog=False).test_client()
    tid = client.post("/api/tasks", json={"title": "Train policy"}).get_json()["createdId"]
    restarted = create_app(db, suggester=FakeEstimator(estimate=TRAIN), estimate_backlog=False).test_client()
    est = card(restarted.get("/api/board").get_json(), tid)["gpuEstimate"]
    assert est["status"] == "failed" and "restarted" in est["error"]


def test_suggester_without_estimate_support_skips_it(tmp_path):
    class Old:
        model, provider_name = "m", "P"

        def configured(self):
            return True

        def status(self):
            return {"configured": True}

    client = create_app(tmp_path / "old.db", suggester=Old(), gpu_estimate_runner=inline).test_client()
    resp = client.post("/api/tasks", json={"title": "Anything"})
    assert resp.status_code == 201
    assert card(resp.get_json()["board"], resp.get_json()["createdId"])["gpuEstimate"]["status"] is None


# ---------- people set or confirm the hours ----------

def test_set_and_validate_gpu_hours(tmp_path):
    client = make(tmp_path, FakeEstimator(configured=False))
    resp = client.patch("/api/tasks/example-train-model", json={"gpuHours": 7.5})
    t = card(resp.get_json(), "example-train-model")
    assert (t["needsGpu"], t["gpuHours"], t["gpuHoursSource"]) == (True, 7.5, "user")
    for bad in (0, 0.2, 400, "x", True):
        assert client.patch("/api/tasks/example-train-model", json={"gpuHours": bad}).status_code == 400
    resp = client.patch("/api/tasks/example-train-model", json={"gpuHours": None})
    t = card(resp.get_json(), "example-train-model")
    assert (t["needsGpu"], t["gpuHours"]) == (True, None)  # needs a GPU, time unknown
    resp = client.patch("/api/tasks/example-train-model", json={"needsGpu": False})
    assert card(resp.get_json(), "example-train-model")["needsGpu"] is False


def test_existing_database_gets_estimate_columns(tmp_path):
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
            description TEXT, summary TEXT, needs_gpu INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE task_dependencies (task_id TEXT, prerequisite_id TEXT, PRIMARY KEY (task_id, prerequisite_id));
        INSERT INTO meta VALUES ('seeded', 't'), ('dependencies_migrated', 't');
        INSERT INTO tasks VALUES ('t1', 'Old task', 0, NULL, 'todo', NULL, 0, 't', NULL, NULL, 1);
        """
    )
    conn.close()
    t = card(create_app(db).test_client().get("/api/board").get_json(), "t1")
    assert (t["needsGpu"], t["gpuHours"], t["gpuHoursSource"], t["bookedGpuHours"]) == (True, None, None, 0)
