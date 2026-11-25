/*
 * Local calendar dates as "YYYY-MM-DD" strings (no time zone shifts), used by
 * the date-based Timeline and the Scheduling section of the task details.
 * Weeks start on Monday.
 */

const pad = (n) => String(n).padStart(2, "0");

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr() {
  return toDateStr(new Date());
}

export function parseDateStr(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Monday of the week containing dateStr. */
export function startOfWeek(dateStr) {
  const d = parseDateStr(dateStr);
  const offset = (d.getDay() + 6) % 7; // Mon = 0 ... Sun = 6
  d.setDate(d.getDate() - offset);
  return toDateStr(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  return Math.round((parseDateStr(b) - parseDateStr(a)) / 86400000);
}

export const dayName = (s) => parseDateStr(s).toLocaleDateString("en-US", { weekday: "short" });
export const monthDay = (s) => parseDateStr(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "Nov 24" for one day, "Nov 24 – Nov 26" for a range. */
export function formatPlanned(start, end) {
  return start === end ? monthDay(start) : `${monthDay(start)} – ${monthDay(end)}`;
}

/** A task is on the Timeline only when both planned dates are set. */
export const isScheduled = (task) => Boolean(task.plannedStart && task.plannedEnd);
