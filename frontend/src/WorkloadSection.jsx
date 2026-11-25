import { useEffect, useRef, useState } from "react";
import { DIFFICULTY_LABEL, formatWorkHours, isAiHours, isAiStars, isAiWork, MAX_STARS } from "./workload.js";

/**
 * Pick 1-5 stars. A radio group: arrow keys move, clicking the chosen star
 * again clears it.
 */
export function StarPicker({ value, onChange, idPrefix = "stars" }) {
  const refs = useRef([]);
  const choose = (n) => {
    onChange(n);
    refs.current[(n || 1) - 1]?.focus();
  };
  return (
    <span className="star-picker" role="radiogroup" aria-label="Difficulty">
      {Array.from({ length: MAX_STARS }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          ref={(el) => (refs.current[n - 1] = el)}
          id={`${idPrefix}-${n}`}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} of 5: ${DIFFICULTY_LABEL[n]}`}
          title={`${n} of 5: ${DIFFICULTY_LABEL[n]}`}
          tabIndex={value === n || (!value && n === 1) ? 0 : -1}
          className={value && n <= value ? "on" : ""}
          onClick={() => onChange(value === n ? null : n)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowUp") {
              e.preventDefault();
              choose(Math.min(MAX_STARS, (value || 0) + 1));
            } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
              e.preventDefault();
              choose(Math.max(1, (value || 2) - 1));
            }
          }}
        >
          ★
        </button>
      ))}
    </span>
  );
}

/**
 * Workload part of the task details: estimated human work hours and a 1-5
 * star difficulty. AI estimates are marked until a person confirms or edits
 * them. Separate from the GPU hours, and the hours never change the dates.
 */
export default function WorkloadSection({ task, onSaveTask, onEstimate }) {
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState("");
  const [stars, setStars] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const est = task.workEstimate || {};
  const ai = isAiWork(task);
  const hasValues = task.workHours != null || Boolean(task.difficulty);
  const isDone = task.status === "done";

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
    setHours(task.workHours == null ? "" : String(task.workHours));
    setStars(task.difficulty || null);
    setEditing(true);
    setError("");
  };

  const save = async (e) => {
    e.preventDefault();
    const workHours = hours.trim() === "" ? null : Number(hours);
    if (workHours !== null && !(workHours > 0 && workHours <= 1000)) {
      setError("Work hours must be more than 0 and at most 1000, or empty.");
      return;
    }
    // confirmWork: saving the form also confirms values that were left as the AI gave them.
    if (await run(() => onSaveTask(task.id, { workHours, difficulty: stars, confirmWork: true }))) setEditing(false);
  };

  return (
    <section className="related-section workload-section" aria-label="Workload">
      <h4>Workload</h4>
      {!editing && (
        <>
          {est.status === "pending" && !hasValues && (
            <p className="muted">Asking the AI how much work this is…</p>
          )}
          {hasValues ? (
            <p className={ai ? "workload-ai" : undefined}>
              {ai && (
                <span className="ai-tag">
                  {isAiHours(task) && isAiStars(task)
                    ? "AI estimate"
                    : isAiHours(task)
                      ? "AI estimate: hours"
                      : "AI estimate: difficulty"}
                </span>
              )}
              {task.workHours != null
                ? `${isAiHours(task) ? "~" : ""}${formatWorkHours(task.workHours)} of work`
                : "Hours not estimated"}
              {task.difficulty && (
                <>
                  {" · "}
                  <span className="workload-stars" aria-label={`difficulty ${task.difficulty} of 5`}>
                    {"★".repeat(task.difficulty)}
                    <span className="off">{"★".repeat(MAX_STARS - task.difficulty)}</span>
                  </span>
                </>
              )}
            </p>
          ) : (
            est.status !== "pending" && <p className="muted">Not estimated yet.</p>
          )}
          {task.difficulty && <p className="muted">{DIFFICULTY_LABEL[task.difficulty]}</p>}
          {ai && est.reason && <p className="muted workload-reason">{est.reason}</p>}
          {est.status === "failed" && !hasValues && est.error && (
            <p className="msg-error-inline">AI estimate failed: {est.error}</p>
          )}
          <p className="muted workload-hint">People's effort only, not GPU time. It doesn't change the planned dates.</p>
        </>
      )}

      {editing && (
        <form className="workload-form" onSubmit={save} aria-label="Edit workload">
          <label htmlFor="workload-hours">Work hours</label>
          <input
            id="workload-hours"
            type="number"
            min={0.5}
            max={1000}
            step={0.5}
            placeholder="Not estimated"
            value={hours}
            autoFocus
            onChange={(e) => setHours(e.target.value)}
          />
          <span className="form-label" id="workload-stars-label">Difficulty</span>
          <span className="workload-picker">
            <StarPicker value={stars} onChange={setStars} idPrefix="workload-star" />
            <span className="muted">{stars ? DIFFICULTY_LABEL[stars] : "Not rated"}</span>
          </span>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>
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

      {!editing && !isDone && (
        <div className="detail-actions">
          {ai && hasValues && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(() => onSaveTask(task.id, { confirmWork: true }))}
            >
              Confirm
            </button>
          )}
          <button type="button" className="btn" onClick={startEdit}>
            {hasValues ? "Edit" : "Estimate…"}
          </button>
          {est.status !== "pending" && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => onEstimate(task.id, ["work"]))}>
              {ai || est.status ? "Ask AI again" : "Ask AI"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
