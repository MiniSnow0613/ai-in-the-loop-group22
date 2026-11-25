"""Database connector supporting local SQLite and Turso (libSQL Hrana HTTP v2).

When TURSO_DATABASE_URL is set (and no explicit local file path is passed, e.g.
from tests), connect() returns a TursoConnection backed by Turso's HTTP v2
pipeline API using Python's stdlib urllib — no extra packages or native builds
required. Otherwise it opens a standard local SQLite database.
"""
import base64
import json
import os
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path

TURSO_URL_ENV = "TURSO_DATABASE_URL"
TURSO_TOKEN_ENV = "TURSO_AUTH_TOKEN"
TURSO_TIMEOUT_SECONDS = 30
USER_AGENT = "group22-coordination-board/0.1"


def is_turso_url(target):
    if not isinstance(target, str):
        return False
    lower = target.strip().lower()
    return lower.startswith(("libsql://", "https://", "http://"))


def resolve_db_target(db_path=None, default_path=None, environ=None):
    """Return a Turso URL or local filesystem path string."""
    env = os.environ if environ is None else environ
    if db_path is not None:
        return str(db_path)
    turso_url = (env.get(TURSO_URL_ENV) or "").strip()
    if turso_url:
        return turso_url
    board_path = (env.get("BOARD_DB_PATH") or "").strip()
    if board_path:
        return board_path
    return str(default_path)


def _pipeline_url(url):
    u = url.strip().rstrip("/")
    if u.lower().startswith("libsql://"):
        u = "https://" + u[len("libsql://"):]
    if not u.endswith("/v2/pipeline"):
        u += "/v2/pipeline"
    return u


def _encode_arg(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": "1" if value else "0"}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    if isinstance(value, (bytes, bytearray)):
        return {"type": "blob", "base64": base64.b64encode(bytes(value)).decode("ascii")}
    return {"type": "text", "value": str(value)}


def _decode_cell(cell):
    kind = cell.get("type")
    if kind == "null":
        return None
    if kind == "integer":
        return int(cell["value"])
    if kind == "float":
        return float(cell["value"])
    if kind == "blob":
        return base64.b64decode(cell["base64"])
    return cell.get("value")


def _split_sql_script(script):
    """Split a semicolon-delimited SQL script into individual statements."""
    statements = []
    buf = []
    in_single = False
    in_double = False
    i = 0
    n = len(script)
    while i < n:
        ch = script[i]
        nxt = script[i + 1] if i + 1 < n else ""
        if not in_single and not in_double and ch == "-" and nxt == "-":
            while i < n and script[i] != "\n":
                i += 1
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == ";" and not in_single and not in_double:
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def _needs_transaction(sql):
    head = sql.lstrip()
    while head.startswith("--"):
        nl = head.find("\n")
        head = "" if nl == -1 else head[nl + 1:].lstrip()
    first = head.split(None, 1)[0].upper() if head else ""
    return first in {"INSERT", "UPDATE", "DELETE", "REPLACE"}


def _sqlite_error_from_message(message):
    upper = (message or "").upper()
    if any(k in upper for k in ("CONSTRAINT", "UNIQUE", "FOREIGN KEY", "NOT NULL", "CHECK")):
        return sqlite3.IntegrityError(message)
    return sqlite3.OperationalError(message)


class TursoRow:
    """Minimal sqlite3.Row-compatible mapping/sequence."""

    def __init__(self, columns, values):
        self._columns = tuple(columns)
        self._values = tuple(values)
        self._index = {col: idx for idx, col in enumerate(self._columns)}

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        try:
            return self._values[self._index[key]]
        except KeyError:
            raise IndexError(f"No item with that key: {key}") from None

    def keys(self):
        return list(self._columns)

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __eq__(self, other):
        if isinstance(other, TursoRow):
            return self._columns == other._columns and self._values == other._values
        return self._values == other


class TursoCursor:
    """Minimal sqlite3.Cursor-compatible result wrapper."""

    def __init__(self, rows=None, rowcount=-1):
        self._rows = list(rows or [])
        self._pos = 0
        self.rowcount = rowcount

    def fetchone(self):
        if self._pos >= len(self._rows):
            return None
        row = self._rows[self._pos]
        self._pos += 1
        return row

    def fetchall(self):
        rest = self._rows[self._pos:]
        self._pos = len(self._rows)
        return rest

    def __iter__(self):
        return iter(self.fetchall())


class TursoConnection:
    """sqlite3.Connection-like client for Turso's Hrana HTTP v2 pipeline API."""

    def __init__(self, url, auth_token="", urlopen=urllib.request.urlopen):
        self._url = _pipeline_url(url)
        self._auth_token = (auth_token or "").strip()
        self._urlopen = urlopen
        self._baton = None
        self._in_tx = False
        self._closed = False
        self._fk_initialized = False

    def _send(self, requests_list):
        if self._closed:
            raise sqlite3.ProgrammingError("Cannot operate on a closed database.")
        payload = {"baton": self._baton, "requests": requests_list}
        headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        if self._auth_token:
            headers["Authorization"] = f"Bearer {self._auth_token}"
        req = urllib.request.Request(
            self._url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with self._urlopen(req, timeout=TURSO_TIMEOUT_SECONDS) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:300]
            raise sqlite3.OperationalError(f"Turso HTTP {e.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
            raise sqlite3.OperationalError(f"Turso request failed: {e}") from None

        if body.get("base_url"):
            self._url = _pipeline_url(body["base_url"])
        self._baton = body.get("baton")

        results = body.get("results", [])
        parsed = []
        for item in results:
            if item.get("type") == "error":
                err = item.get("error") or {}
                raise _sqlite_error_from_message(err.get("message") or "Turso execution error")
            resp_obj = item.get("response") or {}
            parsed.append(resp_obj.get("result") or {})
        return parsed

    def _stmt_req(self, sql, params=()):
        stmt = {"sql": sql}
        if params:
            stmt["args"] = [_encode_arg(v) for v in params]
        return {"type": "execute", "stmt": stmt}

    def _prefix_requests(self, start_tx=False):
        reqs = []
        if not self._fk_initialized:
            reqs.append(self._stmt_req("PRAGMA foreign_keys = ON"))
            self._fk_initialized = True
        if start_tx and not self._in_tx:
            reqs.append(self._stmt_req("BEGIN"))
            self._in_tx = True
        return reqs

    @staticmethod
    def _cursor_from_result(result):
        cols = [c.get("name", "") for c in result.get("cols", [])]
        rows = [
            TursoRow(cols, [_decode_cell(cell) for cell in raw_row])
            for raw_row in result.get("rows", [])
        ]
        affected = result.get("affected_row_count")
        return TursoCursor(rows=rows, rowcount=affected if affected is not None else -1)

    def execute(self, sql, params=()):
        reqs = self._prefix_requests(start_tx=_needs_transaction(sql))
        reqs.append(self._stmt_req(sql, params))
        results = self._send(reqs)
        return self._cursor_from_result(results[-1])

    def executemany(self, sql, seq_of_params):
        items = list(seq_of_params)
        if not items:
            return TursoCursor(rows=[], rowcount=0)
        reqs = self._prefix_requests(start_tx=_needs_transaction(sql))
        offset = len(reqs)
        for params in items:
            reqs.append(self._stmt_req(sql, params))
        results = self._send(reqs)
        total = sum(r.get("affected_row_count", 0) for r in results[offset:])
        return TursoCursor(rows=[], rowcount=total)

    def executescript(self, sql_script):
        if self._in_tx:
            self.commit()
        stmts = _split_sql_script(sql_script)
        if not stmts:
            return TursoCursor()
        reqs = self._prefix_requests(start_tx=False)
        for stmt in stmts:
            reqs.append(self._stmt_req(stmt))
        self._send(reqs)
        return TursoCursor()

    def commit(self):
        if self._in_tx:
            self._send([self._stmt_req("COMMIT")])
            self._in_tx = False

    def rollback(self):
        if self._in_tx:
            try:
                self._send([self._stmt_req("ROLLBACK")])
            finally:
                self._in_tx = False

    def close(self):
        if self._closed:
            return
        try:
            if self._baton is not None:
                reqs = []
                if self._in_tx:
                    reqs.append(self._stmt_req("ROLLBACK"))
                    self._in_tx = False
                reqs.append({"type": "close"})
                try:
                    self._send(reqs)
                except sqlite3.Error:
                    pass
        finally:
            self._baton = None
            self._in_tx = False
            self._closed = True


def connect(target, auth_token=None, urlopen=urllib.request.urlopen, environ=None):
    """Open either a TursoConnection (for URLs) or a local sqlite3 connection."""
    env = os.environ if environ is None else environ
    target_str = str(target)
    if is_turso_url(target_str):
        token = auth_token if auth_token is not None else env.get(TURSO_TOKEN_ENV, "")
        return TursoConnection(target_str, auth_token=token, urlopen=urlopen)

    Path(target_str).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target_str)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn
