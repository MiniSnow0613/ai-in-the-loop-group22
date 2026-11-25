import { useCallback, useEffect, useRef, useState } from "react";
import {
  createBooking,
  createGpu,
  deleteBooking,
  deleteGpu,
  detectGpus,
  fetchGpuSchedule,
  updateBooking,
  updateGpu,
} from "./api.js";
import {
  ACTIVE_BOOKING,
  addMinutes,
  bookingKind,
  bookingMinutesFor,
  bookingTitle,
  earliestSlot,
  findConflicts,
  formatHours,
  formatRange,
  isAiEstimate,
  KIND_LABEL,
  nextHalfHour,
  parseTime,
  remainingHours,
  sameDay,
  startOfDay,
  toTimeString,
} from "./gpuState.js";

const POLL_MS = 5000;
const DAY_MIN = 24 * 60;
const DEFAULT_MINUTES = 120;
const SNAP_MIN = 30;
const DRAG_THRESHOLD_PX = 4;
const OTHER = "__other__"; // booking that is not a board task (e.g. another lab's job)
const DRAFT = "__draft__"; // the unsaved block of the booking form
const HOUR_LABELS = Array.from({ length: 13 }, (_, i) => i * 2);
const LEGEND = ["planned", "blocked", "running", "done", "external"];

const minutesFrom = (day, s) => (parseTime(s).getTime() - day.getTime()) / 60000;
const shiftDay = (day, n) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
const pct = (m) => `${(m / DAY_MIN) * 100}%`;
const hoursBetween = (s, e) => (parseTime(e) - parseTime(s)) / 3600000;
const clock = (s) => s.slice(11, 16);

function formatDay(day) {
  return day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Tasks that need a GPU and still have hours (or an unknown total) to book. */
function unbookedTasks(tasks) {
  return tasks.filter((t) => {
    if (!t.needsGpu || t.status === "done") return false;
    if (t.gpuHours == null) return !(t.gpuBooking && ACTIVE_BOOKING.has(t.gpuBooking.status));
    return remainingHours(t) > 0;
  });
}

/** "6h left of 10h", "~6h (AI estimate)", "time unknown". */
function needLabel(task) {
  if (task.gpuHours == null) return "time unknown";
  const ai = isAiEstimate(task) ? " (AI estimate)" : "";
  if (task.bookedGpuHours > 0) return `${formatHours(remainingHours(task))} left of ${formatHours(task.gpuHours)}${ai}`;
  return `${isAiEstimate(task) ? "~" : ""}${formatHours(task.gpuHours)}${ai}`;
}

/** What a block may do when dragged: move it, and/or stretch either edge. */
function dragAbility(item) {
  if (item.id === DRAFT || item.status === "planned") return { move: true, start: true, end: true };
  if (item.status === "running") return { move: false, start: false, end: true };
  return { move: false, start: false, end: false };
}

/** One block on a GPU row: a booking, or the draft of the booking form. */
function Block({ item, day, kind, label, title, selected, dragging, conflict, onPointerDown, onClick }) {
  const s = minutesFrom(day, item.startAt);
  const e = minutesFrom(day, item.endAt);
  if (!(e > 0 && s < DAY_MIN)) return null;
  const left = Math.max(0, s);
  const right = Math.min(DAY_MIN, e);
  const can = dragAbility(item);
  const className = [
    "gpu-bar",
    kind,
    selected ? "selected" : "",
    dragging ? "dragging" : "",
    conflict ? "bad" : "",
    can.move ? "movable" : "",
  ].join(" ");
  const handle = (edge) =>
    can[edge] && (edge === "start" ? s >= 0 : e <= DAY_MIN) ? (
      <span
        className={`gpu-handle ${edge}`}
        aria-hidden="true"
        onPointerDown={(ev) => {
          ev.stopPropagation();
          onPointerDown(ev, item, edge);
        }}
      />
    ) : null;
  const body = (
    <>
      {handle("start")}
      <span className="gpu-bar-label">{label}</span>
      {handle("end")}
    </>
  );
  const common = {
    className,
    style: { left: pct(left), width: `calc(${pct(right - left)} - 2px)` },
    title,
    onPointerDown: (ev) => can.move && onPointerDown(ev, item, "move"),
  };
  if (item.id === DRAFT) return <div {...common}>{body}</div>;
  return (
    <button type="button" {...common} data-booking-id={item.id} onClick={() => onClick(item.id)}>
      {body}
    </button>
  );
}

function GpuRow({ gpu, day, blocks, now, busy, onPickTime, onRenameGpu, renderBlock }) {
  const trackRef = useRef(null);
  const inputRef = useRef(null);
  const cancelledRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(gpu.name);
  const [host, short] = gpu.name.includes(" / ")
    ? [gpu.name.slice(0, gpu.name.lastIndexOf(" / ")), gpu.name.split(" / ").pop()]
    : [null, gpu.name];

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const next = draft.trim();
    setEditing(false);
    if (!next || next === gpu.name) return;
    await onRenameGpu?.(gpu.id, next);
  };

  return (
    <>
      <div className={`gpu-label ${gpu.active ? "" : "inactive"}`} title={gpu.name}>
        {editing ? (
          <input
            ref={inputRef}
            className="gpu-label-input"
            value={draft}
            maxLength={80}
            aria-label={`Rename ${gpu.name}`}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                cancelledRef.current = true;
                setDraft(gpu.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="gpu-label-btn"
            title={`${gpu.name} — Click to rename`}
            onClick={() => {
              cancelledRef.current = false;
              setDraft(gpu.name);
              setEditing(true);
            }}
          >
            <strong>{short}</strong>
            <span className="muted">
              {[host, gpu.memoryGb ? `${gpu.memoryGb} GB` : null, gpu.active ? null : "Deactivated"]
                .filter(Boolean)
                .join(" · ") || " "}
            </span>
          </button>
        )}
      </div>
      <div
        ref={trackRef}
        className={`gpu-track ${gpu.active ? "" : "inactive"}`}
        data-gpu-id={gpu.id}
        data-active={gpu.active ? "1" : "0"}
        title={gpu.active ? "Click an empty spot to book from that hour" : "Deactivated: no new bookings"}
        onClick={(e) => {
          if (!gpu.active || e.target !== trackRef.current) return;
          const rect = trackRef.current.getBoundingClientRect();
          const hour = Math.min(23, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * 24)));
          onPickTime(gpu.id, addMinutes(day, hour * 60));
        }}
      >
        {blocks.map(renderBlock)}
        {sameDay(day, now) && (
          <span className="gpu-now" style={{ left: pct(minutesFrom(day, toTimeString(now))) }} aria-hidden="true" />
        )}
      </div>
    </>
  );
}

/** "This booking 6h · booked 8h of 30h (AI estimate)". */
function TaskProgress({ task, startAt, endAt, excludeHours = 0 }) {
  if (!task) return null;
  const valid = startAt && endAt && startAt < endAt;
  const thisOne = valid ? hoursBetween(startAt, endAt) : 0;
  const booked = Math.max(0, (task.bookedGpuHours || 0) - excludeHours);
  if (task.gpuHours == null) {
    return (
      <p className="muted">
        This booking {formatHours(thisOne)}. The task's total GPU time is unknown
        {booked > 0 ? `; ${formatHours(booked)} booked already` : ""}.
      </p>
    );
  }
  const after = booked + thisOne;
  return (
    <p className={`muted ${after > task.gpuHours ? "gpu-over" : ""}`}>
      This booking {formatHours(thisOne)} · {formatHours(after)} of {formatHours(task.gpuHours)} booked with it
      {isAiEstimate(task) ? " (AI estimate)" : ""}
      {after > task.gpuHours ? " · more than the task needs" : ""}
    </p>
  );
}

function BookingForm({ form, setForm, schedule, tasks, onSubmit, onCancel, busy, error }) {
  const activeGpus = schedule.gpus.filter((g) => g.active);
  const need = unbookedTasks(tasks);
  const others = tasks.filter((t) => t.status !== "done" && !need.includes(t));
  const task = tasks.find((t) => t.id === form.taskId);
  const validTimes = form.startAt && form.endAt && form.startAt < form.endAt;
  const conflicts = validTimes ? findConflicts(schedule.bookings, form.gpuId, form.startAt, form.endAt) : [];
  const minutes = validTimes ? (parseTime(form.endAt) - parseTime(form.startAt)) / 60000 : DEFAULT_MINUTES;
  const alt =
    conflicts.length > 0
      ? earliestSlot(schedule.bookings, activeGpus.map((g) => g.id), form.gpuId, parseTime(form.startAt), minutes)
      : null;
  const altGpu = alt && schedule.gpus.find((g) => g.id === alt.gpuId);
  const set = (changes) => setForm({ ...form, ...changes });

  return (
    <form
      className="gpu-box"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h3>New booking</h3>
      <p className="muted">Drag the green block to move it, across GPUs too, or drag its edges to change the length.</p>
      <div className="gpu-form">
        <label htmlFor="gpu-form-task">Task</label>
        <select id="gpu-form-task" value={form.taskId} onChange={(e) => set({ taskId: e.target.value })}>
          <option value="">Choose a task</option>
          {need.length > 0 && (
            <optgroup label="Needs a GPU">
              {need.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} · {needLabel(t)}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label="Other tasks">
              {others.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </optgroup>
          )}
          <option value={OTHER}>Not a board task (other use)</option>
        </select>
        {form.taskId === OTHER && (
          <>
            <label htmlFor="gpu-form-label">Used by</label>
            <input
              id="gpu-form-label"
              value={form.label}
              maxLength={80}
              placeholder="Another lab's training job"
              onChange={(e) => set({ label: e.target.value })}
            />
          </>
        )}
        <label htmlFor="gpu-form-gpu">GPU</label>
        <select id="gpu-form-gpu" value={form.gpuId} onChange={(e) => set({ gpuId: e.target.value })}>
          {activeGpus.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <label htmlFor="gpu-form-start">From</label>
        <input
          id="gpu-form-start"
          type="datetime-local"
          step={1800}
          value={form.startAt}
          onChange={(e) => {
            // Keep the duration when the start moves.
            const start = e.target.value;
            if (!start) return set({ startAt: "" });
            set({ startAt: start, endAt: toTimeString(addMinutes(parseTime(start), minutes)) });
          }}
        />
        <label htmlFor="gpu-form-end">To</label>
        <input
          id="gpu-form-end"
          type="datetime-local"
          step={1800}
          value={form.endAt}
          onChange={(e) => set({ endAt: e.target.value })}
        />
      </div>

      {form.taskId !== OTHER && <TaskProgress task={task} startAt={form.startAt} endAt={form.endAt} />}
      {!validTimes ? (
        <p className="gpu-check bad">The end time must be after the start time.</p>
      ) : conflicts.length > 0 ? (
        <p className="gpu-check bad">
          Overlaps {conflicts.map((c) => `${bookingTitle(c)} (${formatRange(c.startAt, c.endAt)})`).join(", ")}.
        </p>
      ) : (
        <p className="gpu-check ok">This time is free.</p>
      )}
      {task?.blocked && (
        <p className="msg-warning">
          Prerequisites of this task aren't completed yet. You can book now, but the job can't start until they are.
        </p>
      )}
      {error && <p className="msg-error-inline" role="alert">{error}</p>}

      <div className="gpu-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          Book
        </button>
        {alt && (
          <button type="button" className="btn" onClick={() => set(alt)}>
            Use earliest free slot: {altGpu?.name} · {formatRange(alt.startAt, alt.endAt)}
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Details of one booking, with fields to change its time (the keyboard alternative to dragging). */
function BookingDetail({ booking, schedule, task, onAction, onSave, onShowTask, busy, error }) {
  const kind = bookingKind(booking);
  const can = dragAbility(booking);
  const [gpuId, setGpuId] = useState(booking.gpuId);
  const [startAt, setStartAt] = useState(booking.startAt);
  const [endAt, setEndAt] = useState(booking.endAt);

  useEffect(() => {
    setGpuId(booking.gpuId);
    setStartAt(booking.startAt);
    setEndAt(booking.endAt);
  }, [booking.id, booking.gpuId, booking.startAt, booking.endAt]);

  const changed = gpuId !== booking.gpuId || startAt !== booking.startAt || endAt !== booking.endAt;
  const activeGpus = schedule.gpus.filter((g) => g.active || g.id === booking.gpuId);

  return (
    <div className="gpu-box">
      <h3>{bookingTitle(booking)}</h3>
      <dl className="gpu-dl">
        <dt>Owner</dt>
        <dd>{booking.taskId ? booking.assigneeName || "Unassigned (Task Pool)" : "Not a board task"}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`gpu-swatch ${kind}`} aria-hidden="true" />
          {KIND_LABEL[kind]}
        </dd>
      </dl>
      {can.end ? (
        <div className="gpu-form">
          <label htmlFor="gpu-detail-gpu">GPU</label>
          {can.move ? (
            <select id="gpu-detail-gpu" value={gpuId} onChange={(e) => setGpuId(e.target.value)}>
              {activeGpus.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          ) : (
            <span id="gpu-detail-gpu">{booking.gpuName}</span>
          )}
          <label htmlFor="gpu-detail-start">From</label>
          {can.start ? (
            <input
              id="gpu-detail-start"
              type="datetime-local"
              step={1800}
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
          ) : (
            <span id="gpu-detail-start">{formatRange(booking.startAt, booking.startAt).split("–")[0]}</span>
          )}
          <label htmlFor="gpu-detail-end">To</label>
          <input
            id="gpu-detail-end"
            type="datetime-local"
            step={1800}
            value={endAt}
            onChange={(e) => setEndAt(e.target.value)}
          />
        </div>
      ) : (
        <dl className="gpu-dl">
          <dt>GPU</dt>
          <dd>{booking.gpuName}</dd>
          <dt>Time</dt>
          <dd>{formatRange(booking.startAt, booking.endAt)}</dd>
        </dl>
      )}
      {task && (
        <TaskProgress
          task={task}
          startAt={startAt}
          endAt={endAt}
          excludeHours={hoursBetween(booking.startAt, booking.endAt)}
        />
      )}
      {kind === "blocked" && (
        <p className="msg-warning">The job can start once all prerequisites of this task are completed.</p>
      )}
      {error && <p className="msg-error-inline" role="alert">{error}</p>}
      <div className="gpu-actions">
        {changed && (
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => {
              const changes = {};
              if (gpuId !== booking.gpuId) changes.gpuId = gpuId;
              if (startAt !== booking.startAt) changes.startAt = startAt;
              if (endAt !== booking.endAt) changes.endAt = endAt;
              onSave(changes);
            }}
          >
            Save time
          </button>
        )}
        {booking.status === "planned" && (
          <button type="button" className="btn" disabled={busy} onClick={() => onAction("start")}>
            Start job
          </button>
        )}
        {booking.status === "running" && (
          <button type="button" className="btn" disabled={busy} onClick={() => onAction("finish")}>
            Mark finished
          </button>
        )}
        {booking.status !== "running" && (
          <button type="button" className="btn" disabled={busy} onClick={() => onAction("delete")}>
            {booking.status === "planned" ? "Cancel booking" : "Remove from schedule"}
          </button>
        )}
        {booking.taskId && (
          <button type="button" className="btn" onClick={() => onShowTask(booking.taskId)}>
            Show task on board
          </button>
        )}
      </div>
    </div>
  );
}

function ManageGpus({ schedule, onApply, onClose }) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [memory, setMemory] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn, okText) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const resp = await fn();
      onApply(resp);
      if (okText) setNotice(typeof okText === "function" ? okText(resp) : okText);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const memoryValue = (v) => (v === "" ? null : Number(v));

  return (
    <div className="gpu-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gpu-modal" role="dialog" aria-modal="true" aria-label="Manage GPUs">
        <div className="detail-head">
          <h3>Manage GPUs</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="muted">
          Name GPUs as “machine / GPU”, for example “lab-server / GPU 0”. A GPU with planned or running bookings can
          only be deactivated, not deleted.
        </p>

        <div className="gpu-manage">
          <div className="gpu-manage-row head">
            <span>Name</span>
            <span>Memory (GB)</span>
            <span>Upcoming</span>
            <span />
          </div>
          {schedule.gpus.map((g) => (
            <div className={`gpu-manage-row ${g.active ? "" : "off"}`} key={g.id}>
              <input
                key={`${g.id}-${g.name}`}
                className="centered-name-input"
                defaultValue={g.name}
                aria-label="GPU name"
                maxLength={80}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    e.currentTarget.value = g.name;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={async (e) => {
                  const input = e.currentTarget;
                  const value = input.value.trim();
                  if (!value) {
                    input.value = g.name;
                    return;
                  }
                  if (value === g.name) return;
                  if (!(await run(() => updateGpu(g.id, { name: value }), "Saved."))) input.value = g.name;
                }}
              />
              <input
                key={`${g.id}-${g.memoryGb}`}
                type="number"
                min={1}
                step={1}
                defaultValue={g.memoryGb ?? ""}
                aria-label="Memory in GB"
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                onBlur={async (e) => {
                  const input = e.currentTarget;
                  if (input.value === String(g.memoryGb ?? "")) return;
                  if (!(await run(() => updateGpu(g.id, { memoryGb: memoryValue(input.value) }), "Saved."))) {
                    input.value = g.memoryGb ?? "";
                  }
                }}
              />
              <span className="muted">
                {g.upcomingCount} booking{g.upcomingCount === 1 ? "" : "s"}
              </span>
              <span className="gpu-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => updateGpu(g.id, { active: !g.active }),
                      g.active ? `${g.name} deactivated. Its bookings stay; it takes no new ones.` : `${g.name} activated.`,
                    )
                  }
                >
                  {g.active ? "Deactivate" : "Activate"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete ${g.name}? Its finished bookings are removed too.`)) {
                      run(() => deleteGpu(g.id), `${g.name} deleted.`);
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>

        <form
          className="gpu-manage-row add"
          onSubmit={async (e) => {
            e.preventDefault();
            const added = name.trim();
            if (!added) {
              setError("Enter a GPU name.");
              return;
            }
            if (await run(() => createGpu({ name: added, memoryGb: memoryValue(memory) }), `${added} added.`)) {
              setName("");
              setMemory("");
            }
          }}
        >
          <input
            className="centered-name-input"
            value={name}
            maxLength={80}
            placeholder="lab-server / GPU 2"
            aria-label="New GPU name"
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
          />
          <input
            type="number"
            min={1}
            step={1}
            value={memory}
            placeholder="24"
            aria-label="New GPU memory in GB"
            onChange={(e) => setMemory(e.target.value)}
          />
          <span />
          <span className="gpu-actions">
            <button type="submit" className="btn" disabled={busy}>
              Add GPU
            </button>
          </span>
        </form>

        <div className="gpu-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              run(detectGpus, (resp) =>
                resp.added.length > 0
                  ? `Found ${resp.found} GPU${resp.found === 1 ? "" : "s"}, added ${resp.added.join(", ")}.`
                  : `Found ${resp.found} GPU${resp.found === 1 ? "" : "s"}. All are already in the list.`,
              )
            }
          >
            Detect GPUs on this machine
          </button>
          <span className="muted">Runs nvidia-smi on the computer running the board server.</span>
        </div>
        {notice && <p className="msg info">{notice}</p>}
        {error && <p className="msg-error-inline" role="alert">{error}</p>}
      </div>
    </div>
  );
}

/**
 * GPU schedule tab: one timeline row per GPU for a day. Blocks can be dragged
 * to another time or GPU and stretched at either edge; the booking form's draft
 * block works the same way and is only saved by "Book".
 */
export default function GpuSchedule({ board, focus, onBoard, onShowTask }) {
  const [schedule, setSchedule] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [now, setNow] = useState(() => new Date());
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  // Block being dragged: { id, gpuId, startAt, endAt } (id is DRAFT for the form's block).
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null); // pointer session; also pauses polling
  const suppressClick = useRef(false);
  const handledFocus = useRef(null);

  const load = useCallback(async () => {
    try {
      setSchedule(await fetchGpuSchedule());
      setLoadError("");
    } catch (err) {
      setLoadError(`Could not load the GPU schedule: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      // A poll in the middle of a drag would snap the block back.
      if (document.visibilityState === "visible" && !dragRef.current) load();
      setNow(new Date());
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const apply = useCallback(
    (resp) => {
      setSchedule(resp.schedule);
      onBoard(resp.board);
    },
    [onBoard],
  );

  const tasksById = new Map(board.tasks.map((t) => [t.id, t]));
  const activeGpuIds = schedule ? schedule.gpus.filter((g) => g.active).map((g) => g.id) : [];

  const openForm = useCallback(
    (taskId, gpuId, start) => {
      if (!schedule) return;
      const ids = schedule.gpus.filter((g) => g.active).map((g) => g.id);
      const task = board.tasks.find((t) => t.id === taskId);
      const minutes = bookingMinutesFor(task, DEFAULT_MINUTES);
      let slot;
      if (gpuId) {
        slot = { gpuId, startAt: toTimeString(start), endAt: toTimeString(addMinutes(start, minutes)) };
      } else {
        // Continue after the task's last planned or running booking (on its GPU if
        // possible), so the timeline opens on that day instead of today.
        const own = schedule.bookings
          .filter((b) => b.taskId && b.taskId === taskId && ACTIVE_BOOKING.has(b.status))
          .sort((a, b) => (a.endAt < b.endAt ? 1 : -1));
        let from = nextHalfHour();
        let preferred = ids[0];
        if (own.length > 0) {
          const lastEnd = parseTime(own[0].endAt);
          if (lastEnd > from) from = lastEnd;
          if (ids.includes(own[0].gpuId)) preferred = own[0].gpuId;
        }
        slot = earliestSlot(schedule.bookings, ids, preferred, from, minutes);
      }
      if (!slot) return;
      setForm({ taskId: taskId ?? "", label: "", ...slot });
      setDay(startOfDay(parseTime(slot.startAt)));
      setSelectedId(null);
      setActionError("");
      setNotice("");
    },
    [schedule, board.tasks],
  );

  // Opened from a task: show its booking, or put a draft block for it on the timeline.
  useEffect(() => {
    if (!focus || !schedule || handledFocus.current === focus.nonce) return;
    handledFocus.current = focus.nonce;
    if (focus.bookingId) {
      const b = schedule.bookings.find((x) => x.id === focus.bookingId);
      if (b) {
        setDay(startOfDay(parseTime(b.startAt)));
        setSelectedId(b.id);
        setForm(null);
      }
    } else if (focus.bookTaskId) {
      openForm(focus.bookTaskId);
    }
  }, [focus, schedule, openForm]);

  if (!schedule) {
    return (
      <section className="panel gpu-panel" aria-label="GPU schedule">
        <div className="gpu-body">{loadError ? <p className="error">{loadError}</p> : <p>Loading…</p>}</div>
      </section>
    );
  }

  const selected = schedule.bookings.find((b) => b.id === selectedId);
  const need = unbookedTasks(board.tasks);
  const isToday = sameDay(day, now);

  // ---------- dragging blocks ----------

  const saveBookingTime = async (id, changes) => {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      apply(await updateBooking(id, changes));
      setSelectedId(id);
      setNotice("Booking updated.");
      return true;
    } catch (err) {
      setSelectedId(id);
      setActionError(err.message);
      load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const beginDrag = (e, item, mode) => {
    if (e.button !== 0 || busy) return;
    const track = e.currentTarget.closest(".gpu-track");
    if (!track) return;
    e.preventDefault();
    const session = {
      item,
      mode,
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
      pxPerMin: track.getBoundingClientRect().width / DAY_MIN,
      origS: parseTime(item.startAt),
      origE: parseTime(item.endAt),
      dayStart: day,
      dayEnd: addMinutes(day, DAY_MIN),
      current: null,
    };
    dragRef.current = session;

    const onMove = (ev) => {
      const dx = ev.clientX - session.x0;
      if (!session.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(ev.clientY - session.y0) < DRAG_THRESHOLD_PX) {
        return;
      }
      session.moved = true;
      const delta = Math.round(dx / session.pxPerMin / SNAP_MIN) * SNAP_MIN;
      const { origS, origE, dayStart, dayEnd } = session;
      let start = origS;
      let end = origE;
      let gpuId = item.gpuId;
      if (mode === "move") {
        let shift = delta;
        // Keep a block that was fully visible inside the day it is shown on.
        if (origS >= dayStart) shift = Math.max(shift, (dayStart - origS) / 60000);
        if (origE <= dayEnd) shift = Math.min(shift, (dayEnd - origE) / 60000);
        start = addMinutes(origS, shift);
        end = addMinutes(origE, shift);
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".gpu-track");
        if (over && over.dataset.active === "1") gpuId = over.dataset.gpuId;
      } else if (mode === "start") {
        start = addMinutes(origS, delta);
        if (origS >= dayStart && start < dayStart) start = dayStart;
        if (start > addMinutes(origE, -SNAP_MIN)) start = addMinutes(origE, -SNAP_MIN);
      } else {
        end = addMinutes(origE, delta);
        if (origE <= dayEnd && end > dayEnd) end = dayEnd;
        if (end < addMinutes(origS, SNAP_MIN)) end = addMinutes(origS, SNAP_MIN);
      }
      session.current = { id: item.id, gpuId, startAt: toTimeString(start), endAt: toTimeString(end) };
      setDrag(session.current);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragRef.current = null;
      const result = session.current;
      if (!session.moved || !result) {
        setDrag(null);
        return;
      }
      suppressClick.current = true; // the click that follows a drag is not a click
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (item.id === DRAFT) {
        setForm((f) => (f ? { ...f, gpuId: result.gpuId, startAt: result.startAt, endAt: result.endAt } : f));
        setDrag(null);
        return;
      }
      const changes = {};
      if (result.gpuId !== item.gpuId) changes.gpuId = result.gpuId;
      if (result.startAt !== item.startAt) changes.startAt = result.startAt;
      if (result.endAt !== item.endAt) changes.endAt = result.endAt;
      if (Object.keys(changes).length === 0) {
        setDrag(null);
        return;
      }
      // Keep showing the new position until the server answers; a 409 snaps it back.
      saveBookingTime(item.id, changes).finally(() => setDrag(null));
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Every block with its shown position (a dragged one follows the pointer).
  const blocks = schedule.bookings.map((b) => (drag && drag.id === b.id ? { ...b, ...drag } : b));
  if (form && form.startAt && form.endAt && form.startAt < form.endAt) {
    const draft = { id: DRAFT, status: "draft", gpuId: form.gpuId, startAt: form.startAt, endAt: form.endAt };
    blocks.push(drag && drag.id === DRAFT ? { ...draft, ...drag } : draft);
  }
  const conflictOf = (item) =>
    findConflicts(schedule.bookings, item.gpuId, item.startAt, item.endAt, item.id === DRAFT ? null : item.id);

  const renderBlock = (item) => {
    const isDraft = item.id === DRAFT;
    const dragging = drag?.id === item.id;
    const conflicts = isDraft || dragging ? conflictOf(item) : [];
    const kind = isDraft ? "draft" : bookingKind(item);
    const hours = formatHours(hoursBetween(item.startAt, item.endAt));
    const label = dragging
      ? `${clock(item.startAt)}–${clock(item.endAt)} · ${hours}`
      : isDraft
        ? `New booking · ${hours}`
        : bookingTitle(item);
    return (
      <Block
        key={item.id}
        item={item}
        day={day}
        kind={kind}
        label={label}
        title={
          isDraft
            ? "New booking (not saved yet). Drag to move, drag an edge to change the length."
            : `${bookingTitle(item)} · ${formatRange(item.startAt, item.endAt)} · ${KIND_LABEL[kind]}`
        }
        selected={selectedId === item.id}
        dragging={dragging}
        conflict={conflicts.length > 0}
        onPointerDown={beginDrag}
        onClick={(id) => {
          if (suppressClick.current) return;
          setSelectedId(id);
          setForm(null);
          setActionError("");
          setNotice("");
        }}
      />
    );
  };

  const dragInfo = (() => {
    if (!drag) return null;
    const item = blocks.find((b) => b.id === drag.id);
    if (!item) return null;
    const gpu = schedule.gpus.find((g) => g.id === drag.gpuId);
    const conflicts = conflictOf(item);
    const task = tasksById.get(item.id === DRAFT ? form?.taskId : item.taskId);
    return (
      <div className={`gpu-drag-info ${conflicts.length ? "bad" : ""}`} role="status">
        {gpu?.name} · {formatRange(drag.startAt, drag.endAt)} · {formatHours(hoursBetween(drag.startAt, drag.endAt))}
        {conflicts.length > 0 && ` · overlaps ${conflicts.map(bookingTitle).join(", ")}`}
        {task?.gpuHours != null && ` · task needs ${formatHours(task.gpuHours)}`}
      </div>
    );
  })();

  // ---------- form and actions ----------

  const submit = async () => {
    if (!form.taskId) return setActionError("Choose a task, or pick “Not a board task”.");
    if (form.taskId === OTHER && !form.label.trim()) return setActionError("Describe who else is using the GPU.");
    if (!(form.startAt && form.endAt && form.startAt < form.endAt)) {
      return setActionError("The end time must be after the start time.");
    }
    setBusy(true);
    setActionError("");
    try {
      const body =
        form.taskId === OTHER
          ? { gpuId: form.gpuId, label: form.label.trim(), startAt: form.startAt, endAt: form.endAt }
          : { gpuId: form.gpuId, taskId: form.taskId, startAt: form.startAt, endAt: form.endAt };
      const resp = await createBooking(body);
      apply(resp);
      setForm(null);
      setSelectedId(resp.bookingId);
      setNotice(resp.warning || "Booked.");
    } catch (err) {
      setActionError(err.message);
      load();
    } finally {
      setBusy(false);
    }
  };

  const act = async (action) => {
    if (action === "delete" && selected.status === "planned" && !window.confirm("Cancel this booking?")) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      if (action === "start") apply(await updateBooking(selected.id, { status: "running" }));
      if (action === "finish") apply(await updateBooking(selected.id, { status: "done" }));
      if (action === "delete") {
        apply(await deleteBooking(selected.id));
        setSelectedId(null);
      }
    } catch (err) {
      setActionError(err.message);
      load();
    } finally {
      setBusy(false);
    }
  };

  const handleRenameGpu = async (gpuId, name) => {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      apply(await updateGpu(gpuId, { name }));
      setNotice("GPU renamed.");
    } catch (err) {
      setActionError(err.message);
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel gpu-panel" aria-label="GPU schedule">
      <div className="panel-head">
        <h2>GPU schedule</h2>
        <span className="hint">
          Click an empty spot to book from that hour. Drag a block to move it (across GPUs too) and drag its edges to
          change the length. Bookings on the same GPU can't overlap.
        </span>
      </div>
      <div className="gpu-body">
        {loadError && <p className="error">{loadError}</p>}
        <div className="gpu-toolbar">
          <button type="button" className="btn" aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))}>
            ‹
          </button>
          <span className="gpu-day">
            {formatDay(day)}
            {isToday && <span className="muted"> · today</span>}
          </span>
          <button type="button" className="btn" aria-label="Next day" onClick={() => setDay(shiftDay(day, 1))}>
            ›
          </button>
          {!isToday && (
            <button type="button" className="btn" onClick={() => setDay(startOfDay(new Date()))}>
              Today
            </button>
          )}
          <span className="gpu-spacer" />
          <button type="button" className="btn" onClick={() => setManageOpen(true)}>
            Manage GPUs
          </button>
        </div>

        <div className="gpu-scroll">
          <div className={`gpu-grid ${drag ? "is-dragging" : ""}`}>
            <div />
            <div className="gpu-hours" aria-hidden="true">
              {HOUR_LABELS.map((h) => (
                <span key={h} style={{ left: pct(h * 60) }} className={h === 0 ? "first" : h === 24 ? "last" : ""}>
                  {String(h).padStart(2, "0")}
                </span>
              ))}
            </div>
            {schedule.gpus.map((g) => (
              <GpuRow
                key={g.id}
                gpu={g}
                day={day}
                blocks={blocks.filter((b) => b.gpuId === g.id)}
                now={now}
                busy={busy}
                onRenameGpu={handleRenameGpu}
                renderBlock={renderBlock}
                onPickTime={(gpuId, start) => {
                  if (suppressClick.current) return;
                  const keep = form?.taskId ?? need[0]?.id ?? "";
                  openForm(keep, gpuId, start);
                }}
              />
            ))}
          </div>
        </div>
        {dragInfo}

        <div className="gpu-legend">
          {LEGEND.map((k) => (
            <span key={k}>
              <span className={`gpu-swatch ${k}`} aria-hidden="true" />
              {KIND_LABEL[k]}
            </span>
          ))}
          <span>
            <span className="gpu-swatch draft" aria-hidden="true" />
            New booking (not saved)
          </span>
          <span>
            <span className="gpu-swatch now" aria-hidden="true" />
            Now
          </span>
        </div>

        <div className="gpu-lower">
          {form ? (
            <BookingForm
              form={form}
              setForm={(f) => {
                setForm(f);
                setActionError("");
              }}
              schedule={schedule}
              tasks={board.tasks}
              onSubmit={submit}
              onCancel={() => {
                setForm(null);
                setActionError("");
              }}
              busy={busy}
              error={actionError}
            />
          ) : selected ? (
            <BookingDetail
              booking={selected}
              schedule={schedule}
              task={selected.taskId ? tasksById.get(selected.taskId) : null}
              onAction={act}
              onSave={(changes) => saveBookingTime(selected.id, changes)}
              onShowTask={onShowTask}
              busy={busy}
              error={actionError}
            />
          ) : (
            <div className="gpu-box">
              <h3>Booking</h3>
              <p className="muted">
                Select a booking to see or change it, or click an empty spot on a GPU to book it.
              </p>
              {activeGpuIds.length > 0 && (
                <div className="gpu-actions">
                  <button type="button" className="btn" onClick={() => openForm(need[0]?.id ?? "")}>
                    New booking
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="gpu-box">
            <h3>
              Tasks that need a GPU
              {need.length > 0 && <span className="count">{need.length}</span>}
            </h3>
            {need.length === 0 ? (
              <p className="muted">
                None waiting for a booking. Mark a task as needing a GPU from its details on the Tasks tab.
              </p>
            ) : (
              <ul className="gpu-need-list">
                {need.map((t) => (
                  <li key={t.id}>
                    <span>
                      <span className="related-title">{t.title}</span>
                      <span className="muted">
                        {" "}· {board.members.find((m) => m.id === t.assigneeId)?.name || "Task Pool"} · {needLabel(t)}
                      </span>
                    </span>
                    <button type="button" className="btn" onClick={() => openForm(t.id)}>
                      Schedule
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {!form && !selected && actionError && (
          <p className="msg-error-inline" role="alert">
            {actionError}
          </p>
        )}
        {notice && <p className="msg info">{notice}</p>}
      </div>

      {manageOpen && (
        <ManageGpus
          schedule={schedule}
          onApply={apply}
          onClose={() => {
            setManageOpen(false);
            if (form && !schedule.gpus.find((g) => g.id === form.gpuId && g.active)) setForm(null);
          }}
        />
      )}
    </section>
  );
}
