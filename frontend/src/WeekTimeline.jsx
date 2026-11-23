import { useEffect, useMemo, useState } from "react";
import "./WeekTimeline.css";

/*
 * Date-based Timeline: members as columns, the 7 days of one week as rows.
 * A task appears when it has an assignee and planned dates (plannedStart /
 * plannedEnd, "YYYY-MM-DD", inclusive) that touch the visible week. Tasks
 * without dates belong in the Task Pool, which is not part of this component.
 *
 * The component only reports intent: dropping a card on a member/date cell
 * calls onDropTask(taskId, memberId, date). Choosing the length, validating
 * against prerequisites and saving are the caller's job (backend/schedule.py).
 * Not wired into App.jsx yet; see timelinePreview.jsx for a mock-data preview.
 */

const DAYS = 7;
export const DRAG_TYPE = "text/plain"; // same as the existing board cards

// ---------- local-date helpers ("YYYY-MM-DD", no time zone shifts) ----------

const pad = (n) => String(n).padStart(2, "0");

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateStr(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Monday of the week containing dateStr. */
export function startOfWeek(dateStr) {
  const d = parseDateStr(dateStr);
  const offset = (d.getDay() + 6) % 7; // Mon = 0 ... Sun = 6
  d.setDate(d.getDate() - offset);
  return toDateStr(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  return Math.round((parseDateStr(b) - parseDateStr(a)) / 86400000);
}

const dayName = (s) => parseDateStr(s).toLocaleDateString("en-US", { weekday: "short" });
const monthDay = (s) => parseDateStr(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function weekLabel(start) {
  const end = addDays(start, DAYS - 1);
  const year = parseDateStr(end).getFullYear();
  return `${monthDay(start)} – ${monthDay(end)}, ${year}`;
}

// ---------- layout ----------

/** Cards of one member in this week, with grid rows and a lane per overlap group. */
function layoutMember(tasks, weekStart) {
  const weekEnd = addDays(weekStart, DAYS - 1);
  const visible = tasks
    .filter((t) => t.plannedStart && t.plannedEnd && t.plannedStart <= weekEnd && t.plannedEnd >= weekStart)
    .sort((a, b) => a.plannedStart.localeCompare(b.plannedStart) || b.plannedEnd.localeCompare(a.plannedEnd));

  const laneEnds = []; // last date used in each lane
  const items = visible.map((t) => {
    let lane = laneEnds.findIndex((end) => end < t.plannedStart);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = t.plannedEnd;
    const from = t.plannedStart < weekStart ? weekStart : t.plannedStart;
    const to = t.plannedEnd > weekEnd ? weekEnd : t.plannedEnd;
    return {
      task: t,
      lane,
      rowStart: daysBetween(weekStart, from) + 1,
      rowEnd: daysBetween(weekStart, to) + 2,
      continuesBefore: t.plannedStart < weekStart,
      continuesAfter: t.plannedEnd > weekEnd,
    };
  });
  return { items, lanes: Math.max(1, laneEnds.length) };
}

function cardKind(task) {
  if (task.status === "done") return "done";
  return task.blocked ? "waiting" : "ready";
}

function ScheduledCard({ item, issues, selected, onSelect }) {
  const { task } = item;
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const flag = errors.length ? "has-error" : warnings.length ? "has-warning" : "";
  const days = daysBetween(task.plannedStart, task.plannedEnd) + 1;
  const range = days === 1 ? monthDay(task.plannedStart) : `${monthDay(task.plannedStart)} – ${monthDay(task.plannedEnd)}`;
  const issueText = issues.map((i) => i.message).join("\n");

  return (
    <button
      type="button"
      className={`wt-card ${cardKind(task)} ${flag} ${selected ? "selected" : ""}`}
      style={{ gridRow: `${item.rowStart} / ${item.rowEnd}`, gridColumn: item.lane + 1 }}
      draggable
      data-task-id={task.id}
      title={issueText || undefined}
      aria-label={`${task.title}, ${range}${issues.length ? `, ${issues.length} schedule issue(s)` : ""}`}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onSelect?.(task.id)}
    >
      {item.continuesBefore && <span className="wt-continues">▲ from {monthDay(task.plannedStart)}</span>}
      <span className="wt-card-title">{task.title}</span>
      <span className="wt-card-meta">
        {range}
        {task.workHours != null && ` · ${task.workHours}h work`}
      </span>
      {issues.length > 0 && (
        <span className={`wt-issue ${errors.length ? "error" : "warning"}`}>
          {errors.length ? "Conflict" : "Warning"}
          {issues.length > 1 && ` (${issues.length})`}
        </span>
      )}
      {item.continuesAfter && <span className="wt-continues">▼ until {monthDay(task.plannedEnd)}</span>}
    </button>
  );
}

/**
 * Props
 *   members        [{ id, name }]
 *   tasks          [{ id, title, status, blocked, assigneeId, plannedStart, plannedEnd, workHours }]
 *   weekStart      "YYYY-MM-DD" (any day; shown from that week's Monday)
 *   today          "YYYY-MM-DD", highlighted when visible
 *   onWeekChange   (newWeekStart) => void
 *   onDropTask     (taskId, memberId, date) => void
 *   onSelectTask   (taskId) => void
 *   issuesByTask   { taskId: [{ severity: "error"|"warning", message }] }
 *   selectedId     task id to outline
 */
export default function WeekTimeline({
  members,
  tasks,
  weekStart,
  today,
  onWeekChange,
  onDropTask,
  onSelectTask,
  issuesByTask = {},
  selectedId = null,
}) {
  const start = startOfWeek(weekStart);
  const dates = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(start, i)), [start]);
  const [over, setOver] = useState(null); // "memberId|date" under the pointer
  const [dragging, setDragging] = useState(false);

  // Any drag on the page (also from the Task Pool) lets drops reach the cells.
  useEffect(() => {
    const on = () => setDragging(true);
    const off = () => {
      setDragging(false);
      setOver(null);
    };
    window.addEventListener("dragstart", on);
    window.addEventListener("dragend", off);
    window.addEventListener("drop", off);
    return () => {
      window.removeEventListener("dragstart", on);
      window.removeEventListener("dragend", off);
      window.removeEventListener("drop", off);
    };
  }, []);

  const layouts = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, layoutMember(tasks.filter((t) => t.assigneeId === m.id), start)])),
    [members, tasks, start]
  );

  const cellProps = (memberId, date) => {
    const key = `${memberId}|${date}`;
    return {
      onDragOver: (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (over !== key) setOver(key);
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOver((k) => (k === key ? null : k));
      },
      onDrop: (e) => {
        e.preventDefault();
        setOver(null);
        setDragging(false);
        const taskId = e.dataTransfer.getData(DRAG_TYPE);
        if (taskId) onDropTask?.(taskId, memberId, date);
      },
    };
  };

  return (
    <section className={`wt panel ${dragging ? "is-dragging" : ""}`} aria-label="Week timeline">
      <div className="wt-head">
        <h2>Timeline</h2>
        <div className="wt-nav">
          <button type="button" className="btn" onClick={() => onWeekChange?.(addDays(start, -DAYS))}>
            ‹ Previous week
          </button>
          <button
            type="button"
            className="btn"
            disabled={!today || startOfWeek(today) === start}
            onClick={() => onWeekChange?.(startOfWeek(today))}
          >
            This week
          </button>
          <button type="button" className="btn" onClick={() => onWeekChange?.(addDays(start, DAYS))}>
            Next week ›
          </button>
          <span className="wt-range" aria-live="polite">{weekLabel(start)}</span>
        </div>
      </div>

      <div className="wt-scroll">
        <div className="wt-grid" style={{ gridTemplateColumns: `var(--wt-axis-w) repeat(${members.length}, minmax(var(--wt-col-min), 1fr))` }}>
          <div className="wt-corner" style={{ gridRow: 1, gridColumn: 1 }} />
          {members.map((m, ci) => (
            <div key={m.id} className="wt-member" style={{ gridRow: 1, gridColumn: ci + 2 }}>
              {m.name}
            </div>
          ))}

          {dates.map((d, ri) => (
            <div
              key={d}
              className={`wt-date ${d === today ? "today" : ""}`}
              style={{ gridRow: ri + 2, gridColumn: 1 }}
            >
              <span className="wt-dayname">{dayName(d)}</span>
              <span>{monthDay(d)}</span>
            </div>
          ))}

          {members.map((m, ci) => {
            const { items, lanes } = layouts[m.id];
            return (
              <div
                key={m.id}
                className="wt-column"
                style={{ gridRow: `2 / ${DAYS + 2}`, gridColumn: ci + 2, gridTemplateColumns: `repeat(${lanes}, minmax(0, 1fr))` }}
              >
                {dates.map((d, ri) => (
                  <div
                    key={d}
                    className={`wt-cell ${d === today ? "today" : ""} ${over === `${m.id}|${d}` ? "over" : ""}`}
                    style={{ gridRow: ri + 1, gridColumn: "1 / -1" }}
                    data-member={m.id}
                    data-date={d}
                    aria-label={`${m.name}, ${dayName(d)} ${monthDay(d)}`}
                    {...cellProps(m.id, d)}
                  />
                ))}
                {items.map((item) => (
                  <ScheduledCard
                    key={item.task.id}
                    item={item}
                    issues={issuesByTask[item.task.id] || []}
                    selected={selectedId === item.task.id}
                    onSelect={onSelectTask}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
