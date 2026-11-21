/** Error from the API, with the server's message and machine-readable code. */
export class ApiError extends Error {
  constructor(message, { status, code, retryAfter } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function request(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError("Could not reach the server. Is Flask still running?", { code: "offline" });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || `HTTP ${res.status}`, {
      status: res.status,
      code: data.code,
      retryAfter: data.retryAfter,
    });
  }
  return data;
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function fetchBoard() {
  return request("/api/board");
}

export function updateTask(taskId, changes) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}`, json("PATCH", changes));
}

export function fetchAiStatus() {
  return request("/api/ai/status");
}

/** Ask for candidate tasks. Nothing is saved yet. */
export function requestSuggestions(description) {
  return request("/api/suggestions", json("POST", { description }));
}

/** Save a previewed batch; the server validates dependencies first. */
export function acceptSuggestions(tasks) {
  return request("/api/suggestions/accept", json("POST", { tasks }));
}
