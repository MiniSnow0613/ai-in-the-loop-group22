// Run with: npm test (from frontend/). Uses Node's built-in test runner.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COL_GAP,
  layoutGraph,
  linkProblem,
  NODE_H,
  NODE_W,
  PAD,
  prerequisitesWith,
  relatedIds,
} from "./dependencyGraphLayout.js";

/** Board-shaped task: prerequisites / dependents are refs ({ id }) like /api/board returns. */
function board(spec) {
  const dependents = Object.fromEntries(spec.map((t) => [t.id, []]));
  for (const t of spec) for (const p of t.pre || []) dependents[p].push(t.id);
  return spec.map((t) => ({
    id: t.id,
    title: t.id,
    row: t.row,
    status: t.status || "todo",
    prerequisites: (t.pre || []).map((id) => ({ id })),
    dependents: dependents[t.id].map((id) => ({ id })),
  }));
}

/** level -> task ids from top to bottom. */
const columnsOf = (layout) => {
  const cols = {};
  for (const n of [...layout.nodes].sort((a, b) => a.y - b.y)) (cols[n.level] ||= []).push(n.task.id);
  return cols;
};
const nodeOf = (layout, id) => layout.nodes.find((n) => n.task.id === id);

test("columns follow the backend dependency level", () => {
  const layout = layoutGraph(
    board([
      { id: "a", row: 1 },
      { id: "b", row: 2, pre: ["a"] },
      { id: "c", row: 3, pre: ["b"] },
    ])
  );
  assert.deepEqual(columnsOf(layout), { 1: ["a"], 2: ["b"], 3: ["c"] });
  assert.equal(nodeOf(layout, "a").x, PAD);
  assert.equal(nodeOf(layout, "b").x, PAD + NODE_W + COL_GAP);
  assert.equal(layout.levels.length, 3);
});

test("an unrelated group starts below the lowest row of the group before it", () => {
  const layout = layoutGraph(
    board([
      { id: "a1", row: 1 },
      { id: "a2", row: 2, pre: ["a1"] },
      { id: "a3", row: 2, pre: ["a1"] }, // group A is two rows tall in level 2
      { id: "b1", row: 1 },
      { id: "b2", row: 2, pre: ["b1"] },
    ])
  );
  const bottomOfA = Math.max(...["a1", "a2", "a3"].map((id) => nodeOf(layout, id).y + NODE_H));
  assert.ok(nodeOf(layout, "b1").y > bottomOfA, "b1 shares no row with group A");
  assert.ok(nodeOf(layout, "b2").y > bottomOfA, "b2 shares no row with group A");
  assert.equal(nodeOf(layout, "b1").group, nodeOf(layout, "b2").group);
  assert.notEqual(nodeOf(layout, "a1").group, nodeOf(layout, "b1").group);
});

test("tasks without any dependency are drawn too, in the last band", () => {
  const layout = layoutGraph(
    board([
      { id: "alone", row: 1 },
      { id: "a", row: 1 },
      { id: "b", row: 2, pre: ["a"] },
    ])
  );
  assert.deepEqual(columnsOf(layout)[1], ["a", "alone"]);
  assert.equal(layout.nodes.length, 3);
});

test("a line that skips a level gets its own slot and crosses no box", () => {
  // Like the screenshot: aug (3) -> fine-tune (5) passes level 4, where other tasks sit.
  const layout = layoutGraph(
    board([
      { id: "pre", row: 2 },
      { id: "aug", row: 3, pre: ["pre"] },
      { id: "cnn", row: 3, pre: ["pre"] },
      { id: "train", row: 4, pre: ["cnn"] },
      { id: "other", row: 4, pre: ["cnn"] },
      { id: "tune", row: 5, pre: ["aug", "train"] },
    ])
  );
  const skip = layout.edges.find((e) => e.from === "aug" && e.to === "tune");
  assert.equal(skip.via.length, 1);
  const slot = skip.via[0];
  assert.equal(slot.level, 4);
  for (const n of layout.nodes.filter((n) => n.level === 4)) {
    assert.ok(slot.y + NODE_H <= n.y || slot.y >= n.y + NODE_H, `slot overlaps ${n.task.id}`);
  }
});

test("a column is ordered by where its neighbours are, to avoid crossing lines", () => {
  const layout = layoutGraph(
    board([
      { id: "top", row: 1 },
      { id: "bottom", row: 1 },
      { id: "afterBottom", row: 2, pre: ["bottom"] }, // listed first on the board
      { id: "afterTop", row: 2, pre: ["top"] },
      { id: "join", row: 3, pre: ["afterTop", "afterBottom"] }, // one group
    ])
  );
  const cols = columnsOf(layout);
  assert.equal(cols[1].indexOf("top") < cols[1].indexOf("bottom"), cols[2].indexOf("afterTop") < cols[2].indexOf("afterBottom"));
});

test("one edge per prerequisite, marked pending until the prerequisite is done", () => {
  const layout = layoutGraph(
    board([
      { id: "a", row: 1, status: "done" },
      { id: "b", row: 1 },
      { id: "c", row: 2, pre: ["a", "b"] },
    ])
  );
  const edges = Object.fromEntries(layout.edges.map((e) => [`${e.from}>${e.to}`, e.pending]));
  assert.deepEqual(edges, { "a>c": false, "b>c": true });
  assert.ok(layout.edges.every((e) => e.d.startsWith("M ")));
});

test("missing or zero levels fall back to level 1, and an empty board has no size", () => {
  const layout = layoutGraph(board([{ id: "x" }, { id: "y", row: 0 }]));
  assert.deepEqual(columnsOf(layout), { 1: ["x", "y"] });
  assert.deepEqual(layoutGraph([]), { nodes: [], edges: [], levels: [], width: 0, height: 0 });
});

test("a dependency cycle still lays out without slots", () => {
  const layout = layoutGraph(
    board([
      { id: "a", row: 1, pre: ["b"] },
      { id: "b", row: 2, pre: ["a"] },
    ])
  );
  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.edges.length, 2);
  assert.ok(layout.edges.every((e) => e.via.length === 0));
});

test("relatedIds walks all the way up and down, but not sideways", () => {
  const tasks = board([
    { id: "a", row: 1 },
    { id: "b", row: 2, pre: ["a"] },
    { id: "c", row: 3, pre: ["b"] },
    { id: "d", row: 4, pre: ["c"] },
    { id: "side", row: 2, pre: ["a"] },
  ]);
  const { up, down } = relatedIds(tasks, "c");
  assert.deepEqual([...up].sort(), ["a", "b"]);
  assert.deepEqual([...down], ["d"]);
});

test("relatedIds stops on a dependency cycle", () => {
  const tasks = board([
    { id: "a", row: 1, pre: ["b"] },
    { id: "b", row: 2, pre: ["a"] },
  ]);
  const { up, down } = relatedIds(tasks, "a");
  assert.deepEqual([...up], ["b"]);
  assert.deepEqual([...down], ["b"]);
});

test("linkProblem allows a new link and explains the ones the backend would reject", () => {
  const tasks = board([
    { id: "a", row: 1 },
    { id: "b", row: 2, pre: ["a"] },
    { id: "c", row: 3, pre: ["b"] },
    { id: "free", row: 1 },
    { id: "finished", row: 1, status: "done" },
  ]);
  assert.equal(linkProblem(tasks, "free", "c"), null);
  assert.equal(linkProblem(tasks, "a", "c"), null); // a shortcut is allowed
  assert.match(linkProblem(tasks, "c", "c"), /itself/);
  assert.match(linkProblem(tasks, "a", "b"), /already depends/);
  assert.match(linkProblem(tasks, "c", "a"), /Circular/); // a is upstream of c
  assert.match(linkProblem(tasks, "free", "finished"), /completed/);
  assert.equal(linkProblem(tasks, "finished", "free"), null);
});

test("prerequisitesWith returns the full new list for one task", () => {
  const tasks = board([
    { id: "a", row: 1 },
    { id: "b", row: 1 },
    { id: "c", row: 2, pre: ["a"] },
  ]);
  assert.deepEqual(prerequisitesWith(tasks, "c", "b", true), ["a", "b"]);
  assert.deepEqual(prerequisitesWith(tasks, "c", "a", true), ["a"]);
  assert.deepEqual(prerequisitesWith(tasks, "c", "a", false), []);
});
