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
  bookingTitle,
  earliestSlot,
  findConflicts,
  formatRange,
  KIND_LABEL,
  nextHalfHour,
  parseTime,
  sameDay,
  startOfDay,
  toTimeString,
} from "./gpuState.js";

const POLL_MS = 5000;
const DAY_MIN = 24 * 60;
const DEFAULT_MINUTES = 120;
const OTHER = "__other__"; // booking that is not a board task (e.g. another lab's job)
const HOUR_LABELS = Array.from({ length: 13 }, (_, i) => i * 2);
const LEGEND = ["planned", "blocked", "running", "done", "external"];

const minutesFrom = (day, s) => (parseTime(s).getTime() - day.getTime()) / 60000;
const shiftDay = (day, n) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
const pct = (m) => `${(m / DAY_MIN) * 100}%`;

function formatDay(day) {
  return day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Tasks that need a GPU but have no planned or running booking. */
function unbookedTasks(tasks) {
  return tasks.filter(
    (t) => t.needsGpu && t.status !== "done" && !(t.gpuBooking && ACTIVE_BOOKING.has(t.gpuBooking.status)),
  );
}

function GpuRow({ gpu, day, bookings, selectedId, draft, now, onPickTime, onSelect }) {
  const trackRef = useRef(null);
  const dayEnd = DAY_MIN;
  const visible = bookings.filter((b) => {
    const s = minutesFrom(day, b.startAt);
    const e = minutesFrom(day, b.endAt);
    return e > 0 && s < dayEnd;
  });
  const [host, short] = gpu.name.includes(" / ")
    ? [gpu.name.slice(0, gpu.name.lastIndexOf(" / ")), gpu.name.split(" / ").pop()]
    : [null, gpu.name];

  const bar = (startAt, endAt) => {
    const s = Math.max(0, minutesFrom(day, startAt));
    const e = Math.min(dayEnd, minutesFrom(day, endAt));
    return { left: pct(s), width: `calc(${pct(e - s)} - 2px)` };
  };

  return (
    <>
      <div className={`gpu-label ${gpu.active ? "" : "inactive"}`} title={gpu.name}>
        <strong>{short}</strong>
        <span className="muted">
          {[host, gpu.memoryGb ? `${gpu.memoryGb} GB` : null, gpu.active ? null : "Deactivated"]
            .filter(Boolean)
            .join(" · ") || " "}
        </span>
      </div>
      <div
        ref={trackRef}
        className={`gpu-track ${gpu.active ? "" : "inactive"}`}
        data-gpu-id={gpu.id}
        title={gpu.active ? "Click an empty spot to book from that hour" : "Deactivated: no new bookings"}
        onClick={(e) => {
          if (!gpu.active || e.target !== trackRef.current) return;
          const rect = trackRef.current.getBoundingClientRect();
          const hour = Math.min(23, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * 24)));
          onPickTime(gpu.id, addMinutes(day, hour * 60));
        }}
      >
        {visible.map((b) => {
          const kind = bookingKind(b);
          return (
            <button
              key={b.id}
              type="button"
              className={`gpu-bar ${kind} ${selectedId === b.id ? "selected" : ""}`}
              style={bar(b.startAt, b.endAt)}
              title={`${bookingTitle(b)} · ${formatRange(b.startAt, b.endAt)} · ${KIND_LABEL[kind]}`}
              data-booking-id={b.id}
              onClick={() => onSelect(b.id)}
            >
              {bookingTitle(b)}
            </button>
          );
        })}
        {draft && draft.gpuId === gpu.id && draft.startAt < draft.endAt &&
          minutesFrom(day, draft.endAt) > 0 && minutesFrom(day, draft.startAt) < dayEnd && (
            <span className={`gpu-bar draft ${draft.conflict ? "bad" : ""}`} style={bar(draft.startAt, draft.endAt)}>
              New booking
            </span>
          )}
        {sameDay(day, now) && (
          <span className="gpu-now" style={{ left: pct(minutesFrom(day, toTimeString(now))) }} aria-hidden="true" />
        )}
      </div>
    </>
  );
}

function BookingForm({ form, setForm, schedule, tasks, onSubmit, onCancel, busy, error }) {
  const activeGpus = schedule.gpus.filter((g) => g.active);
  const need = unbookedTasks(tasks);
  const others = tasks.filter(
    (t) => t.status !== "done" && !need.includes(t) && !(t.gpuBooking && ACTIVE_BOOKING.has(t.gpuBooking.status)),
  );
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
      <div className="gpu-form">
        <label htmlFor="gpu-form-task">Task</label>
        <select id="gpu-form-task" value={form.taskId} onChange={(e) => set({ taskId: e.target.value })}>
          <option value="">Choose a task</option>
          {need.length > 0 && (
            <optgroup label="Needs a GPU">
              {need.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
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
            const end = toTimeString(addMinutes(parseTime(start), minutes));
            set({ startAt: start, endAt: end });
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

      {!validTimes ? (
        <p className="gpu-check bad">The end time must be after the start time.</p>
      ) : conflicts.length > 0 ? (
        <p className="gpu-check bad">
          Overlaps{" "}
          {conflicts
            .map((c) => `${bookingTitle(c)} (${formatRange(c.startAt, c.endAt)})`)
            .join(", ")}
          .
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

function BookingDetail({ booking, onAction, onShowTask, busy, error }) {
  const kind = bookingKind(booking);
  return (
    <div className="gpu-box">
      <h3>{bookingTitle(booking)}</h3>
      <dl className="gpu-dl">
        <dt>GPU</dt>
        <dd>{booking.gpuName}</dd>
        <dt>Time</dt>
        <dd>{formatRange(booking.startAt, booking.endAt)}</dd>
        <dt>Owner</dt>
        <dd>{booking.taskId ? booking.assigneeName || "Unassigned (Task Pool)" : "Not a board task"}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`gpu-swatch ${kind}`} aria-hidden="true" />
          {KIND_LABEL[kind]}
        </dd>
      </dl>
      {kind === "blocked" && (
        <p className="msg-warning">The job can start once all prerequisites of this task are completed.</p>
      )}
      {error && <p className="msg-error-inline" role="alert">{error}</p>}
      <div className="gpu-actions">
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
                defaultValue={g.name}
                aria-label="GPU name"
                maxLength={80}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                onBlur={async (e) => {
                  const input = e.currentTarget;
                  const value = input.value.trim();
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

/** GPU schedule tab: one timeline row per GPU for a day, plus booking and GPU management. */
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
      if (document.visibilityState === "visible") load();
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

  const activeGpuIds = schedule ? schedule.gpus.filter((g) => g.active).map((g) => g.id) : [];

  const openForm = useCallback(
    (taskId, gpuId, start) => {
      if (!schedule) return;
      const ids = schedule.gpus.filter((g) => g.active).map((g) => g.id);
      let slot;
      if (gpuId) {
        slot = { gpuId, startAt: toTimeString(start), endAt: toTimeString(addMinutes(start, DEFAULT_MINUTES)) };
      } else {
        slot = earliestSlot(schedule.bookings, ids, ids[0], nextHalfHour(), DEFAULT_MINUTES);
      }
      if (!slot) return;
      setForm({ taskId: taskId ?? "", label: "", ...slot });
      setDay(startOfDay(parseTime(slot.startAt)));
      setSelectedId(null);
      setActionError("");
      setNotice("");
    },
    [schedule],
  );

  // Opened from a task: show its booking, or start booking for it.
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
  const draft =
    form && form.startAt && form.endAt
      ? { ...form, conflict: findConflicts(schedule.bookings, form.gpuId, form.startAt, form.endAt).length > 0 }
      : null;
  const need = unbookedTasks(board.tasks);
  const isToday = sameDay(day, now);

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

  return (
    <section className="panel gpu-panel" aria-label="GPU schedule">
      <div className="panel-head">
        <h2>GPU schedule</h2>
        <span className="hint">
          Click an empty spot on a GPU to book it from that hour. Bookings on the same GPU can't overlap.
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
          <div className="gpu-grid">
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
                bookings={schedule.bookings.filter((b) => b.gpuId === g.id)}
                selectedId={selectedId}
                draft={draft}
                now={now}
                onPickTime={(gpuId, start) => {
                  const keep = form?.taskId ?? need[0]?.id ?? "";
                  openForm(keep, gpuId, start);
                }}
                onSelect={(id) => {
                  setSelectedId(id);
                  setForm(null);
                  setActionError("");
                  setNotice("");
                }}
              />
            ))}
          </div>
        </div>

        <div className="gpu-legend">
          {LEGEND.map((k) => (
            <span key={k}>
              <span className={`gpu-swatch ${k}`} aria-hidden="true" />
              {KIND_LABEL[k]}
            </span>
          ))}
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
            <BookingDetail booking={selected} onAction={act} onShowTask={onShowTask} busy={busy} error={actionError} />
          ) : (
            <div className="gpu-box">
              <h3>Booking</h3>
              <p className="muted">
                Select a booking to see its details, or click an empty spot on a GPU to book it.
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
                      <span className="muted"> · {board.members.find((m) => m.id === t.assigneeId)?.name || "Task Pool"}</span>
                    </span>
                    <button type="button" className="btn" onClick={() => openForm(t.id)}>
                      Book
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
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
