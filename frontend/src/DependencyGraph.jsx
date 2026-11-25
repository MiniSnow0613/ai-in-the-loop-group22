import { useEffect, useMemo, useRef, useState } from "react";
import {
  HEAD_H,
  layoutGraph,
  linkProblem,
  NODE_H,
  NODE_W,
  PAD,
  prerequisitesWith,
  relatedIds,
} from "./dependencyGraphLayout.js";
import { shownIssues } from "./scheduleIssues.js";
import { stateKind } from "./taskState.js";
import "./DependencyGraph.css";

/*
 * Dependency graph, opened from the Timeline header. Arrows go from a
 * prerequisite to the task that waits for it.
 *
 * View mode: click a task to highlight what it depends on and what depends on
 * it; click it again to open its details.
 * Edit mode (only when onChangePrerequisites is given): drag from the dot on a
 * task's right edge onto another task to make the first one its prerequisite;
 * click a line to remove it. Every change is saved at once through
 * PATCH /api/tasks/<id>, which validates it (cycles, completed tasks, dates).
 * A rejected change leaves the graph as it was and shows the reason. Other
 * tasks are never rescheduled.
 *
 * Props:
 *   tasks                  all board tasks (Timeline and Task Pool)
 *   members                [{ id, name }] for the owner line
 *   onClose                () => void
 *   onOpenTask             (taskId, rect) => void
 *   onChangePrerequisites  async (taskId, prerequisiteIds) => board data with `warnings`; throws on rejection
 */
const STATE_TEXT = { done: "Completed", waiting: "Waiting", ready: "Ready" };
const FLASH_MS = 2000;
const edgeKey = (from, to) => `${from}>${to}`;

export default function DependencyGraph({ tasks, members, onClose, onOpenTask, onChangePrerequisites }) {
  const [focusId, setFocusId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState(null); // { from, x, y, over } while drawing a new link
  const [picked, setPicked] = useState(null); // { from, to, x, y } line chosen for removal
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { kind: "error" | "warning" | "saved", lines }
  const [flash, setFlash] = useState(null); // edge key of the link just added
  const closeRef = useRef(null);
  const canvasRef = useRef(null);
  const flashTimer = useRef(null);
  const dragCleanup = useRef(null);

  const layout = useMemo(() => layoutGraph(tasks), [tasks]);
  const names = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const titleOf = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const related = useMemo(() => (focusId ? relatedIds(tasks, focusId) : null), [tasks, focusId]);
  const canEdit = Boolean(onChangePrerequisites);

  useEffect(() => closeRef.current?.focus(), []);
  useEffect(
    () => () => {
      clearTimeout(flashTimer.current);
      dragCleanup.current?.();
    },
    []
  );

  // Escape undoes the innermost thing first: a drag, a picked line, then the dialog.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (drag) {
        dragCleanup.current?.();
        setDrag(null);
      } else if (picked) setPicked(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, drag, picked]);

  /** Send one task's new prerequisite list; show the outcome inside the dialog. */
  const save = async (taskId, prerequisiteIds, done) => {
    setBusy(true);
    setPicked(null);
    try {
      const data = await onChangePrerequisites(taskId, prerequisiteIds);
      const warnings = shownIssues(data?.warnings).map((w) => w.message);
      setMessage(warnings.length ? { kind: "warning", lines: ["Saved with warnings:", ...warnings] } : { kind: "saved", lines: [done] });
      return true;
    } catch (err) {
      setMessage({ kind: "error", lines: [err.message] });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addLink = async (from, to) => {
    const problem = linkProblem(tasks, from, to);
    if (problem) {
      setMessage({ kind: "error", lines: [problem] });
      return;
    }
    const ok = await save(to, prerequisitesWith(tasks, to, from, true), `Linked: ${titleOf.get(from)} → ${titleOf.get(to)}`);
    if (ok) {
      setFlash(edgeKey(from, to));
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
    }
  };

  const removeLink = ({ from, to }) =>
    save(to, prerequisitesWith(tasks, to, from, false), `Removed: ${titleOf.get(from)} → ${titleOf.get(to)}`);

  /** Canvas coordinates of a pointer event (the canvas scrolls inside the dialog). */
  const toCanvas = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const nodeIdAt = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".dg-node")?.dataset.taskId ?? null;

  const startLink = (e, from) => {
    if (busy || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    setPicked(null);
    setMessage(null);
    setDrag({ from, ...toCanvas(e), over: null });
    const move = (ev) => setDrag((d) => d && { ...d, ...toCanvas(ev), over: nodeIdAt(ev) });
    const up = (ev) => {
      const to = nodeIdAt(ev);
      cleanup();
      setDrag(null);
      if (to && to !== from) addLink(from, to);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragCleanup.current = null;
    };
    const cancel = () => {
      cleanup();
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    dragCleanup.current = cleanup;
  };

  const pickEdge = (e, edge) => {
    e.stopPropagation();
    if (busy) return;
    const path = e.currentTarget;
    const mid = path.getPointAtLength(path.getTotalLength() / 2);
    setMessage(null);
    setPicked({ from: edge.from, to: edge.to, x: mid.x, y: mid.y });
  };

  /** "focus" | "up" | "down" | "dim" | "" for a task, given the highlighted one. */
  const roleOf = (id) => {
    if (!related) return "";
    if (id === focusId) return "focus";
    if (related.up.has(id)) return "up";
    if (related.down.has(id)) return "down";
    return "dim";
  };
  const edgeOn = (e) =>
    !related ||
    (e.to === focusId && related.up.has(e.from)) ||
    (related.up.has(e.to) && related.up.has(e.from)) ||
    (e.from === focusId && related.down.has(e.to)) ||
    (related.down.has(e.from) && related.down.has(e.to));

  const clickNode = (e, id) => {
    e.stopPropagation();
    if (focusId === id) onOpenTask(id, e.currentTarget.getBoundingClientRect());
    else setFocusId(id);
  };

  /** While drawing a link: "drop-ok", "drop-no" or "" for a task. */
  const dropClass = (id) => {
    if (!drag || id === drag.from) return "";
    return linkProblem(tasks, drag.from, id) ? "drop-no" : "drop-ok";
  };

  const focusTask = focusId && tasks.find((t) => t.id === focusId);
  const fromNode = drag && layout.nodes.find((n) => n.task.id === drag.from);
  const hint = editing
    ? "Drag the dot on a task onto another task to make it a prerequisite. Click a line to remove it. Changes are saved at once and checked by the server."
    : focusTask
      ? `${focusTask.title}: ${related.up.size} upstream, ${related.down.size} downstream. Click it again to open its details.`
      : "Arrows point from a prerequisite to the task that waits for it. Click a task to trace it.";

  return (
    <div className="dg-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !drag && onClose()}>
      <div className="dg-modal" role="dialog" aria-modal="true" aria-labelledby="dg-title">
        <div className="dg-head">
          <h3 id="dg-title">Dependencies</h3>
          <p className="hint">{hint}</p>
          {canEdit && (
            <button
              type="button"
              className={`btn dg-edit-btn ${editing ? "primary" : ""}`}
              aria-pressed={editing}
              onClick={() => {
                setEditing((v) => !v);
                setPicked(null);
                setMessage(null);
                setFocusId(null);
              }}
            >
              {editing ? "Done editing" : "Edit dependencies"}
            </button>
          )}
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <ul className="dg-legend" aria-label="Legend">
          <li><span className="dg-swatch ready" />Ready</li>
          <li><span className="dg-swatch waiting" />Waiting</li>
          <li><span className="dg-swatch done" />Completed</li>
          <li><span className="dg-line pending" />Prerequisite not finished</li>
          <li><span className="dg-line" />Prerequisite finished</li>
        </ul>

        {(message || busy) && (
          <div className={`dg-message ${busy ? "saving" : message.kind}`} role={message?.kind === "error" ? "alert" : "status"}>
            {busy ? (
              <span>Saving…</span>
            ) : (
              <>
                <div>
                  {message.lines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
                <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setMessage(null)}>
                  ×
                </button>
              </>
            )}
          </div>
        )}

        {layout.nodes.length === 0 ? (
          <p className="dg-empty">No tasks on the board yet.</p>
        ) : (
          <div
            className="dg-scroll"
            onClick={() => {
              setFocusId(null);
              setPicked(null);
            }}
          >
            <div
              ref={canvasRef}
              className={`dg-canvas ${related ? "is-tracing" : ""} ${editing ? "is-editing" : ""} ${drag ? "is-linking" : ""}`}
              style={{ width: layout.width, height: layout.height }}
            >
              {layout.levels.map(({ level, x }) => (
                <span key={level} className="dg-level" style={{ left: x, top: PAD, width: NODE_W, height: HEAD_H }}>
                  {level === 1 ? "Level 1 · no prerequisites" : `Level ${level}`}
                </span>
              ))}

              <svg className="dg-edges" width={layout.width} height={layout.height} aria-hidden="true">
                <defs>
                  {["pending", "finished", "faded", "active"].map((kind) => (
                    <marker
                      key={kind}
                      id={`dg-arrow-${kind}`}
                      className={`dg-arrow ${kind}`}
                      viewBox="0 0 8 8"
                      refX="2"
                      refY="4"
                      markerWidth="8"
                      markerHeight="8"
                      orient="auto"
                    >
                      <path d="M0,0 L8,4 L0,8 z" />
                    </marker>
                  ))}
                </defs>
                {layout.edges.map((e) => {
                  const key = edgeKey(e.from, e.to);
                  const active = key === flash || (picked && key === edgeKey(picked.from, picked.to));
                  const kind = active ? "active" : !edgeOn(e) ? "faded" : e.pending ? "pending" : "finished";
                  return (
                    <g key={key}>
                      <path d={e.d} className={`dg-edge ${kind}`} markerEnd={`url(#dg-arrow-${kind})`} />
                      {editing && <path d={e.d} className="dg-edge-hit" onClick={(ev) => pickEdge(ev, e)} />}
                    </g>
                  );
                })}
                {drag && fromNode && (
                  <path
                    className="dg-edge drawing"
                    d={`M ${fromNode.x + NODE_W} ${fromNode.y + NODE_H / 2} L ${drag.x} ${drag.y}`}
                    markerEnd="url(#dg-arrow-active)"
                  />
                )}
              </svg>

              {layout.nodes.map(({ task, x, y }) => {
                const kind = stateKind(task);
                const owner = names.get(task.assigneeId);
                return (
                  <div key={task.id} className="dg-node-wrap" style={{ left: x, top: y, width: NODE_W, height: NODE_H }}>
                    <button
                      type="button"
                      data-task-id={task.id}
                      className={`dg-node ${kind} ${roleOf(task.id)} ${dropClass(task.id)} ${drag?.over === task.id ? "over" : ""}`}
                      aria-pressed={focusId === task.id}
                      title={task.title}
                      onClick={(e) => clickNode(e, task.id)}
                    >
                      <span className="dg-node-title">{task.title}</span>
                      <span className="dg-node-meta">
                        {STATE_TEXT[kind]}
                        {owner ? ` · ${owner}` : " · Unassigned"}
                      </span>
                    </button>
                    {editing && (
                      <span
                        className="dg-handle"
                        role="presentation"
                        title={`Drag onto another task to make "${task.title}" its prerequisite`}
                        onPointerDown={(e) => startLink(e, task.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                  </div>
                );
              })}

              {picked && (
                <div
                  className="dg-remove"
                  style={{ left: picked.x, top: picked.y }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="dg-remove-text">
                    {titleOf.get(picked.from)} → {titleOf.get(picked.to)}
                  </span>
                  <button type="button" className="btn danger" onClick={() => removeLink(picked)}>
                    Remove
                  </button>
                  <button type="button" className="btn" onClick={() => setPicked(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
