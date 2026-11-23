/*
 * Card layout for one member's column of the week Timeline (WeekTimeline.jsx).
 *
 * Rows come from the planned dates (inclusive, "YYYY-MM-DD"). Lanes are only
 * for cards that overlap: cards are split into overlap groups (connected by
 * shared days, also through chains: A-B and B-C put A, B and C in one group),
 * and each group divides the full column width among its own lanes. A card
 * that overlaps nothing gets the whole width.
 *
 * The column grid has `slots` = least common multiple of every group's lane
 * count; a card spans `slots / groupLanes` of them. Pure functions, no DOM.
 */
import { addDays, daysBetween, isScheduled } from "./dates.js";

const DAYS = 7;

/** Inclusive date ranges share at least one day. */
export const overlaps = (a, b) => a.plannedStart <= b.plannedEnd && b.plannedStart <= a.plannedEnd;

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a * b) / gcd(a, b);

/** Deterministic order: start, then the longer card first, then id. */
function compareCards(a, b) {
  return (
    a.plannedStart.localeCompare(b.plannedStart) ||
    b.plannedEnd.localeCompare(a.plannedEnd) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/** Split date-sorted tasks into groups connected by overlaps (including chains). */
export function overlapGroups(sortedTasks) {
  const groups = [];
  let current = null;
  let currentEnd = "";
  for (const t of sortedTasks) {
    if (current && t.plannedStart <= currentEnd) {
      current.push(t);
      if (t.plannedEnd > currentEnd) currentEnd = t.plannedEnd;
    } else {
      current = [t];
      currentEnd = t.plannedEnd;
      groups.push(current);
    }
  }
  return groups;
}

/** Lane per task inside one group: the first lane whose last card ended before it starts. */
function assignLanes(group) {
  const laneEnds = [];
  const lanes = new Map();
  for (const t of group) {
    let lane = laneEnds.findIndex((end) => end < t.plannedStart);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = t.plannedEnd;
    lanes.set(t.id, lane);
  }
  return { lanes, count: laneEnds.length };
}

/**
 * Layout of one member's tasks for the week starting on `weekStart` (a Monday).
 * Returns { items, slots, maxLanes }; each item has the task, its grid rows,
 * its lane within its group, its grid column span, and week-boundary flags.
 * Only the visible part of the week decides overlaps.
 */
export function layoutMember(tasks, weekStart) {
  const weekEnd = addDays(weekStart, DAYS - 1);
  const visible = tasks
    .filter((t) => isScheduled(t) && t.plannedStart <= weekEnd && t.plannedEnd >= weekStart)
    .map((t) => ({
      task: t,
      id: t.id,
      // Clip to the week, so overlaps outside it don't split cards here.
      plannedStart: t.plannedStart < weekStart ? weekStart : t.plannedStart,
      plannedEnd: t.plannedEnd > weekEnd ? weekEnd : t.plannedEnd,
    }))
    .sort(compareCards);

  const groups = overlapGroups(visible).map((group, index) => ({ index, group, ...assignLanes(group) }));
  const slots = groups.reduce((acc, g) => lcm(acc, g.count), 1);

  const items = [];
  for (const g of groups) {
    const span = slots / g.count;
    for (const v of g.group) {
      const lane = g.lanes.get(v.id);
      items.push({
        task: v.task,
        group: g.index,
        lane,
        groupLanes: g.count,
        rowStart: daysBetween(weekStart, v.plannedStart) + 1,
        rowEnd: daysBetween(weekStart, v.plannedEnd) + 2,
        colStart: lane * span + 1,
        colSpan: span,
        continuesBefore: v.task.plannedStart < weekStart,
        continuesAfter: v.task.plannedEnd > weekEnd,
      });
    }
  }
  return { items, slots, maxLanes: Math.max(1, ...groups.map((g) => g.count)) };
}
