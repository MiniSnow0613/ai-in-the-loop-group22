import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { stateKind } from "./taskState.js";

const GAP = 8;
const MARGIN = 12;

/**
 * One related task (prerequisite or dependent). Clicking it locates the card
 * on the Timeline or in the Task Pool.
 */
function RelatedItem({ item, task, statusLabel, onLocate }) {
  const kind = task ? stateKind(task) : item.status === "done" ? "done" : "ready";
  return (
    <li>
      <button
        type="button"
        className="related"
        data-related-id={item.id}
        onClick={() => onLocate(item.id)}
        title="Show this card on the board"
      >
        <span className="related-title">{item.title}</span>
        <span className={`status ${kind}`}>
          <i className="dot" aria-hidden="true" />
          {item.assigneeName || "Task Pool"} · {statusLabel(item, task)}
        </span>
      </button>
    </li>
  );
}

function RelatedSection({ title, items, empty, tasksById, statusLabel, onLocate }) {
  return (
    <section className="related-section">
      <h4>
        {title}
        {items.length > 0 && <span className="count">{items.length}</span>}
      </h4>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <RelatedItem
              key={item.id}
              item={item}
              task={tasksById.get(item.id)}
              statusLabel={statusLabel}
              onLocate={onLocate}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Popover next to the clicked card: description, prerequisites, affected tasks. */
export default function TaskDetail({
  task,
  tasksById,
  assigneeName,
  anchor,
  onToggleDone,
  onLocate,
  onClose,
}) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  const kind = stateKind(task);

  // Place to the right of the card, or to the left if there is no room.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = anchor.right + GAP;
    if (left + width > window.innerWidth - MARGIN) left = anchor.left - GAP - width;
    left = Math.max(MARGIN, left);
    const top = Math.min(Math.max(MARGIN, anchor.top), window.innerHeight - height - MARGIN);
    setPos({ left, top: Math.max(MARGIN, top) });
  }, [anchor, task.prerequisites.length, task.dependents.length]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    const onPointer = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (e.target.closest?.(".card")) return; // card clicks toggle/switch the popover
      onClose();
    };
    // The anchor rect goes stale once anything outside the popover scrolls or resizes.
    const onMove = (e) => !ref.current?.contains(e.target) && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const isDone = task.status === "done";
  const canToggle = isDone || !task.blocked; // undoing is checked by the server
  const summaryLine = isDone
    ? "This task is completed."
    : task.blocked
      ? `${task.pendingCount} ${task.pendingCount === 1 ? "prerequisite is" : "prerequisites are"} not completed yet. This task can start once all are completed.`
      : task.prerequisites.length > 0
        ? "All prerequisites are completed. This task can start."
        : "No prerequisites. This task can start.";

  return (
    <div
      ref={ref}
      className="detail"
      role="dialog"
      aria-label={`${task.title} details`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="detail-head">
        <h3>
          {task.title}
          {task.isExample && <span className="badge">Example</span>}
        </h3>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <p className={`status ${kind}`}>
        <i className="dot" aria-hidden="true" />
        {task.stateText}
      </p>

      <dl>
        <dt>Owner</dt>
        <dd>{assigneeName || "Unassigned (Task Pool)"}</dd>
        <dt>Dependency level</dt>
        <dd>Level {task.row}</dd>
        <dt>Description</dt>
        <dd>{task.description || "No description yet"}</dd>
        {task.summary && (
          <>
            <dt>Summary</dt>
            <dd>{task.summary}</dd>
          </>
        )}
      </dl>
      <p className="muted">{summaryLine}</p>

      <RelatedSection
        title="Prerequisites"
        items={task.prerequisites}
        empty="No prerequisites."
        tasksById={tasksById}
        statusLabel={(item) => (item.status === "done" ? "Completed" : "Not completed")}
        onLocate={onLocate}
      />
      <RelatedSection
        title="Affected tasks"
        items={task.dependents}
        empty="No tasks depend on this card."
        tasksById={tasksById}
        statusLabel={(item, t) => t?.stateText ?? (item.status === "done" ? "Completed" : "Not completed")}
        onLocate={onLocate}
      />

      <button
        type="button"
        className="btn"
        disabled={!canToggle}
        title={canToggle ? undefined : "Not all prerequisites are completed"}
        onClick={() => onToggleDone(task)}
      >
        {isDone ? "Undo completion" : "Mark as completed"}
      </button>
    </div>
  );
}
