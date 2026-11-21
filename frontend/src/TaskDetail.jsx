import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bookingKind, formatRange, KIND_LABEL } from "./gpuState.js";
import PrereqPicker from "./PrereqPicker.jsx";
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

/** The task's GPU booking, with a way into the GPU schedule tab. */
function GpuSection({ task, onOpenGpu, onSetNeedsGpu }) {
  const b = task.gpuBooking;
  const isDone = task.status === "done";
  const canBookAgain = !isDone && task.needsGpu && (!b || b.status === "done");
  let body;
  if (b) {
    const kind = bookingKind(b);
    body = (
      <>
        <p className={`gpu-band ${kind} inline`}>
          {b.gpuName} · {formatRange(b.startAt, b.endAt)}
        </p>
        <p className="muted">{KIND_LABEL[kind]}</p>
      </>
    );
  } else if (task.needsGpu && !isDone) {
    body = <p className="muted">Needs a GPU. Not booked yet.</p>;
  } else {
    body = <p className="muted">{isDone ? "No GPU booking." : "No GPU needed."}</p>;
  }
  return (
    <section className="related-section gpu-section">
      <h4>GPU</h4>
      {body}
      {!isDone && (
        <div className="gpu-actions">
          {b && (
            <button type="button" className="btn" onClick={() => onOpenGpu({ bookingId: b.id })}>
              View in GPU schedule
            </button>
          )}
          {canBookAgain && (
            <button type="button" className="btn" onClick={() => onOpenGpu({ bookTaskId: task.id })}>
              Book a GPU
            </button>
          )}
          {!b && !task.needsGpu && (
            <button type="button" className="btn" onClick={() => onSetNeedsGpu(task, true)}>
              Needs a GPU
            </button>
          )}
          {!b && task.needsGpu && (
            <button type="button" className="btn" onClick={() => onSetNeedsGpu(task, false)}>
              No GPU needed
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Edit title, description and prerequisites. Errors from the server stay in the form. */
function EditForm({ task, tasksById, onSave, onCancel }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || "");
  const [prerequisites, setPrerequisites] = useState(task.prerequisites.map((p) => p.id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Tasks that already depend on this one (directly or not) would make a loop.
  const downstream = new Set();
  const stack = [task.id];
  while (stack.length) {
    for (const d of tasksById.get(stack.pop())?.dependents || []) {
      if (!downstream.has(d.id)) {
        downstream.add(d.id);
        stack.push(d.id);
      }
    }
  }
  const options = [...tasksById.values()]
    .filter((t) => t.id !== task.id && !downstream.has(t.id))
    .map((t) => ({
      id: t.id,
      kind: "existing",
      label: t.title,
      group: t.status === "done" ? "Completed" : "Not completed",
    }));

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(task.id, { title, description, prerequisites });
      onCancel();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="detail-edit" onSubmit={submit} aria-label="Edit task">
      <label htmlFor="edit-title">Title</label>
      <input id="edit-title" value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="edit-desc">Description</label>
      <textarea
        id="edit-desc"
        rows={3}
        value={description}
        maxLength={500}
        placeholder="Optional"
        onChange={(e) => setDescription(e.target.value)}
      />
      <span className="form-label">Prerequisites</span>
      <PrereqPicker value={prerequisites} options={options} onChange={setPrerequisites} />
      {error && (
        <p className="msg-error-inline" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!title.trim() || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Ask before deleting; say which tasks stop waiting for it and what else goes. */
function DeleteConfirm({ task, onDelete, onCancel }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      await onDelete(task.id);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };
  return (
    <div className="detail-confirm" role="alertdialog" aria-label="Delete task">
      <strong>Delete “{task.title}”?</strong>
      {task.dependents.length > 0 && (
        <>
          <p>These tasks will no longer wait for it:</p>
          <ul>
            {task.dependents.map((d) => (
              <li key={d.id}>{d.title}</li>
            ))}
          </ul>
        </>
      )}
      {task.gpuBooking && <p>Its GPU booking ({task.gpuBooking.gpuName}) will be deleted too.</p>}
      <p className="muted">This cannot be undone.</p>
      {error && (
        <p className="msg-error-inline" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn danger" disabled={deleting} onClick={remove}>
          {deleting ? "Deleting…" : "Delete task"}
        </button>
        <button type="button" className="btn" disabled={deleting} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
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
  onOpenGpu,
  onSetNeedsGpu,
  onSaveTask,
  onDeleteTask,
}) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  const [mode, setMode] = useState("view"); // "view" | "edit" | "delete"
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
  }, [anchor, task.prerequisites.length, task.dependents.length, mode]);

  // Switching to another card starts in view mode again.
  useEffect(() => setMode("view"), [task.id]);

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

      {mode === "edit" && (
        <EditForm task={task} tasksById={tasksById} onSave={onSaveTask} onCancel={() => setMode("view")} />
      )}
      {mode === "delete" && (
        <DeleteConfirm task={task} onDelete={onDeleteTask} onCancel={() => setMode("view")} />
      )}
      {mode === "view" && (
      <>
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
      <GpuSection task={task} onOpenGpu={onOpenGpu} onSetNeedsGpu={onSetNeedsGpu} />

      <button
        type="button"
        className="btn"
        disabled={!canToggle}
        title={canToggle ? undefined : "Not all prerequisites are completed"}
        onClick={() => onToggleDone(task)}
      >
        {isDone ? "Undo completion" : "Mark as completed"}
      </button>
      <div className="detail-manage">
        <button type="button" className="link-btn" onClick={() => setMode("edit")}>
          Edit task
        </button>
        <button type="button" className="link-btn danger" onClick={() => setMode("delete")}>
          Delete task
        </button>
      </div>
      </>
      )}
    </div>
  );
}
