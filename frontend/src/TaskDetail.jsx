import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ACTIVE_BOOKING,
  bookingKind,
  formatHours,
  formatRange,
  isAiEstimate,
  KIND_LABEL,
  remainingHours,
} from "./gpuState.js";
import { bookingProgress } from "./gpuProgress.js";
import PrereqPicker from "./PrereqPicker.jsx";
import ScheduleSection from "./ScheduleSection.jsx";
import { stateKind } from "./taskState.js";
import "./TaskDetail.css";

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

/** Estimated GPU hours (AI or a person) and actually booked GPU hours, kept apart. */
function GpuFacts({ task }) {
  const est = task.gpuEstimate || {};
  const ai = isAiEstimate(task);
  if (est.status === "pending") return <p className="muted">Asking the AI whether this task needs a GPU…</p>;
  if (!task.needsGpu) {
    return (
      <>
        {est.status === "failed" && <p className="msg-error-inline">AI estimate failed: {est.error}</p>}
        <p className={est.status === "failed" ? "muted" : undefined}>
          {ai && <span className="ai-tag">AI estimate</span>}No GPU needed
        </p>
        {ai && est.reason && <p className="muted gpu-reason">{est.reason}</p>}
      </>
    );
  }
  const progress = bookingProgress(task);
  return (
    <>
      <dl className="gpu-facts">
        <dt>Estimated</dt>
        <dd>
          {task.gpuHours == null ? "Unknown" : `${ai ? "~" : ""}${formatHours(task.gpuHours)}`}
          {ai ? <span className="ai-tag gpu-source">AI estimate</span> : task.gpuHours != null && <span className="muted gpu-source">set by a person</span>}
        </dd>
        <dt>Booked</dt>
        <dd>
          {formatHours(progress.booked)}
          <span className="gpu-progress" data-kind={progress.kind}>{progress.text}</span>
        </dd>
      </dl>
      {ai && est.reason && <p className="muted gpu-reason">{est.reason}</p>}
    </>
  );
}

/**
 * GPU need (AI estimate or set by a person), booked hours, and the way into the
 * GPU schedule tab. Main actions are buttons; the rest are small links.
 */
function GpuSection({ task, onOpenGpu, onSaveTask, onEstimateGpu }) {
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const b = task.gpuBooking;
  const isDone = task.status === "done";
  const activeBooking = b && ACTIVE_BOOKING.has(b.status);
  const pending = task.gpuEstimate?.status === "pending";
  const left = remainingHours(task);

  useEffect(() => {
    setEditing(false);
    setError("");
  }, [task.id]);

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    setHours(task.gpuHours == null ? "" : String(task.gpuHours));
    setEditing(true);
    setError("");
  };

  const saveHours = async (e) => {
    e.preventDefault();
    const value = hours.trim() === "" ? null : Number(hours);
    if (value !== null && !(value >= 0.5 && value <= 336)) {
      setError("Enter GPU hours from 0.5 to 336, or leave it empty if you don't know yet.");
      return;
    }
    if (await run(() => onSaveTask(task.id, { gpuHours: value }))) setEditing(false);
  };

  const canConfirm = task.needsGpu && isAiEstimate(task) && task.gpuHours != null;

  return (
    <section className="related-section gpu-section">
      <h4>GPU</h4>
      <GpuFacts task={task} />
      {b && (
        <p className={`gpu-band ${bookingKind(b)} inline`}>
          {b.gpuName} · {formatRange(b.startAt, b.endAt)} · {KIND_LABEL[bookingKind(b)]}
        </p>
      )}

      {editing && (
        <form className="gpu-hours-form" onSubmit={saveHours}>
          <label htmlFor="gpu-hours-input">Estimated GPU hours</label>
          <input
            id="gpu-hours-input"
            type="number"
            min={0.5}
            max={336}
            step={0.5}
            value={hours}
            autoFocus
            placeholder="Unknown"
            onChange={(e) => setHours(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p className="msg-error-inline" role="alert">
          {error}
        </p>
      )}

      {!isDone && !editing && (
        <>
          <div className="gpu-actions detail-actions">
            {canConfirm && (
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => run(() => onSaveTask(task.id, { gpuHours: task.gpuHours }))}
              >
                Confirm {formatHours(task.gpuHours)}
              </button>
            )}
            {task.needsGpu && left !== 0 && (
              <button type="button" className="btn" onClick={() => onOpenGpu({ bookTaskId: task.id })}>
                Schedule on GPU
              </button>
            )}
            {b && (
              <button type="button" className="btn" onClick={() => onOpenGpu({ bookingId: b.id })}>
                View in GPU schedule
              </button>
            )}
            {!task.needsGpu && (
              <button type="button" className="btn" onClick={startEdit}>
                Needs a GPU
              </button>
            )}
          </div>
          <div className="gpu-more detail-actions" aria-label="More GPU actions">
            {task.needsGpu && (
              <button type="button" className="btn ghost" onClick={startEdit}>
                Edit hours
              </button>
            )}
            {task.needsGpu && !activeBooking && (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => onSaveTask(task.id, { needsGpu: false }))}>
                No GPU needed
              </button>
            )}
            {!pending && (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => onEstimateGpu(task.id))}>
                {task.gpuEstimate?.status ? "Ask AI again" : "Ask AI to estimate"}
              </button>
            )}
          </div>
        </>
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
        <button type="button" className="btn ghost" onClick={onCancel} disabled={saving}>
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
        <button type="button" className="btn ghost" disabled={deleting} onClick={onCancel}>
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
  members = [],
  assigneeName,
  anchor,
  onToggleDone,
  onLocate,
  onClose,
  onOpenGpu,
  onSetNeedsGpu,
  onSaveTask,
  onDeleteTask,
  onEstimateGpu,
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
    // Narrow screens: neither side fits, so keep the whole popover on screen.
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
    const top = Math.min(Math.max(MARGIN, anchor.top), window.innerHeight - height - MARGIN);
    setPos({ left, top: Math.max(MARGIN, top) });
  }, [anchor, task.prerequisites.length, task.dependents.length, mode]);

  // Switching to another card starts in view mode again.
  useEffect(() => setMode("view"), [task.id]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    const onPointer = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (e.target.closest?.(".card, .wt-card")) return; // card clicks toggle/switch the popover
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
  // The status line already says Ready / Completed / Waiting for X. When a
  // task waits for several prerequisites, name them (the status only counts them).
  const blockers = isDone ? [] : task.prerequisites.filter((p) => p.status !== "done");

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

      {/* The task's status and the action that changes it, kept together. */}
      <div className="detail-status-row">
        <p className={`status ${kind}`}>
          <i className="dot" aria-hidden="true" />
          {task.stateText}
        </p>
        {mode === "view" && (
          <button
            type="button"
            className="btn detail-status-btn"
            disabled={!canToggle}
            title={canToggle ? undefined : "Not all prerequisites are completed"}
            onClick={() => onToggleDone(task)}
          >
            {isDone ? "Undo completion" : "Mark as completed"}
          </button>
        )}
      </div>

      {mode === "edit" && (
        <EditForm task={task} tasksById={tasksById} onSave={onSaveTask} onCancel={() => setMode("view")} />
      )}
      {mode === "delete" && (
        <DeleteConfirm task={task} onDelete={onDeleteTask} onCancel={() => setMode("view")} />
      )}
      {mode === "view" && (
      <>
      <p className="detail-owner">
        <span className="muted">Owner</span> {assigneeName || "Unassigned"}
      </p>
      {blockers.length > 1 && (
        <p className="detail-blockers">
          Waiting for{" "}
          {blockers.map((p, i) => (
            <span key={p.id}>
              {i > 0 && (i === blockers.length - 1 ? " and " : ", ")}“{p.title}”{p.assigneeName ? ` (${p.assigneeName})` : ""}
            </span>
          ))}
          .
        </p>
      )}
      <p className={`detail-desc ${task.description ? "" : "muted"}`}>{task.description || "No description yet."}</p>
      {task.summary && <p className="detail-desc">{task.summary}</p>}

      <ScheduleSection task={task} members={members} onSaveTask={onSaveTask} />
      <RelatedSection
        title="Prerequisites"
        items={task.prerequisites}
        empty="None."
        tasksById={tasksById}
        statusLabel={(item) => (item.status === "done" ? "Completed" : "Not completed")}
        onLocate={onLocate}
      />
      <RelatedSection
        title="Dependent Tasks"
        items={task.dependents}
        empty="None."
        tasksById={tasksById}
        statusLabel={(item, t) => t?.stateText ?? (item.status === "done" ? "Completed" : "Not completed")}
        onLocate={onLocate}
      />
      <GpuSection task={task} onOpenGpu={onOpenGpu} onSaveTask={onSaveTask} onEstimateGpu={onEstimateGpu} />

      <div className="detail-manage">
        <button type="button" className="btn ghost" onClick={() => setMode("edit")}>
          Edit task
        </button>
        <button type="button" className="btn ghost danger" onClick={() => setMode("delete")}>
          Delete task
        </button>
      </div>
      </>
      )}
    </div>
  );
}
