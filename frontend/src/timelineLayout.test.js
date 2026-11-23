// Run with: npm test (from frontend/). Uses Node's built-in test runner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutMember, overlapGroups, overlaps } from "./timelineLayout.js";

const WEEK = "2026-11-23"; // Monday

const task = (id, plannedStart, plannedEnd) => ({ id, plannedStart, plannedEnd });

/** id -> [colStart, colSpan, slots] for compact assertions. */
function columns(tasks, week = WEEK) {
  const { items, slots } = layoutMember(tasks, week);
  return Object.fromEntries(items.map((i) => [i.task.id, [i.colStart, i.colSpan, slots]]));
}

test("inclusive dates: sharing the last day counts as an overlap", () => {
  assert.equal(overlaps(task("a", "2026-11-27", "2026-11-28"), task("b", "2026-11-28", "2026-11-29")), true);
  assert.equal(overlaps(task("a", "2026-11-23", "2026-11-25"), task("b", "2026-11-26", "2026-11-27")), false);
});

test("screenshot case: a task that overlaps nothing gets the full width", () => {
  const cols = columns([
    task("build-api", "2026-11-23", "2026-11-25"),
    task("integrate", "2026-11-27", "2026-11-28"),
    task("gpu-tests", "2026-11-28", "2026-11-29"),
  ]);
  // 2 slots: the lone task spans both, the overlapping pair gets one each, side by side.
  assert.deepEqual(cols["build-api"], [1, 2, 2]);
  assert.deepEqual(cols.integrate, [1, 1, 2]);
  assert.deepEqual(cols["gpu-tests"], [2, 1, 2]);
});

test("non-overlapping tasks each use the full width", () => {
  const cols = columns([
    task("a", "2026-11-23", "2026-11-24"),
    task("b", "2026-11-25", "2026-11-25"),
    task("c", "2026-11-26", "2026-11-29"),
  ]);
  for (const id of ["a", "b", "c"]) assert.deepEqual(cols[id], [1, 1, 1]);
});

test("direct overlap: the pair shares the width, other groups do not", () => {
  const { items } = layoutMember(
    [task("x", "2026-11-23", "2026-11-23"), task("p", "2026-11-25", "2026-11-26"), task("q", "2026-11-26", "2026-11-27")],
    WEEK
  );
  const byId = Object.fromEntries(items.map((i) => [i.task.id, i]));
  assert.equal(byId.x.groupLanes, 1);
  assert.equal(byId.p.group, byId.q.group);
  assert.notEqual(byId.x.group, byId.p.group);
  assert.deepEqual([byId.p.lane, byId.q.lane], [0, 1]);
});

test("indirect chain: A-B and B-C form one group even though A and C do not overlap", () => {
  const tasks = [
    task("A", "2026-11-23", "2026-11-24"),
    task("B", "2026-11-24", "2026-11-26"),
    task("C", "2026-11-26", "2026-11-27"),
  ];
  assert.equal(overlaps(tasks[0], tasks[2]), false);
  const groups = overlapGroups(tasks);
  assert.deepEqual(groups.map((g) => g.map((t) => t.id)), [["A", "B", "C"]]);
  const cols = columns(tasks);
  // Two lanes are enough: C reuses A's lane because A ends before C starts.
  assert.deepEqual(cols.A, [1, 1, 2]);
  assert.deepEqual(cols.B, [2, 1, 2]);
  assert.deepEqual(cols.C, [1, 1, 2]);
});

test("groups with different lane counts share one grid (least common multiple)", () => {
  const cols = columns([
    task("pair1", "2026-11-23", "2026-11-23"),
    task("pair2", "2026-11-23", "2026-11-23"),
    task("tri1", "2026-11-26", "2026-11-26"),
    task("tri2", "2026-11-26", "2026-11-26"),
    task("tri3", "2026-11-26", "2026-11-26"),
  ]);
  // slots = lcm(2, 3) = 6: the pair gets halves, the triple gets thirds.
  assert.deepEqual([cols.pair1, cols.pair2], [[1, 3, 6], [4, 3, 6]]);
  assert.deepEqual([cols.tri1, cols.tri2, cols.tri3], [[1, 2, 6], [3, 2, 6], [5, 2, 6]]);
});

test("lane assignment is deterministic, whatever the input order", () => {
  const tasks = [
    task("b", "2026-11-24", "2026-11-25"),
    task("a", "2026-11-24", "2026-11-25"),
    task("long", "2026-11-24", "2026-11-28"),
  ];
  const first = columns(tasks);
  const reversed = columns([...tasks].reverse());
  assert.deepEqual(first, reversed);
  // Same start: the longer card first, then by id.
  assert.deepEqual([first.long[0], first.a[0], first.b[0]], [1, 2, 3]);
});

test("rows keep the multi-day height and clip at the week edges", () => {
  const { items } = layoutMember(
    [task("spans", "2026-11-20", "2026-11-25"), task("next", "2026-11-28", "2026-12-02")],
    WEEK
  );
  const byId = Object.fromEntries(items.map((i) => [i.task.id, i]));
  assert.deepEqual([byId.spans.rowStart, byId.spans.rowEnd, byId.spans.continuesBefore], [1, 4, true]);
  assert.deepEqual([byId.next.rowStart, byId.next.rowEnd, byId.next.continuesAfter], [6, 8, true]);
});

test("unscheduled tasks are left out", () => {
  const { items } = layoutMember([task("pool", null, null), task("half", "2026-11-24", null)], WEEK);
  assert.equal(items.length, 0);
});
