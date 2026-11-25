import { useEffect, useState } from "react";
import { daysBetween, formatPlanned, isScheduled } from "./dates.js";
import { ISSUE_LABEL, issueKind, shownIssues } from "./scheduleIssues.js";
import "./WeekTimeline.css"; // the .schedule-* styles

/**
 * Scheduling part of the task details: owner, planned dates and estimated
 * human work hours. Work hours never decide the dates, and they are separate
 * from the GPU hours in the GPU section. The server checks every change
 * against prerequisites (backend/schedule.py) and rejects conflicts; its
 * message is shown here and nothing is saved.
 */
export default function ScheduleSection({ task, members, onSaveTask }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ owner: "", start: "", end: "", hours: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scheduled = isScheduled(task);
  // Conflicts and dependency warnings; same-member overlaps are not shown.
  const issues = shownIssues(task.scheduleIssues);

  useEffect(() => {
    setEditing(false);
    setError("");
  }, [task.id]);

  const startEdit = () => {
    setForm({
      owner: task.assigneeId || "",
      start: task.plannedStart || "",
      end: task.plannedEnd || task.plannedStart || "",
      hours: task.workHours == null ? "" : String(task.workHours),
    });
    setError("");
    setEditing(true);
  };

  const run = async (changes) => {
    setBusy(true);
    setError("");
    try {
      await onSaveTask(task.id, changes);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    const { owner, start, end, hours } = form;
    if (Boolean(start) !== Boolean(end)) {
      setError("Set both the planned start and end dates, or clear both.");
      return;
    }
    if (start && end < start) {
      setError("The planned end date can't be before the planned start date.");
      return;
    }
    const workHours = hours.trim() === "" ? null : Number(hours);
    if (workHours !== null && !(workHours > 0 && workHours <= 1000)) {
      setError("Work hours must be more than 0 and at most 1000, or empty.");
      return;
    }
    const ok = await run({
      assigneeId: owner || null,
      plannedStart: start || null,
      plannedEnd: end || null,
      workHours,
    });
    if (ok) setEditing(false);
  };

  const set = (key) => (e) => {
    const value = e.target.value;
    // Picking a start after the end moves the end along (a one-day task by default).
    setForm((f) => (key === "start" && value && (!f.end || f.end < value) ? { ...f, start: value, end: value } : { ...f, [key]: value }));
  };

  const days = scheduled ? daysBetween(task.plannedStart, task.plannedEnd) + 1 : 0;

  return (
    <section className="related-section schedule-section" aria-label="Scheduling">
      <h4>Scheduling</h4>
      {!editing && (
        <>
          <p data-testid="schedule-summary">
            {scheduled
              ? `Planned ${formatPlanned(task.plannedStart, task.plannedEnd)} (${days} ${days === 1 ? "day" : "days"})`
              : "Not scheduled · in the Task Pool"}
          </p>
          <p className="muted">
            {task.workHours != null ? `Estimated work: ${task.workHours}h (people, not GPU)` : "Work hours not estimated"}
          </p>
        </>
      )}

      {issues.length > 0 && (
        <ul className="schedule-issues">
          {issues.map((i) => (
            <li key={`${i.code}-${i.relatedIds.join(",")}`} className={issueKind(i)}>
              <strong>{ISSUE_LABEL[issueKind(i)]}:</strong> {i.message}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <form className="schedule-form" onSubmit={save} aria-label="Edit schedule">
          <label htmlFor="schedule-owner">Owner</label>
          <select id="schedule-owner" value={form.owner} onChange={set("owner")}>
            <option value="">No owner</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <label htmlFor="schedule-start">Planned start</label>
          <input id="schedule-start" type="date" value={form.start} onChange={set("start")} />
          <label htmlFor="schedule-end">Planned end</label>
          <input id="schedule-end" type="date" value={form.end} min={form.start || undefined} onChange={set("end")} />
          <label htmlFor="schedule-hours">Work hours</label>
          <input
            id="schedule-hours"
            type="number"
            min={0.5}
            max={1000}
            step={0.5}
            placeholder="Not estimated"
            value={form.hours}
            onChange={set("hours")}
          />
          <p className="muted schedule-hint">Work hours are an estimate of people's effort. They don't change the dates.</p>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="msg-error-inline" role="alert">
          {error}
        </p>
      )}

      {!editing && (
        <div className="detail-actions">
          <button type="button" className="btn" onClick={startEdit}>
            {scheduled ? "Edit schedule" : "Schedule…"}
          </button>
          {scheduled && (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => run({ plannedStart: null, plannedEnd: null })}
              title="Clear the dates. Owner, prerequisites, work hours and GPU information stay."
            >
              Clear schedule
            </button>
          )}
        </div>
      )}
    </section>
  );
}
