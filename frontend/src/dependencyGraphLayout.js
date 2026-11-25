/*
 * Layout for the dependency graph (DependencyGraph.jsx). Pure functions, no DOM.
 *
 * Columns are the dependency levels the backend already computes (`row`,
 * backend/app.py compute_rows): level 1 has no prerequisites, every other task
 * sits one level after its latest prerequisite. The graph is the only place
 * that uses `row`; Timeline cards are placed by planned dates.
 *
 * Two rules keep a line from looking like it belongs to an unrelated task:
 * - Tasks that are linked (directly or not) form a group, and each group gets
 *   its own band of rows. The next group starts below the lowest row of the
 *   previous one. Tasks with no links at all share the last band.
 * - A line that skips levels reserves an empty slot in every level it passes
 *   through, so it never runs across another task's box.
 * Inside a group, each column is ordered by the average position of the
 * neighbouring items (a few sweeps down and up) to reduce crossing lines.
 */

export const NODE_W = 184;
export const NODE_H = 50;
export const COL_GAP = 72;
export const ROW_GAP = 12;
export const GROUP_GAP = 28; // extra space between two unrelated groups
export const PAD = 16;
export const HEAD_H = 24; // column label above the first node

const prereqIds = (task) => (task.prerequisites || []).map((p) => (typeof p === "object" ? p.id : p));
const dependentIds = (task) => (task.dependents || []).map((d) => (typeof d === "object" ? d.id : d));
const SWEEPS = 4;

/**
 * tasks: board tasks ({ id, row, prerequisites, dependents, status }).
 * Returns { nodes, edges, levels, width, height } where
 *   nodes: [{ task, level, group, index, x, y }]
 *   edges: [{ from, to, pending, via, d }]  (from = prerequisite, to = dependent;
 *                                            via = reserved slots [{ level, y }]; d = SVG path)
 *   levels: [{ level, x }]                   (column labels)
 */
export function layoutGraph(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  const levelOf = (id) => Math.max(1, Number(byId.get(id).row) || 1);
  const links = tasks.flatMap((t) => prereqIds(t).filter((p) => byId.has(p)).map((p) => [p, t.id]));

  const levelNums = [...new Set(tasks.map((t) => levelOf(t.id)))].sort((a, b) => a - b);
  const colX = new Map(levelNums.map((level, i) => [level, PAD + i * (NODE_W + COL_GAP)]));

  // Groups of linked tasks, in board order of their first task; unlinked tasks last.
  const neighbours = new Map(tasks.map((t) => [t.id, []]));
  for (const [p, t] of links) {
    neighbours.get(p).push(t);
    neighbours.get(t).push(p);
  }
  const groupOf = new Map();
  const groups = [];
  const loners = [];
  for (const t of tasks) {
    if (groupOf.has(t.id)) continue;
    if (neighbours.get(t.id).length === 0) {
      loners.push(t.id);
      continue;
    }
    const members = [];
    const stack = [t.id];
    groupOf.set(t.id, groups.length);
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      for (const n of neighbours.get(cur)) {
        if (!groupOf.has(n)) {
          groupOf.set(n, groups.length);
          stack.push(n);
        }
      }
    }
    groups.push(members);
  }
  if (loners.length) groups.push(loners);

  const nodes = [];
  const slotY = new Map(); // "p>t@level" -> y of the reserved slot
  let top = PAD + HEAD_H;
  groups.forEach((members, g) => {
    const inGroup = new Set(members);
    // Items per level: real tasks plus one reserved slot per skipped level.
    const items = new Map(levelNums.map((l) => [l, []]));
    const up = new Map(); // item key -> keys of the items it connects to one level up
    const down = new Map();
    const connect = (a, b) => {
      up.get(b).push(a);
      down.get(a).push(b);
    };
    const add = (level, key) => {
      items.get(level).push(key);
      up.set(key, []);
      down.set(key, []);
    };
    for (const id of [...members].sort((a, b) => order.get(a) - order.get(b))) add(levelOf(id), id);
    for (const [p, t] of links) {
      if (!inGroup.has(p)) continue;
      const lp = levelOf(p);
      const lt = levelOf(t);
      if (lt <= lp) continue; // only with a dependency cycle; drawn as a loop, no slots
      let prev = p;
      for (let l = lp + 1; l < lt; l++) {
        const key = `${p}>${t}@${l}`;
        add(l, key);
        connect(prev, key);
        prev = key;
      }
      connect(prev, t);
    }

    // Order each column by the average position of its neighbours (down, up, down, ...).
    const pos = new Map();
    const place = (level) => items.get(level).forEach((k, i) => pos.set(k, i));
    levelNums.forEach(place);
    const avg = (keys, own) => (keys.length ? keys.reduce((s, k) => s + pos.get(k), 0) / keys.length : own);
    for (let s = 0; s < SWEEPS; s++) {
      const downward = s % 2 === 0;
      const seq = downward ? levelNums.slice(1) : levelNums.slice(0, -1).reverse();
      for (const level of seq) {
        const col = items.get(level);
        const weight = new Map(col.map((k) => [k, avg((downward ? up : down).get(k), pos.get(k))]));
        col.sort((a, b) => weight.get(a) - weight.get(b) || pos.get(a) - pos.get(b));
        place(level);
      }
    }

    let tallest = 0;
    for (const level of levelNums) {
      const col = items.get(level);
      tallest = Math.max(tallest, col.length);
      col.forEach((key, i) => {
        const y = top + i * (NODE_H + ROW_GAP);
        if (byId.has(key) && inGroup.has(key)) {
          nodes.push({ task: byId.get(key), level, group: g, index: i, x: colX.get(level), y });
        } else {
          slotY.set(key, y);
        }
      });
    }
    top += tallest * (NODE_H + ROW_GAP) - ROW_GAP + GROUP_GAP;
  });

  const at = new Map(nodes.map((n) => [n.task.id, n]));
  const edges = links.map(([p, t]) => {
    const from = at.get(p);
    const to = at.get(t);
    const via = [];
    for (let l = from.level + 1; l < to.level; l++) via.push({ level: l, y: slotY.get(`${p}>${t}@${l}`) });
    return {
      from: p,
      to: t,
      pending: from.task.status !== "done",
      via,
      d: edgePath(from, to, via.map((v) => ({ x: colX.get(v.level), y: v.y }))),
    };
  });

  return {
    nodes,
    edges,
    levels: levelNums.map((level) => ({ level, x: colX.get(level) })),
    width: levelNums.length ? PAD * 2 + levelNums.length * NODE_W + (levelNums.length - 1) * COL_GAP : 0,
    height: groups.length ? top - GROUP_GAP + PAD : 0,
  };
}

/** S-curve between two points on the same row band. */
const curve = (x1, y1, x2, y2) => {
  const bend = Math.max(24, (x2 - x1) / 2);
  return `C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
};

/**
 * Line from the right edge of `from` to the left edge of `to` (ending 6px short
 * for the arrowhead), running straight through each reserved slot on the way.
 */
function edgePath(from, to, slots) {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x - 6;
  const y2 = to.y + NODE_H / 2;
  if (x2 <= x1) {
    // Same or earlier column (only possible with a dependency cycle): loop around above.
    const top = Math.min(from.y, to.y) - 10;
    return `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x1 + 40} ${top}, ${(x1 + x2) / 2} ${top} S ${x2 - 40} ${y2}, ${x2} ${y2}`;
  }
  let d = `M ${x1} ${y1}`;
  let x = x1;
  let y = y1;
  for (const s of slots) {
    const sy = s.y + NODE_H / 2;
    d += ` ${curve(x, y, s.x, sy)} L ${s.x + NODE_W} ${sy}`;
    x = s.x + NODE_W;
    y = sy;
  }
  return `${d} ${curve(x, y, x2, y2)}`;
}

/**
 * Quick check before linking `fromId` as a prerequisite of `toId` in the graph.
 * Returns null when the link may be tried, else the reason it can't. Only for
 * instant feedback while dragging: the backend validates every change again
 * (prerequisite_problem and schedule.py) and has the final word.
 */
export function linkProblem(tasks, fromId, toId) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const from = byId.get(fromId);
  const to = byId.get(toId);
  if (!from || !to) return "Unknown task.";
  if (fromId === toId) return "A task cannot depend on itself.";
  if (prereqIds(to).includes(fromId)) return `"${to.title}" already depends on "${from.title}".`;
  if (relatedIds(tasks, fromId).up.has(toId)) {
    return `Circular dependency: "${from.title}" already depends on "${to.title}".`;
  }
  if (to.status === "done" && from.status !== "done") {
    return `"${to.title}" is completed, so its prerequisites must be completed too.`;
  }
  return null;
}

/** Prerequisite ids of `taskId` after adding or removing `prereqId`, for PATCH /api/tasks. */
export function prerequisitesWith(tasks, taskId, prereqId, add) {
  const ids = prereqIds(tasks.find((t) => t.id === taskId) || {});
  return add ? [...new Set([...ids, prereqId])] : ids.filter((p) => p !== prereqId);
}

/**
 * Everything `id` depends on (upstream, all levels) and everything that
 * depends on it (downstream). Neither set contains `id` itself.
 */
export function relatedIds(tasks, id) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const walk = (start, next) => {
    const seen = new Set();
    const stack = [...next(byId.get(start) || {})];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === start || seen.has(cur) || !byId.has(cur)) continue;
      seen.add(cur);
      stack.push(...next(byId.get(cur)));
    }
    return seen;
  };
  return { up: walk(id, prereqIds), down: walk(id, dependentIds) };
}
