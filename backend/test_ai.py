"""AI task suggestions. Every test uses its own temporary database and a mock
instead of OpenRouter or Groq, so no network access or API key is needed."""
import io
import json
import sqlite3
import urllib.error

import pytest

import ai_suggest
from ai_suggest import AiSuggester, SuggestionError
from app import create_app


class FakeSuggester:
    """Stands in for the AI provider: returns fixed tasks or raises a fixed error."""

    model = "openrouter/free"
    provider_name = "OpenRouter"

    def __init__(self, tasks=None, error=None, configured=True):
        self.tasks, self.error, self._configured = tasks, error, configured
        self.calls = []

    def configured(self):
        return self._configured

    def status(self):
        return {"configured": self._configured, "provider": "openrouter", "providerName": self.provider_name,
                "model": self.model, "keyEnv": "OPENROUTER_API_KEY"}

    def suggest(self, description, existing_tasks):
        self.calls.append((description, list(existing_tasks)))
        if self.error:
            raise self.error
        return ai_suggest.normalize_tasks(self.tasks)


SUGGESTED = [
    {"id": "T1", "title": "Collect new rollouts", "description": "Run the simulator.", "prerequisites": []},
    {"id": "T2", "title": "Train policy", "description": "Train on the rollouts.",
     "prerequisites": ["T1", "example-update-dataset"]},
    {"id": "T3", "title": "Evaluate checkpoint", "description": "", "prerequisites": ["T2"]},
]


def snapshot(db):
    conn = sqlite3.connect(db)
    tasks = conn.execute("SELECT * FROM tasks ORDER BY id").fetchall()
    deps = conn.execute("SELECT * FROM task_dependencies ORDER BY 1, 2").fetchall()
    conn.close()
    return tasks, deps


@pytest.fixture
def db(tmp_path):
    return tmp_path / "ai.db"


def client_for(db, suggester):
    return create_app(db, suggester=suggester).test_client()


def by_title(board, title):
    return next(t for t in board["tasks"] if t["title"] == title)


# ---------- suggest: preview only ----------

def test_suggest_returns_preview_and_writes_nothing(db):
    fake = FakeSuggester(SUGGESTED)
    client = client_for(db, fake)
    before = snapshot(db)

    resp = client.post("/api/suggestions", json={"description": "Plan the next policy experiment"})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["model"] == "openrouter/free"
    assert [t["id"] for t in data["tasks"]] == ["T1", "T2", "T3"]
    t2 = data["tasks"][1]
    assert t2["prerequisites"] == ["T1", "example-update-dataset"]
    assert [(r["id"], r["kind"]) for r in t2["prerequisiteRefs"]] == [("T1", "new"), ("example-update-dataset", "existing")]
    assert t2["prerequisiteRefs"][1]["title"] == "Update dataset"
    assert data["tasks"][0]["unlocks"] == ["T2"]
    assert data["issues"] == []
    # The model was given the board so it can reference existing ids.
    assert {t["id"] for t in fake.calls[0][1]} == {"example-update-dataset", "example-train-model"}

    assert snapshot(db) == before  # nothing added before confirmation


def test_suggest_preview_flags_problems_but_still_writes_nothing(db):
    bad = [
        {"id": "A", "title": "Task A", "prerequisites": ["B"]},
        {"id": "B", "title": "Task B", "prerequisites": ["A", "missing-id"]},
    ]
    client = client_for(db, FakeSuggester(bad))
    before = snapshot(db)
    data = client.post("/api/suggestions", json={"description": "x"}).get_json()
    assert any("does not exist" in p for p in data["issues"])
    assert any("Circular dependency" in p for p in data["issues"])
    assert data["tasks"][1]["prerequisiteRefs"][1]["kind"] == "unknown"
    assert snapshot(db) == before


def test_suggest_rejects_empty_and_too_long_input(db):
    fake = FakeSuggester(SUGGESTED)
    client = client_for(db, fake)
    assert client.post("/api/suggestions", json={"description": "  "}).status_code == 400
    long = "x" * (ai_suggest.MAX_INPUT + 1)
    assert client.post("/api/suggestions", json={"description": long}).get_json()["code"] == "too_long"
    assert fake.calls == []


# ---------- accept: validate, then save everything together ----------

def test_accept_saves_batch_with_dependencies(db):
    client = client_for(db, FakeSuggester(SUGGESTED))
    preview = client.post("/api/suggestions", json={"description": "plan"}).get_json()

    resp = client.post("/api/suggestions/accept", json={"tasks": preview["tasks"]})
    assert resp.status_code == 200
    data = resp.get_json()
    created = data["createdIds"]
    assert len(created) == 3 and all(c.startswith("ai-") for c in created)
    assert set(data["idMap"]) == {"T1", "T2", "T3"}

    board = data["board"]
    collect, train, evaluate = (by_title(board, t) for t in ("Collect new rollouts", "Train policy", "Evaluate checkpoint"))
    assert [t["assigneeId"] for t in (collect, train, evaluate)] == [None, None, None]  # in the Task Pool
    assert {p["id"] for p in train["prerequisites"]} == {collect["id"], "example-update-dataset"}
    assert [p["id"] for p in evaluate["prerequisites"]] == [train["id"]]
    assert evaluate["description"] is None and collect["description"] == "Run the simulator."
    # Rows follow the saved dependencies: example-update-dataset is level 1.
    assert (collect["row"], train["row"], evaluate["row"]) == (1, 2, 3)
    assert train["stateText"] == "Waiting for 2 prerequisites"

    # Existing drag/assign flow works on the new cards, and the data survives a restart.
    assert client.patch(f"/api/tasks/{train['id']}", json={"assigneeId": "member-b"}).status_code == 200
    restarted = create_app(db, suggester=FakeSuggester()).test_client().get("/api/board").get_json()
    train_again = by_title(restarted, "Train policy")
    assert train_again["assigneeId"] == "member-b"
    assert {p["id"] for p in train_again["prerequisites"]} == {collect["id"], "example-update-dataset"}
    assert len(restarted["tasks"]) == 5


@pytest.mark.parametrize(
    "tasks, expected",
    [
        ([{"id": "T1", "title": "A", "prerequisites": ["nope"]}], 'Prerequisite "nope" of “A” does not exist.'),
        (
            [{"id": "T1", "title": "A", "prerequisites": ["T2"]}, {"id": "T2", "title": "B", "prerequisites": ["T1"]}],
            "Circular dependency",
        ),
        ([{"id": "T1", "title": "A", "prerequisites": ["T1"]}], "Circular dependency"),
        ([{"id": "example-train-model", "title": "A", "prerequisites": []}], "already used by the board task"),
    ],
)
def test_accept_rejects_bad_dependencies_and_keeps_board(db, tasks, expected):
    client = client_for(db, FakeSuggester())
    before = snapshot(db)
    resp = client.post("/api/suggestions/accept", json={"tasks": tasks})
    assert resp.status_code == 422
    body = resp.get_json()
    assert body["code"] == "invalid_dependencies"
    assert body["error"].startswith("Nothing was added.")
    assert any(expected in p for p in body["problems"])
    assert snapshot(db) == before


@pytest.mark.parametrize(
    "payload",
    [{}, {"tasks": []}, {"tasks": "T1"}, {"tasks": [{"id": "T1"}]},
     {"tasks": [{"id": "T1", "title": "A"}, {"id": "T1", "title": "B"}]}],
)
def test_accept_rejects_malformed_batch(db, payload):
    client = client_for(db, FakeSuggester())
    before = snapshot(db)
    resp = client.post("/api/suggestions/accept", json=payload)
    assert resp.status_code == 400 and resp.get_json()["code"] == "invalid_batch"
    assert snapshot(db) == before


# ---------- failures leave the board usable ----------

@pytest.mark.parametrize(
    "error, status, code",
    [
        (SuggestionError("rate_limited", "OpenRouter rate limit reached.", 429, 30), 429, "rate_limited"),
        (SuggestionError("bad_format", "The model's answer was not in the expected format.", 502), 502, "bad_format"),
    ],
)
def test_suggest_errors_are_reported_and_board_still_works(db, error, status, code):
    client = client_for(db, FakeSuggester(error=error))
    before = snapshot(db)
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == status and resp.get_json()["code"] == code
    assert snapshot(db) == before
    assert client.patch("/api/tasks/example-update-dataset", json={"assigneeId": "member-a"}).status_code == 200


def test_missing_key_with_real_suggester(db):
    suggester = AiSuggester(urlopen=lambda *a, **k: pytest.fail("must not call OpenRouter"), environ={})
    client = client_for(db, suggester)
    assert client.get("/api/ai/status").get_json() == {
        "configured": False, "provider": "openrouter", "providerName": "OpenRouter",
        "model": "openrouter/free", "keyEnv": "OPENROUTER_API_KEY",
    }
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == 503
    assert resp.get_json()["code"] == "missing_key"
    assert "OPENROUTER_API_KEY" in resp.get_json()["error"]
    assert client.get("/api/board").status_code == 200


# ---------- the real OpenRouter client against a mocked HTTP layer ----------

class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def completion(content, finish_reason="stop"):
    return json.dumps({"choices": [{"message": {"content": content}, "finish_reason": finish_reason}]}).encode()


def fake_urlopen(body=None, http_error=None, captured=None):
    def _open(req, timeout=None):
        if captured is not None:
            captured.append(req)
        if http_error:
            code, headers, payload = http_error
            raise urllib.error.HTTPError(req.full_url, code, "error", headers, io.BytesIO(payload))
        return FakeResponse(body)
    return _open


def real(db, **kw):
    return client_for(db, AiSuggester(environ={"OPENROUTER_API_KEY": "sk-test-key"}, **kw))


def test_openrouter_request_and_fenced_json(db):
    captured = []
    content = "```json\n" + json.dumps({"tasks": SUGGESTED}) + "\n```"
    client = real(db, urlopen=fake_urlopen(completion(content), captured=captured))
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == 200 and len(resp.get_json()["tasks"]) == 3

    req = captured[0]
    assert req.full_url == "https://openrouter.ai/api/v1/chat/completions"
    assert req.get_header("Authorization") == "Bearer sk-test-key"
    sent = json.loads(req.data)
    assert sent["model"] == "openrouter/free"
    assert "Update dataset" in sent["messages"][1]["content"]  # board context
    assert "sk-test-key" not in resp.get_data(as_text=True)  # key never sent to the browser


def test_openrouter_rate_limit_http_429(db):
    payload = json.dumps({"error": {"code": 429, "message": "Rate limit exceeded"}}).encode()
    client = real(db, urlopen=fake_urlopen(http_error=(429, {"Retry-After": "20"}, payload)))
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == 429
    body = resp.get_json()
    assert body["code"] == "rate_limited" and body["retryAfter"] == 20
    assert "Try again in 20 seconds" in body["error"]


@pytest.mark.parametrize(
    "body, code",
    [
        (json.dumps({"error": {"code": 429, "message": "busy"}}).encode(), "rate_limited"),  # error with HTTP 200
        (json.dumps({"error": {"code": 401, "message": "No auth"}}).encode(), "invalid_key"),
        (completion("Sure! Here are some tasks: collect data, train."), "bad_format"),
        (completion(json.dumps({"tasks": [{"id": "T1"}]})), "bad_format"),
        (completion("", finish_reason="length"), "bad_format"),
        (b"<html>gateway</html>", "upstream_error"),
    ],
)
def test_openrouter_bad_answers_are_reported(db, body, code):
    client = real(db, urlopen=fake_urlopen(body))
    before = snapshot(db)
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.get_json()["code"] == code
    assert resp.status_code >= 400
    assert snapshot(db) == before


def test_parse_suggestions_tolerates_wrapped_json():
    text = 'Here you go: {"tasks": [{"id": 1, "title": " Do  it ", "prerequisites": null}]} Thanks!'
    assert ai_suggest.parse_suggestions(text) == [
        {"id": "1", "title": "Do it", "description": "", "prerequisites": []}
    ]


# ---------- provider selection: AI_PROVIDER=openrouter (default) or groq ----------

BOTH_KEYS = {"OPENROUTER_API_KEY": "sk-or-test", "GROQ_API_KEY": "gsk-test"}


def provider_client(db, environ, urlopen):
    return client_for(db, AiSuggester(environ=environ, urlopen=urlopen))


@pytest.mark.parametrize(
    "provider_env, url, model, key, name",
    [
        (None, "https://openrouter.ai/api/v1/chat/completions", "openrouter/free", "sk-or-test", "OpenRouter"),
        ("openrouter", "https://openrouter.ai/api/v1/chat/completions", "openrouter/free", "sk-or-test", "OpenRouter"),
        ("groq", "https://api.groq.com/openai/v1/chat/completions", "openai/gpt-oss-20b", "gsk-test", "Groq"),
        (" Groq ", "https://api.groq.com/openai/v1/chat/completions", "openai/gpt-oss-20b", "gsk-test", "Groq"),
    ],
)
def test_provider_selects_api_model_and_key(db, provider_env, url, model, key, name):
    environ = dict(BOTH_KEYS, **({"AI_PROVIDER": provider_env} if provider_env is not None else {}))
    captured = []
    client = provider_client(db, environ, fake_urlopen(completion(json.dumps({"tasks": SUGGESTED})), captured=captured))

    status = client.get("/api/ai/status").get_json()
    assert (status["providerName"], status["model"], status["configured"]) == (name, model, True)

    before = snapshot(db)
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == 200
    assert (resp.get_json()["provider"], resp.get_json()["model"]) == (name, model)
    assert snapshot(db) == before  # still preview only

    assert len(captured) == 1  # only the selected provider is called
    req = captured[0]
    assert req.full_url == url
    assert req.get_header("Authorization") == f"Bearer {key}"
    assert json.loads(req.data)["model"] == model
    # OpenRouter-only attribution headers are not sent to Groq.
    assert (req.get_header("X-title") is not None) == (name == "OpenRouter")
    # Explicit User-Agent: Cloudflare in front of Groq blocks "Python-urllib/x.y" (403, error 1010).
    assert req.get_header("User-agent") == ai_suggest.USER_AGENT
    body = resp.get_data(as_text=True) + client.get("/api/ai/status").get_data(as_text=True)
    assert "sk-or-test" not in body and "gsk-test" not in body  # keys stay on the server


def test_groq_answer_with_reasoning_field_is_parsed(db):
    """gpt-oss on Groq returns its reasoning separately from the answer."""
    payload = json.dumps({"choices": [{"message": {
        "role": "assistant", "reasoning": "Thinking about the tasks...", "content": json.dumps({"tasks": SUGGESTED}),
    }, "finish_reason": "stop"}]}).encode()
    client = provider_client(db, {"AI_PROVIDER": "groq", "GROQ_API_KEY": "gsk-test"}, fake_urlopen(payload))
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == 200 and len(resp.get_json()["tasks"]) == 3


def test_groq_missing_key_does_not_fall_back_to_openrouter(db):
    environ = {"AI_PROVIDER": "groq", "OPENROUTER_API_KEY": "sk-or-test"}
    client = provider_client(db, environ, lambda *a, **k: pytest.fail("no provider may be called"))
    status = client.get("/api/ai/status").get_json()
    assert status == {"configured": False, "provider": "groq", "providerName": "Groq",
                      "model": "openai/gpt-oss-20b", "keyEnv": "GROQ_API_KEY"}
    before = snapshot(db)
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == 503
    body = resp.get_json()
    assert body["code"] == "missing_key"
    assert "GROQ_API_KEY" in body["error"] and "AI_PROVIDER=groq" in body["error"]
    assert snapshot(db) == before


def test_groq_rate_limit(db):
    payload = json.dumps({"error": {"message": "Rate limit reached for model openai/gpt-oss-20b",
                                    "type": "tokens", "code": "rate_limit_exceeded"}}).encode()
    client = provider_client(
        db, {"AI_PROVIDER": "groq", "GROQ_API_KEY": "gsk-test"},
        fake_urlopen(http_error=(429, {"Retry-After": "7"}, payload)),
    )
    before = snapshot(db)
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == 429
    body = resp.get_json()
    assert body["code"] == "rate_limited" and body["retryAfter"] == 7
    assert body["error"].startswith("Groq rate limit reached") and "Try again in 7 seconds" in body["error"]
    assert snapshot(db) == before
    assert client.get("/api/board").status_code == 200  # board keeps working


def test_openrouter_rate_limit_names_openrouter(db):
    payload = json.dumps({"error": {"code": 429, "message": "Rate limit exceeded"}}).encode()
    client = provider_client(db, {"OPENROUTER_API_KEY": "sk-or-test"}, fake_urlopen(http_error=(429, {}, payload)))
    body = client.post("/api/suggestions", json={"description": "plan"}).get_json()
    assert body["code"] == "rate_limited" and body["error"].startswith("OpenRouter rate limit reached")


def test_unknown_provider_is_reported_and_nothing_is_called(db):
    client = provider_client(db, dict(BOTH_KEYS, AI_PROVIDER="gemini"),
                             lambda *a, **k: pytest.fail("no provider may be called"))
    status = client.get("/api/ai/status").get_json()
    assert status["configured"] is False and 'Unknown AI_PROVIDER "gemini"' in status["configError"]
    resp = client.post("/api/suggestions", json={"description": "plan"})
    assert resp.status_code == 503 and resp.get_json()["code"] == "invalid_provider"
