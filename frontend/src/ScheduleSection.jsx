import { useEffect, useState } from "react";
import { daysBetween, formatPlanned, isScheduled } from "./dates.js";
import { ISSUE_LABEL, issueKind, shownIssues } from "./scheduleIssues.js";
import "./WeekTimeline.css"; // the .schedule-* styles

/**
 * Scheduling part of the task details: owner and planned dates. Estimated work
 * hours and difficulty are in the Workload section (WorkloadSection.jsx); they
 * never decide the dates. The server checks every change
 * against prerequisites (backend/schedule.py) and rejects conflicts; its
 * message is shown here and nothing is saved.
 */
export default function ScheduleSection({ task, members, onSaveTask }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ owner: "", start: "", end: "" });
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
    const { owner, start, end } = form;
    if (Boolean(start) !== Boolean(end)) {
      setError("Set both the planned start and end dates, or clear both.");
      return;
    }
    if (start && end < start) {
      setError("The planned end date can't be before the planned start date.");
      return;
    }
    const ok = await run({
      assigneeId: owner || null,
      plannedStart: start || null,
      plannedEnd: end || null,
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
