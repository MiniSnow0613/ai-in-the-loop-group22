// Run with: npm test (from frontend/).
import assert from "node:assert/strict";
import { test } from "node:test";
import { memberWeekWork, starText, workText } from "./workload.js";

test("stars", () => {
  assert.equal(starText(3), "★★★☆☆");
  assert.equal(starText(5), "★★★★★");
  assert.equal(starText(null), "");
});

test("work text marks AI estimates", () => {
  assert.equal(workText({ workHours: 4, difficulty: 3, workSource: "ai" }), "~4h work · ★★★☆☆ (AI estimate)");
  assert.equal(workText({ workHours: 2.5, difficulty: null, workSource: "user" }), "2.5h work");
  assert.equal(workText({ workHours: null, difficulty: 2, difficultySource: "user" }), "★★☆☆☆");
  assert.equal(workText({ workHours: null, difficulty: null }), "");
  assert.equal(workText({ workHours: 4, difficulty: 1, workSource: "ai" }, { ai: false }), "~4h work · ★☆☆☆☆");
});

const task = (assigneeId, plannedStart, plannedEnd, workHours, status = "todo", blocked = false) => ({
  assigneeId, plannedStart, plannedEnd, workHours, status, blocked,
});

test("member week total: whole tasks in the week", () => {
  const tasks = [
    task("a", "2026-11-23", "2026-11-24", 6),
    task("a", "2026-11-26", "2026-11-26", 2),
    task("b", "2026-11-23", "2026-11-23", 9),
    task("a", null, null, 5), // in the Task Pool
    task("a", "2026-11-25", "2026-11-25", null),
    task("a", "2026-11-25", "2026-11-25", 4, "done"),
  ];
  // Completed work still counts toward the week (4h of it done).
  assert.deepEqual(memberWeekWork(tasks, "a", "2026-11-23", "2026-11-29"), { hours: 12, done: 4, ready: 8, waiting: 0, counted: 3, missing: 1 });
});

test("member week total: someone who finished early still shows their week", () => {
  const tasks = [task("a", "2026-11-23", "2026-11-24", 10, "done"), task("b", "2026-11-23", "2026-11-26", 10)];
  assert.deepEqual(memberWeekWork(tasks, "a", "2026-11-23", "2026-11-29"), { hours: 10, done: 10, ready: 0, waiting: 0, counted: 1, missing: 0 });
  assert.deepEqual(memberWeekWork(tasks, "b", "2026-11-23", "2026-11-29"), { hours: 10, done: 0, ready: 10, waiting: 0, counted: 1, missing: 0 });
});

test("member week total: a task across weeks counts its share of days", () => {
  // 10 days, 4 of them in this week -> 40% of 20h
  const tasks = [task("a", "2026-11-26", "2026-12-05", 20)];
  assert.deepEqual(memberWeekWork(tasks, "a", "2026-11-23", "2026-11-29"), { hours: 8, done: 0, ready: 8, waiting: 0, counted: 1, missing: 0 });
  assert.equal(memberWeekWork(tasks, "a", "2026-11-30", "2026-12-06").hours, 12);
});

test("hours and stars can come from different sources", () => {
  const mixed = { workHours: 10, workSource: "user", difficulty: 3, difficultySource: "ai" };
  assert.equal(workText(mixed), "10h work · ★★★☆☆ (AI estimate)"); // no "~": the hours are a person's
  assert.equal(workText({ workHours: 8, workSource: "ai", difficulty: 2, difficultySource: "user" }),
    "~8h work · ★★☆☆☆ (AI estimate)");
  assert.equal(workText({ workHours: 8, workSource: "user", difficulty: 2, difficultySource: "user" }), "8h work · ★★☆☆☆");
});

test("member week total: split into done, ready and waiting", () => {
  const tasks = [
    task("a", "2026-11-23", "2026-11-23", 3, "done"),
    task("a", "2026-11-24", "2026-11-24", 5), // can start
    task("a", "2026-11-25", "2026-11-25", 2, "todo", true), // waiting for a prerequisite
  ];
  assert.deepEqual(memberWeekWork(tasks, "a", "2026-11-23", "2026-11-29"),
    { hours: 10, done: 3, ready: 5, waiting: 2, counted: 3, missing: 0 });
});
