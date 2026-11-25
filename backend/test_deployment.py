"""Tests for shared-URL deployment features:
- Per-browser AI provider / key overrides (with host fallback)
- Forced host passcode on hosted deployments (BOARD_PASSCODE / REQUIRE_PASSCODE)
- Turso Hrana HTTP v2 database client compatibility with app schema & queries
"""
import io
import json
import sqlite3

import pytest

import ai_suggest
import app as board_app
import db_client
from ai_suggest import AiSuggester
from app import create_app


class FakeHttpResponse:
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def make_ai_urlopen(reply_obj):
    seen = []

    def urlopen(req, timeout=None):
        seen.append({
            "url": req.full_url,
            "auth": req.get_header("Authorization"),
            "body": json.loads(req.data.decode("utf-8")),
        })
        return FakeHttpResponse({
            "choices": [{"message": {"content": json.dumps(reply_obj)}}],
        })

    return seen, urlopen


@pytest.fixture
def db(tmp_path):
    return tmp_path / "deploy.db"


# ---------- Per-browser AI provider & key overrides ----------

def test_browser_override_uses_user_provider_and_key_without_changing_host(db):
    seen, urlopen = make_ai_urlopen({
        "tasks": [{"id": "T1", "title": "Run eval", "description": "Eval model.", "prerequisites": []}]
    })
    host_env = {"AI_PROVIDER": "openrouter", "OPENROUTER_API_KEY": "sk-or-host"}
    suggester = AiSuggester(urlopen=urlopen, environ=host_env)
    client = create_app(db, suggester=suggester).test_client()

    # Without headers: uses host default (OpenRouter).
    st = client.get("/api/ai/status").get_json()
    assert st["configured"] is True
    assert st["provider"] == "openrouter"
    assert st.get("source", "host") == "host"
    assert "sk-or-host" not in json.dumps(st)

    # With user Groq headers: switches to Groq + user key without exposing key.
    headers = {"X-AI-Provider": "groq", "X-AI-Key": "gsk-user-secret"}
    st_user = client.get("/api/ai/status", headers=headers).get_json()
    assert st_user["configured"] is True
    assert st_user["provider"] == "groq"
    assert st_user["source"] == "user"
    assert st_user["hostProvider"] == "openrouter"
    assert "gsk-user-secret" not in json.dumps(st_user)

    resp = client.post("/api/suggestions", json={"description": "Evaluate checkpoint"}, headers=headers)
    assert resp.status_code == 200
    assert resp.get_json()["provider"] == "Groq"
    assert seen[-1]["url"] == ai_suggest.PROVIDERS["groq"].url
    assert seen[-1]["auth"] == "Bearer gsk-user-secret"

    # Next request without headers still uses the host's OpenRouter key.
    resp2 = client.post("/api/suggestions", json={"description": "Evaluate again"})
    assert resp2.status_code == 200
    assert resp2.get_json()["provider"] == "OpenRouter"
    assert seen[-1]["url"] == ai_suggest.PROVIDERS["openrouter"].url
    assert seen[-1]["auth"] == "Bearer sk-or-host"


def test_browser_override_applies_to_gpu_estimates(db):
    seen, urlopen = make_ai_urlopen({
        "gpu": {"needed": True, "hours": 4, "reason": "Model fine-tuning"}
    })
    # Host has NO key configured at all.
    suggester = AiSuggester(urlopen=urlopen, environ={"AI_PROVIDER": "openrouter"})
    client = create_app(db, suggester=suggester, gpu_estimate_runner=lambda job: job()).test_client()

    # Creating a task with a browser-supplied Groq key triggers the GPU estimate using that key.
    headers = {"X-AI-Provider": "groq", "X-AI-Key": "gsk-browser-only"}
    resp = client.post(
        "/api/tasks",
        json={"title": "Fine-tune ViT", "description": "Run 20 epochs", "prerequisites": []},
        headers=headers,
    )
    assert resp.status_code == 201
    assert len(seen) == 1
    assert seen[0]["url"] == ai_suggest.PROVIDERS["groq"].url
    assert seen[0]["auth"] == "Bearer gsk-browser-only"

    task_id = resp.get_json()["createdId"]
    board = client.get("/api/board").get_json()
    created = next(t for t in board["tasks"] if t["id"] == task_id)
    assert created["needsGpu"] is True
    assert created["gpuHours"] == 4
    assert created["gpuEstimate"]["status"] == "done"


def test_browser_override_provider_without_key_prompts_user(db):
    _, urlopen = make_ai_urlopen({})
    suggester = AiSuggester(urlopen=urlopen, environ={"AI_PROVIDER": "openrouter", "OPENROUTER_API_KEY": "sk-or-host"})
    client = create_app(db, suggester=suggester).test_client()

    st = client.get("/api/ai/status", headers={"X-AI-Provider": "groq"}).get_json()
    assert st["configured"] is False
    assert st["provider"] == "groq"
    assert st["source"] == "user"

    resp = client.post("/api/suggestions", json={"description": "Plan work"}, headers={"X-AI-Provider": "groq"})
    assert resp.status_code == 503
    assert resp.get_json()["code"] == "missing_key"


def test_browser_override_key_only_uses_host_provider(db):
    seen, urlopen = make_ai_urlopen({
        "tasks": [{"id": "T1", "title": "Train baseline", "description": "", "prerequisites": []}]
    })
    suggester = AiSuggester(urlopen=urlopen, environ={"AI_PROVIDER": "groq"})
    client = create_app(db, suggester=suggester).test_client()

    resp = client.post(
        "/api/suggestions",
        json={"description": "Train baseline"},
        headers={"X-AI-Key": "gsk-user-only"},
    )
    assert resp.status_code == 200
    assert seen[0]["url"] == ai_suggest.PROVIDERS["groq"].url
    assert seen[0]["auth"] == "Bearer gsk-user-only"


# ---------- Forced host passcode ----------

def test_hosted_mode_refuses_access_until_host_sets_passcode(db):
    client = create_app(db, passcode="", require_passcode=True).test_client()

    st = client.get("/api/auth/status").get_json()
    assert st["required"] is True
    assert st["configured"] is False
    assert st["authenticated"] is False

    resp = client.get("/api/board")
    assert resp.status_code == 503
    assert resp.get_json()["code"] == "passcode_not_configured"

    verify = client.post("/api/auth/verify", json={"passcode": "anything"})
    assert verify.status_code == 503
    assert verify.get_json()["code"] == "passcode_not_configured"


def test_passcode_gates_api_and_unlocks_with_correct_password(db):
    client = create_app(db, passcode="lab-secret-22", require_passcode=True).test_client()

    assert client.get("/api/auth/status").get_json() == {
        "required": True,
        "configured": True,
        "authenticated": False,
    }
    assert client.get("/api/board").status_code == 401
    assert client.get("/api/board", headers={"X-Board-Passcode": "wrong"}).status_code == 401
    assert client.post("/api/auth/verify", json={"passcode": "wrong"}).status_code == 401

    ok = client.post("/api/auth/verify", json={"passcode": "lab-secret-22"})
    assert ok.status_code == 200 and ok.get_json() == {"ok": True}

    headers = {"X-Board-Passcode": "lab-secret-22"}
    assert client.get("/api/auth/status", headers=headers).get_json()["authenticated"] is True
    assert client.get("/api/board", headers=headers).status_code == 200


def test_local_mode_needs_no_passcode(db):
    client = create_app(db, passcode="", require_passcode=False).test_client()
    assert client.get("/api/auth/status").get_json() == {
        "required": False,
        "configured": True,
        "authenticated": True,
    }
    assert client.get("/api/board").status_code == 200


# ---------- Turso Hrana HTTP v2 client ----------

def test_resolve_db_target_precedence(tmp_path):
    explicit = tmp_path / "test.db"
    env = {"TURSO_DATABASE_URL": "libsql://demo.turso.io", "BOARD_DB_PATH": "/tmp/other.db"}
    assert db_client.resolve_db_target(explicit, default_path="default.db", environ=env) == str(explicit)
    assert db_client.resolve_db_target(None, default_path="default.db", environ=env) == "libsql://demo.turso.io"
    assert db_client.resolve_db_target(None, default_path="default.db", environ={}) == "default.db"


def test_turso_connection_runs_real_schema_and_transactions():
    """Simulate a Turso Hrana HTTP v2 server backed by an in-memory SQLite DB."""
    backing = sqlite3.connect(":memory:", isolation_level=None)
    backing.row_factory = sqlite3.Row
    baton_counter = [0]
    seen_auth = []
    seen_urls = []

    def encode_cell(val):
        if val is None:
            return {"type": "null"}
        if isinstance(val, int):
            return {"type": "integer", "value": str(val)}
        if isinstance(val, float):
            return {"type": "float", "value": val}
        if isinstance(val, (bytes, bytearray)):
            return {"type": "blob", "base64": ""}
        return {"type": "text", "value": str(val)}

    def decode_arg(arg):
        t = arg["type"]
        if t == "null":
            return None
        if t == "integer":
            return int(arg["value"])
        if t == "float":
            return float(arg["value"])
        return arg["value"]

    def fake_urlopen(req, timeout=None):
        seen_urls.append(req.full_url)
        seen_auth.append(req.get_header("Authorization"))
        body = json.loads(req.data.decode("utf-8"))
        results = []
        closed = False
        for item in body["requests"]:
            if item["type"] == "close":
                closed = True
                results.append({"type": "ok", "response": {"type": "close"}})
                continue
            stmt = item["stmt"]
            sql = stmt["sql"]
            args = [decode_arg(a) for a in stmt.get("args", [])]
            try:
                cur = backing.execute(sql, args)
                cols = [{"name": d[0]} for d in (cur.description or [])]
                rows = [[encode_cell(v) for v in r] for r in cur.fetchall()] if cur.description else []
                results.append({
                    "type": "ok",
                    "response": {
                        "type": "execute",
                        "result": {
                            "cols": cols,
                            "rows": rows,
                            "affected_row_count": cur.rowcount if cur.rowcount >= 0 else 0,
                        },
                    },
                })
            except sqlite3.Error as e:
                results.append({"type": "error", "error": {"message": str(e)}})
        baton_counter[0] += 1
        return FakeHttpResponse({
            "baton": None if closed else f"baton-{baton_counter[0]}",
            "base_url": "https://replica.demo.turso.io",
            "results": results,
        })

    conn = db_client.TursoConnection("libsql://demo.turso.io", auth_token="jwt-token", urlopen=fake_urlopen)
    conn.executescript(board_app.SCHEMA)
    conn.execute("INSERT INTO members (id, name, position) VALUES (?, ?, ?)", ("m1", "Alice", 0))
    conn.commit()

    # Rollback test
    conn.execute("INSERT INTO members (id, name, position) VALUES (?, ?, ?)", ("m2", "Bob", 1))
    conn.rollback()

    rows = conn.execute("SELECT id, name, position FROM members ORDER BY position").fetchall()
    assert len(rows) == 1
    assert rows[0]["id"] == "m1"
    assert rows[0]["name"] == "Alice"
    assert dict(rows[0]) == {"id": "m1", "name": "Alice", "position": 0}

    # Constraint violation raises sqlite3.IntegrityError
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO members (id, name, position) VALUES (?, ?, ?)", ("m1", "Dup", 1))
    conn.rollback()

    conn.close()
    assert seen_urls[0] == "https://demo.turso.io/v2/pipeline"
    assert seen_urls[1] == "https://replica.demo.turso.io/v2/pipeline"
    assert all(a == "Bearer jwt-token" for a in seen_auth)
