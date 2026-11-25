/*
 * Workload of a task: estimated human work hours (workHours) and a 1-5 star
 * difficulty (difficulty), independent of each other and of the GPU hours.
 * workSource is "ai" (an AI estimate, shown as such) or "user" (set or
 * confirmed by a person). Work hours never decide the planned dates.
 */
import { daysBetween } from "./dates.js";

export const MAX_STARS = 5;

export const DIFFICULTY_LABEL = {
  1: "Routine: familiar work",
  2: "Easy: the method is clear",
  3: "Moderate: needs some research or debugging",
  4: "Hard: new technique or uncertain outcome",
  5: "Very hard: research-level, high risk",
};

/** "★★★☆☆" for 3, or "" when there is no difficulty. */
export function starText(difficulty) {
  if (!difficulty) return "";
  return "★".repeat(difficulty) + "☆".repeat(MAX_STARS - difficulty);
}

const formatWorkHours = (h) => {
  const v = Math.round(h * 2) / 2;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}h`;
};

// workSource is for the hours, difficultySource for the stars: the AI may have
// filled one while a person set the other.
export const isAiHours = (task) => task.workHours != null && task.workSource === "ai";
export const isAiStars = (task) => Boolean(task.difficulty) && task.difficultySource === "ai";
/** Any part of the workload is still an unconfirmed AI estimate. */
export const isAiWork = (task) => isAiHours(task) || isAiStars(task);

/** Short workload text for cards and tooltips: "~4h · ★★★☆☆ (AI estimate)". */
export function workText(task, { ai = true } = {}) {
  const parts = [];
  if (task.workHours != null) parts.push(`${isAiHours(task) ? "~" : ""}${formatWorkHours(task.workHours)} work`);
  if (task.difficulty) parts.push(starText(task.difficulty));
  if (parts.length === 0) return "";
  return parts.join(" · ") + (ai && isAiWork(task) ? " (AI estimate)" : "");
}

export { formatWorkHours };

/**
 * Work hours of one member's tasks that fall in [weekStart, weekEnd], completed
 * ones included, so someone who finished early still shows their week's work.
 * A task spanning several weeks counts with the share of its planned days that
 * are in this week, so totals stay comparable week to week.
 *
 * Returns { hours, done, ready, waiting, counted, missing }: hours = all of the
 * week's work, split by task state into done (completed), ready (can start)
 * and waiting (prerequisites not completed); counted = tasks with hours,
 * missing = scheduled tasks in the week without an estimate.
 */
export function memberWeekWork(tasks, memberId, weekStart, weekEnd) {
  let hours = 0;
  let done = 0;
  let ready = 0;
  let waiting = 0;
  let counted = 0;
  let missing = 0;
  for (const t of tasks) {
    if (t.assigneeId !== memberId || !t.plannedStart || !t.plannedEnd) continue;
    if (t.plannedEnd < weekStart || t.plannedStart > weekEnd) continue;
    if (t.workHours == null) {
      missing += 1;
      continue;
    }
    const total = daysBetween(t.plannedStart, t.plannedEnd) + 1;
    const from = t.plannedStart > weekStart ? t.plannedStart : weekStart;
    const to = t.plannedEnd < weekEnd ? t.plannedEnd : weekEnd;
    const inWeek = daysBetween(from, to) + 1;
    const share = (t.workHours * inWeek) / total;
    hours += share;
    if (t.status === "done") done += share;
    else if (t.blocked) waiting += share;
    else ready += share;
    counted += 1;
  }
  const round = (h) => Math.round(h * 10) / 10;
  return { hours: round(hours), done: round(done), ready: round(ready), waiting: round(waiting), counted, missing };
}
