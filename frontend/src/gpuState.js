// Shared helpers for GPU bookings: card bands, the GPU schedule tab, task details.
// Booking times are local "YYYY-MM-DDTHH:MM" strings (same format as <input type="datetime-local">).

export const ACTIVE_BOOKING = new Set(["planned", "running"]);

export const KIND_LABEL = {
  planned: "Booked",
  blocked: "Booked · prerequisites not completed",
  running: "Running",
  done: "Finished",
  external: "Other use",
};

/** Colour/state of a booking. "blocked" = planned, but the task can't start yet. */
export function bookingKind(b) {
  if (b.status === "done") return "done";
  if (!b.taskId) return "external";
  if (b.status === "running") return "running";
  return b.taskBlocked ? "blocked" : "planned";
}

/** "lab-server / GPU 0" -> "GPU 0" (the part after the last slash). */
export function shortGpuName(name) {
  return name.split(" / ").pop();
}

export function bookingTitle(b) {
  return b.taskId ? b.taskTitle : b.label;
}

const pad = (n) => String(n).padStart(2, "0");

export function parseTime(s) {
  const [date, time] = s.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
}

export function toTimeString(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addMinutes(d, minutes) {
  return new Date(d.getTime() + minutes * 60000);
}

export function sameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/** Now, rounded up to the next half hour. */
export function nextHalfHour(now = new Date()) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  d.setMinutes(m === 0 || m === 30 ? m : m < 30 ? 30 : 60);
  return d;
}

function dayLabel(d, today) {
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, addMinutes(startOfDay(today), 24 * 60))) return "Tomorrow";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "Today 14:00–20:00", "11/17 22:00 – 11/18 06:00"; an end at midnight shows as 24:00. */
export function formatRange(startAt, endAt, today = new Date()) {
  const s = parseTime(startAt);
  const e = parseTime(endAt);
  const endsAtMidnight = e.getHours() === 0 && e.getMinutes() === 0;
  if (sameDay(s, e) || (endsAtMidnight && sameDay(s, addMinutes(e, -1)))) {
    return `${dayLabel(s, today)} ${clock(s)}–${sameDay(s, e) ? clock(e) : "24:00"}`;
  }
  return `${dayLabel(s, today)} ${clock(s)} – ${dayLabel(e, today)} ${clock(e)}`;
}

/** Bookings on this GPU that block [startAt, endAt) (half-open, like the server). */
export function findConflicts(bookings, gpuId, startAt, endAt, excludeId = null) {
  return bookings.filter(
    (b) =>
      b.gpuId === gpuId &&
      b.id !== excludeId &&
      ACTIVE_BOOKING.has(b.status) &&
      b.startAt < endAt &&
      startAt < b.endAt,
  );
}

/** Earliest start >= from on this GPU where `minutes` fit without overlap. */
export function earliestFree(bookings, gpuId, from, minutes) {
  let start = from.getTime();
  const busy = bookings
    .filter((b) => b.gpuId === gpuId && ACTIVE_BOOKING.has(b.status))
    .map((b) => [parseTime(b.startAt).getTime(), parseTime(b.endAt).getTime()])
    .sort((a, b) => a[0] - b[0]);
  for (const [s, e] of busy) {
    if (e <= start) continue;
    if (s >= start + minutes * 60000) break;
    start = Math.max(start, e);
  }
  return new Date(start);
}

/** Earliest free slot across the given GPUs; ties go to the preferred GPU. */
export function earliestSlot(bookings, gpuIds, preferredId, from, minutes) {
  let best = null;
  for (const gpuId of gpuIds) {
    const start = earliestFree(bookings, gpuId, from, minutes);
    const better =
      !best ||
      start < best.start ||
      (start.getTime() === best.start.getTime() && gpuId === preferredId);
    if (better) best = { gpuId, start };
  }
  return best && {
    gpuId: best.gpuId,
    startAt: toTimeString(best.start),
    endAt: toTimeString(addMinutes(best.start, minutes)),
  };
}

/** The text on a card's GPU band, or null when the card has none. */
export function cardBand(task) {
  const b = task.gpuBooking;
  if (b) {
    const kind = bookingKind(b);
    const gpu = shortGpuName(b.gpuName);
    if (kind === "done") return { kind, text: `${gpu} · Finished` };
    if (kind === "running") return { kind, text: `${gpu} · Running · ${formatRange(b.startAt, b.endAt)}` };
    const text = `${gpu} · ${formatRange(b.startAt, b.endAt)}`;
    return { kind, text: kind === "blocked" ? `${text} · can't start yet` : text };
  }
  if (task.needsGpu && task.status !== "done") return { kind: "need", text: "Needs a GPU · not booked" };
  return null;
}
