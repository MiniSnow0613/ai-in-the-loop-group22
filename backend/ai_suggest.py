"""AI task suggestions from an OpenAI-compatible chat API.

The provider is chosen by AI_PROVIDER (read by Flask on every request):
  openrouter (default)  model "openrouter/free",     key OPENROUTER_API_KEY
  groq                  model "openai/gpt-oss-20b",  key GROQ_API_KEY
Only the selected provider is called. Only the Flask server reads the keys;
the browser never sees them.

Flow:
  1. suggest():   ask the model for candidate tasks as JSON, parse and check the
                  shape. Nothing is written to the database. A message that is
                  not work to plan ("how are you") gets {"tasks": [], "reply"}.
  2. validate_batch(): run again when the user accepts the preview. Checks that
                  every prerequisite exists (in the batch or on the board) and
                  that there are no circular dependencies. app.py then saves the
                  whole batch in one transaction.

The JSON shape is requested in the prompt rather than through `response_format`
(`openrouter/free` routes to models that do not all support it), and the reply
is validated strictly here.
"""
import json
import os
import re
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass, field

PROVIDER_ENV = "AI_PROVIDER"
DEFAULT_PROVIDER = "openrouter"
USER_AGENT = "group22-coordination-board/0.1"


@dataclass(frozen=True)
class Provider:
    key: str          # value of AI_PROVIDER
    name: str         # shown to users
    url: str
    model: str
    key_env: str
    extra_headers: dict = field(default_factory=dict)


PROVIDERS = {
    "openrouter": Provider(
        key="openrouter",
        name="OpenRouter",
        url="https://openrouter.ai/api/v1/chat/completions",
        model="openrouter/free",
        key_env="OPENROUTER_API_KEY",
        extra_headers={
            "HTTP-Referer": "http://localhost",
            "X-Title": "Group 22 Experiment Coordination Board",
        },
    ),
    "groq": Provider(
        key="groq",
        name="Groq",
        url="https://api.groq.com/openai/v1/chat/completions",
        model="openai/gpt-oss-20b",
        key_env="GROQ_API_KEY",
    ),
}

MAX_TASKS = 10
MAX_TITLE = 120
MAX_DESCRIPTION = 500
MAX_REPLY = 500           # characters of a no-task reply shown in the chat
MAX_INPUT = 2000         # characters of work description accepted from the user
MAX_CONTEXT_TASKS = 50    # existing board tasks sent to the model as context
TIMEOUT_SECONDS = 60
MIN_GPU_HOURS = 0.5
MAX_GPU_HOURS = 336       # 14 days, the longest single GPU booking
MAX_GPU_REASON = 200

# Shared by both prompts so the batch and the single-task estimate judge alike.
GPU_RULES = """- "gpu": whether the task itself needs GPU compute, and roughly for how long.
  - "needed": true only for compute-heavy work such as training or fine-tuning a model,
    GPU simulation or large-scale data collection, batch inference or evaluating models,
    or rendering. Planning, writing, reviewing, meetings, and small data cleaning are false.
  - "hours": estimated total GPU hours for the whole task, a number from 0.5 to 336.
    Use null when "needed" is false.
  - "reason": one short phrase explaining the estimate."""

SYSTEM_PROMPT = f"""You split a research team's upcoming work into tasks for a shared coordination board.

Reply with JSON only: no prose, no Markdown, no code fences. Use exactly one of these two shapes.

1. The message describes work the team needs to do. Use this shape:
{{"tasks": [{{"id": "T1", "title": "...", "description": "...", "prerequisites": ["..."],
  "gpu": {{"needed": true, "hours": 6, "reason": "..."}}}}]}}

2. The message does not describe any work to plan: a greeting, small talk, thanks, a question
   unrelated to the team's work, or text with no task in it. Do not invent tasks. Use this shape:
{{"tasks": [], "reply": "..."}}
   "reply": one to three short, friendly sentences. Answer the message briefly, say that you
   turn a description of upcoming work into candidate tasks, and give one short example of
   such a description.

If the message names any concrete work, even briefly (for example "train the model"), use shape 1.

Rules for shape 1:
- Return 1 to 8 tasks.
- "id": a short temporary id that is unique within this reply (T1, T2, ...).
- "title": at most 80 characters, starting with a verb.
- "description": one short sentence.
- "prerequisites": ids of tasks that must be completed first. Use ids from this reply,
  or the exact id of an existing board task from the list the user gives. Use [] if none.
- Never create circular dependencies.
{GPU_RULES}

Language: write every title, description, reason, and reply in the language of the work
description, including its script (Traditional Chinese stays Traditional Chinese). The English
examples above never change the language."""

GPU_ESTIMATE_PROMPT = f"""You estimate whether one task on a research team's coordination board needs GPU compute.

Reply with JSON only: no prose, no Markdown, no code fences. Use exactly this shape:
{{"gpu": {{"needed": true, "hours": 6, "reason": "..."}}}}

Rules:
{GPU_RULES}
- Write the reason in the same language as the task."""


class SuggestionError(Exception):
    """A problem to show in the assistant panel. `code` lets the UI react."""

    def __init__(self, code, message, http_status=502, retry_after=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.retry_after = retry_after

    def to_json(self):
        body = {"error": self.message, "code": self.code}
        if self.retry_after is not None:
            body["retryAfter"] = self.retry_after
        return body


# ---------- prompt ----------

def build_messages(description, existing_tasks):
    """existing_tasks: iterable of dicts with id, title, status."""
    lines = [f"{t['id']} | {t['title']} | {t['status']}" for t in list(existing_tasks)[:MAX_CONTEXT_TASKS]]
    board = "\n".join(lines) if lines else "(none)"
    user = (
        "Existing board tasks (id | title | status):\n"
        f"{board}\n\n"
        "Work description:\n"
        f"{description}"
    )
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def build_gpu_messages(title, description):
    user = f"Task title: {title}\nTask description: {description or '(none)'}"
    return [{"role": "system", "content": GPU_ESTIMATE_PROMPT}, {"role": "user", "content": user}]


# ---------- OpenRouter call ----------

def _retry_after(headers):
    value = headers.get("Retry-After") if headers else None
    try:
        return max(0, int(float(value))) if value is not None else None
    except ValueError:
        return None


def _error_from_status(status, detail, retry_after=None, provider=PROVIDERS["openrouter"]):
    """Map an error status (HTTP, or error.code in a 200 body) to a user-facing message."""
    name = provider.name
    suffix = f" ({detail})" if detail else ""
    if status == 401:
        return SuggestionError(
            "invalid_key", f"{name} rejected the API key. Check {provider.key_env} and restart the server.", 502
        )
    if status == 402:
        return SuggestionError("insufficient_credits", f"{name} reports insufficient credits{suffix}.", 502)
    if status == 403:
        return SuggestionError("forbidden", f"{name} refused this request{suffix}.", 502)
    if status == 429:
        wait = f" Try again in {retry_after} seconds." if retry_after else " Wait a moment and try again."
        return SuggestionError(
            "rate_limited",
            f"{name} rate limit reached. Free plans allow a limited number of requests "
            f"per minute and per day.{wait}",
            429,
            retry_after,
        )
    if status in (408, 504):
        return SuggestionError("timeout", "The model took too long to answer. Try again.", 504)
    if status in (498, 502, 503):  # 498: Groq flex tier over capacity
        return SuggestionError(
            "model_unavailable", f"{name} has no model available right now{suffix}. Try again shortly.", 502, retry_after
        )
    return SuggestionError("upstream_error", f"{name} returned an error (HTTP {status}){suffix}.", 502)


def _error_detail(body):
    try:
        err = json.loads(body).get("error") or {}
        return str(err.get("message") or "")[:200]
    except (ValueError, AttributeError):
        return ""


def call_chat(provider, messages, api_key, urlopen=urllib.request.urlopen, timeout=TIMEOUT_SECONDS):
    """POST to the provider's chat completions endpoint and return the reply text."""
    payload = json.dumps({"model": provider.model, "messages": messages, "temperature": 0.2}).encode("utf-8")
    req = urllib.request.Request(
        provider.url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Cloudflare in front of Groq answers urllib's default
            # "Python-urllib/x.y" with 403 "error code: 1010"; name the client.
            "User-Agent": USER_AGENT,
            **provider.extra_headers,
        },
    )

    def fail(status, detail="", retry_after=None):
        return _error_from_status(status, detail, retry_after, provider)

    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise fail(e.code, _error_detail(body), _retry_after(e.headers)) from None
    except (socket.timeout, TimeoutError):
        raise SuggestionError("timeout", "The model took too long to answer. Try again.", 504) from None
    except urllib.error.URLError as e:
        raise SuggestionError(
            "network_error", f"Could not reach {provider.name} ({e.reason}). Check the network connection.", 502
        ) from None

    try:
        data = json.loads(raw)
    except ValueError:
        raise SuggestionError("upstream_error", f"{provider.name} returned a response that is not JSON.", 502) from None

    # OpenRouter can report errors with HTTP 200: a top-level "error", or an
    # error inside the choice. Checked for every provider.
    if isinstance(data, dict) and data.get("error"):
        err = data["error"] if isinstance(data["error"], dict) else {"message": str(data["error"])}
        status = err.get("code") if isinstance(err.get("code"), int) else 502
        raise fail(status, str(err.get("message") or "")[:200])
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        raise SuggestionError("upstream_error", f"{provider.name} returned no answer.", 502)
    choice = choices[0] or {}
    if choice.get("error") or choice.get("finish_reason") == "error":
        detail = (choice.get("error") or {}).get("message", "") if isinstance(choice.get("error"), dict) else ""
        raise fail(502, str(detail)[:200])
    content = (choice.get("message") or {}).get("content")
    if not isinstance(content, str) or not content.strip():
        hint = " (the answer was cut off)" if choice.get("finish_reason") == "length" else ""
        raise SuggestionError("bad_format", f"The model returned an empty answer{hint}. Try again.", 502)
    return content


# ---------- parsing and validation ----------

def _bad_format(reason):
    return SuggestionError(
        "bad_format", f"The model's answer was not in the expected format: {reason}. Try again.", 502
    )


def _extract_json(content):
    text = content.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1)
    try:
        return json.loads(text)
    except ValueError:
        pass
    # Some models wrap the JSON in a sentence; take the outermost object.
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except ValueError:
            pass
    raise _bad_format("it is not valid JSON")


def _to_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "yes"):
        return True
    if isinstance(value, str) and value.strip().lower() in ("false", "no"):
        return False
    return None


def gpu_hours_value(value):
    """Hours as a number on a half-hour grid within the booking limits, or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            return None
    if not isinstance(value, (int, float)) or value != value:  # NaN
        return None
    if not MIN_GPU_HOURS <= value <= MAX_GPU_HOURS:
        return None
    return max(MIN_GPU_HOURS, round(value * 2) / 2)


def normalize_gpu(value):
    """A clean {"needed", "hours", "reason", "source"} or None when unusable.

    Lenient on purpose: a bad GPU field never rejects the whole batch. Hours
    outside 0.5-336 become None ("needs a GPU, time unknown").
    """
    if not isinstance(value, dict):
        return None
    needed = _to_bool(value.get("needed"))
    if needed is None:
        return None
    reason = value.get("reason")
    reason = " ".join(reason.split())[:MAX_GPU_REASON] if isinstance(reason, str) else ""
    source = value.get("source") if value.get("source") in ("ai", "user") else "ai"
    hours = gpu_hours_value(value.get("hours")) if needed else None
    return {"needed": needed, "hours": hours, "reason": reason, "source": source}


def normalize_tasks(items, error=_bad_format):
    """Check the shape of a candidate batch and return clean dicts.

    Used for the model's reply and again for the batch the browser sends back.
    `error(reason)` builds the exception to raise.
    """
    if not isinstance(items, list) or not items:
        raise error('"tasks" must be a non-empty list')
    if len(items) > MAX_TASKS:
        raise error(f"at most {MAX_TASKS} tasks are allowed, got {len(items)}")
    clean, seen = [], set()
    for i, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise error(f"task {i} is not an object")
        tid = item.get("id")
        if isinstance(tid, int) and not isinstance(tid, bool):
            tid = str(tid)
        if not isinstance(tid, str) or not tid.strip():
            raise error(f'task {i} has no "id"')
        tid = tid.strip()
        if tid in seen:
            raise error(f'id "{tid}" is used more than once')
        seen.add(tid)
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            raise error(f'task "{tid}" has no "title"')
        description = item.get("description") or ""
        if not isinstance(description, str):
            raise error(f'task "{tid}" has a "description" that is not text')
        prereqs = item.get("prerequisites", [])
        if prereqs is None:
            prereqs = []
        if not isinstance(prereqs, list):
            raise error(f'task "{tid}" has "prerequisites" that is not a list')
        ids = []
        for p in prereqs:
            if isinstance(p, int) and not isinstance(p, bool):
                p = str(p)
            if not isinstance(p, str) or not p.strip():
                raise error(f'task "{tid}" has a prerequisite that is not an id')
            if p.strip() not in ids:
                ids.append(p.strip())
        task = {
            "id": tid,
            "title": " ".join(title.split())[:MAX_TITLE],
            "description": " ".join(description.split())[:MAX_DESCRIPTION],
            "prerequisites": ids,
        }
        gpu = normalize_gpu(item.get("gpu"))
        if gpu is not None:  # missing or unusable: the task simply has no estimate
            task["gpu"] = gpu
        clean.append(task)
    return clean


def parse_suggestions(content):
    """{"tasks": [...], "reply": None} or, when the message had no work to plan,
    {"tasks": [], "reply": "..."}. A reply next to real tasks is ignored."""
    data = _extract_json(content)
    if isinstance(data, list):  # tolerate a bare list of tasks
        data = {"tasks": data}
    if not isinstance(data, dict) or "tasks" not in data:
        raise _bad_format('the "tasks" list is missing')
    reply = data.get("reply")
    reply = reply.strip()[:MAX_REPLY] if isinstance(reply, str) else ""
    if data["tasks"] in (None, []) and reply:
        return {"tasks": [], "reply": reply}
    return {"tasks": normalize_tasks(data["tasks"]), "reply": None}


def parse_gpu_estimate(content):
    data = _extract_json(content)
    if isinstance(data, dict) and isinstance(data.get("gpu"), dict):
        data = data["gpu"]  # tolerate the bare object without the "gpu" wrapper too
    gpu = normalize_gpu(data)
    if gpu is None:
        raise _bad_format('"gpu.needed" must be true or false')
    return {**gpu, "source": "ai"}


def find_cycle(prereqs):
    """Return one cycle as a list of ids (first id repeated at the end), or None."""
    state, stack = {}, []

    def visit(node):
        state[node] = "visiting"
        stack.append(node)
        for dep in prereqs.get(node, []):
            if dep not in prereqs:
                continue
            if state.get(dep) == "visiting":
                return stack[stack.index(dep):] + [dep]
            if dep not in state:
                found = visit(dep)
                if found:
                    return found
        stack.pop()
        state[node] = "done"
        return None

    for node in prereqs:
        if node not in state:
            found = visit(node)
            if found:
                return found
    return None


def validate_batch(tasks, existing_titles):
    """Dependency problems in a normalized batch, as user-facing messages.

    existing_titles: {task_id: title} of tasks already on the board.
    """
    problems = []
    batch_ids = {t["id"] for t in tasks}
    by_id = {t["id"]: t for t in tasks}
    for t in tasks:
        if t["id"] in existing_titles:
            problems.append(
                f'Temporary id "{t["id"]}" is already used by the board task “{existing_titles[t["id"]]}”.'
            )
        for p in t["prerequisites"]:
            if p not in batch_ids and p not in existing_titles:
                problems.append(f'Prerequisite "{p}" of “{t["title"]}” does not exist.')
    cycle = find_cycle({t["id"]: [p for p in t["prerequisites"] if p in batch_ids] for t in tasks})
    if cycle:
        path = " → ".join(f"“{by_id[c]['title']}”" for c in cycle)
        problems.append(f"Circular dependency: {path}.")
    return problems


# ---------- the suggester used by the app ----------

def resolve_provider(environ):
    """(Provider, None) for a valid AI_PROVIDER, else (None, error message)."""
    value = (environ.get(PROVIDER_ENV) or DEFAULT_PROVIDER).strip().lower()
    provider = PROVIDERS.get(value)
    if provider is None:
        options = " or ".join(PROVIDERS)
        return None, f'Unknown {PROVIDER_ENV} "{value}". Use {options}, then restart the server.'
    return provider, None


class AiSuggester:
    """Reads AI_PROVIDER and the matching key on every request. Only the
    selected provider is ever called."""

    def __init__(self, urlopen=urllib.request.urlopen, environ=os.environ):
        self._urlopen = urlopen
        self._environ = environ

    def _api_key(self, provider):
        return (self._environ.get(provider.key_env) or "").strip()

    def status(self):
        """What the AI Assistant panel shows. Never includes the key itself."""
        provider, problem = resolve_provider(self._environ)
        if problem:
            return {"configured": False, "provider": None, "providerName": None,
                    "model": None, "keyEnv": None, "configError": problem}
        return {
            "configured": bool(self._api_key(provider)),
            "provider": provider.key,
            "providerName": provider.name,
            "model": provider.model,
            "keyEnv": provider.key_env,
        }

    @property
    def model(self):
        provider, _ = resolve_provider(self._environ)
        return provider.model if provider else None

    @property
    def provider_name(self):
        provider, _ = resolve_provider(self._environ)
        return provider.name if provider else None

    def configured(self):
        return self.status()["configured"]

    def _provider_and_key(self):
        provider, problem = resolve_provider(self._environ)
        if problem:
            raise SuggestionError("invalid_provider", problem, 503)
        key = self._api_key(provider)
        if not key:
            raise SuggestionError(
                "missing_key",
                f"The AI assistant is set to use {provider.name} ({PROVIDER_ENV}={provider.key}), but "
                f"{provider.key_env} is not set. Set {provider.key_env} in the PowerShell window that "
                "starts Flask, then restart the server.",
                503,
            )
        return provider, key

    def suggest(self, description, existing_tasks):
        """{"tasks": [...], "reply": None}, or {"tasks": [], "reply": "..."} when
        the message is not work to plan (a greeting, an unrelated question)."""
        provider, key = self._provider_and_key()
        content = call_chat(provider, build_messages(description, existing_tasks), key, urlopen=self._urlopen)
        return parse_suggestions(content)

    def estimate_gpu(self, title, description):
        """{"needed", "hours", "reason", "source": "ai"} for one task."""
        provider, key = self._provider_and_key()
        content = call_chat(provider, build_gpu_messages(title, description), key, urlopen=self._urlopen)
        return parse_gpu_estimate(content)
