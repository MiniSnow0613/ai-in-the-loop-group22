const AI_OVERRIDE_STORAGE = "group22_ai_override";
const PASSCODE_STORAGE = "group22_board_passcode";

/** Error from the API, with the server's message and machine-readable code. */
export class ApiError extends Error {
  constructor(message, { status, code, retryAfter } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function getAiOverride() {
  try {
    const raw = window.localStorage.getItem(AI_OVERRIDE_STORAGE);
    if (!raw) return { provider: "", apiKey: "" };
    const parsed = JSON.parse(raw);
    return {
      provider: typeof parsed?.provider === "string" ? parsed.provider : "",
      apiKey: typeof parsed?.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    return { provider: "", apiKey: "" };
  }
}

export function setAiOverride({ provider = "", apiKey = "" }) {
  const clean = { provider: provider.trim(), apiKey: apiKey.trim() };
  try {
    if (!clean.provider && !clean.apiKey) {
      window.localStorage.removeItem(AI_OVERRIDE_STORAGE);
    } else {
      window.localStorage.setItem(AI_OVERRIDE_STORAGE, JSON.stringify(clean));
    }
  } catch {
    // Ignore storage quota/privacy mode failures.
  }
}

export function clearAiOverride() {
  setAiOverride({ provider: "", apiKey: "" });
}

export function getBoardPasscode() {
  try {
    return window.localStorage.getItem(PASSCODE_STORAGE) || "";
  } catch {
    return "";
  }
}

export function setBoardPasscode(passcode) {
  try {
    if (passcode) {
      window.localStorage.setItem(PASSCODE_STORAGE, passcode);
    } else {
      window.localStorage.removeItem(PASSCODE_STORAGE);
    }
  } catch {
    // Ignore storage quota/privacy mode failures.
  }
}

export function clearBoardPasscode() {
  setBoardPasscode("");
}

function buildHeaders(extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  const passcode = getBoardPasscode();
  if (passcode) headers["X-Board-Passcode"] = passcode;
  const { provider, apiKey } = getAiOverride();
  if (provider) headers["X-AI-Provider"] = provider;
  if (apiKey) headers["X-AI-Key"] = apiKey;
  return headers;
}

async function request(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, headers: buildHeaders(options.headers) });
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

export function fetchAuthStatus() {
  return request("/api/auth/status");
}

export function verifyPasscode(passcode) {
  return request("/api/auth/verify", json("POST", { passcode }));
}

export function fetchBoard() {
  return request("/api/board");
}

export function updateTask(taskId, changes) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}`, json("PATCH", changes));
}

/** Add one task by hand: { title, description, prerequisites: [board task ids] }. */
export function createTask(task) {
  return request("/api/tasks", json("POST", task));
}

/** Ask the AI (in the background) whether a task needs a GPU and for how long. */
export function requestGpuEstimate(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/gpu-estimate`, { method: "POST" });
}

export function deleteTask(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
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

// ---------- GPU schedule ----------
// Writes return { schedule, board, ... } so both the GPU tab and the cards refresh.

export function fetchGpuSchedule() {
  return request("/api/gpus");
}

export function createGpu(gpu) {
  return request("/api/gpus", json("POST", gpu));
}

export function updateGpu(gpuId, changes) {
  return request(`/api/gpus/${encodeURIComponent(gpuId)}`, json("PATCH", changes));
}

export function deleteGpu(gpuId) {
  return request(`/api/gpus/${encodeURIComponent(gpuId)}`, { method: "DELETE" });
}

/** Add the GPUs nvidia-smi finds on the machine running the server. */
export function detectGpus() {
  return request("/api/gpus/detect", { method: "POST" });
}

export function createBooking(booking) {
  return request("/api/gpu-bookings", json("POST", booking));
}

export function updateBooking(bookingId, changes) {
  return request(`/api/gpu-bookings/${encodeURIComponent(bookingId)}`, json("PATCH", changes));
}

export function deleteBooking(bookingId) {
  return request(`/api/gpu-bookings/${encodeURIComponent(bookingId)}`, { method: "DELETE" });
}
