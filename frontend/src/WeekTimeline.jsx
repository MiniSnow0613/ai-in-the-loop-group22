import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  dayName,
  formatPlanned,
  monthDay,
  parseDateStr,
  startOfWeek,
} from "./dates.js";
import { cardIssueLevel, ISSUE_LABEL, issueKind, shownIssues } from "./scheduleIssues.js";
import { layoutMember } from "./timelineLayout.js";
import "./WeekTimeline.css";

/*
 * Date-based Timeline: members as columns, the 7 days of one week as rows.
 * A task appears when it has an assignee and planned dates (plannedStart /
 * plannedEnd, "YYYY-MM-DD", inclusive) that touch the visible week. Tasks
 * without dates belong in the Task Pool, which is not part of this component.
 *
 * Interactions (the component only reports intent; the caller saves and the
 * backend validates, see backend/schedule.py):
 * - drag a card body or a Task Pool card onto a cell -> onDropTask(taskId, memberId, date)
 * - drag a card's top / bottom edge -> live preview snapped to whole days, then
 *   onResizeTask(taskId, start, end) once on release (Escape cancels)
 */

const DAYS = 7;
const COLUMN_MIN_PX = 160; // one lane
const LANE_MIN_PX = 88; // per lane of the widest overlap group; the Timeline scrolls sideways instead
export const DRAG_TYPE = "text/plain"; // same as the Task Pool cards

function weekLabel(start) {
  const end = addDays(start, DAYS - 1);
  return `${monthDay(start)} – ${monthDay(end)}, ${parseDateStr(end).getFullYear()}`;
}

function cardKind(task) {
  if (task.status === "done") return "done";
  return task.blocked ? "waiting" : "ready";
}

/** One short line for cards that only have one day of height. */
function shortStatus(task) {
  if (task.status === "done") return "Completed";
  if (task.blocked) return `Waiting on ${task.pendingCount || 1}`;
  return "Ready";
}

/** Everything a card may not have room for, for the tooltip. */
function tooltipText(task, range, issues, gpu) {
  const lines = [task.title, range];
  if (task.stateText) lines.push(task.stateText);
  if (task.workHours != null) lines.push(`Estimated work: ${task.workHours}h`);
  if (gpu) lines.push(gpu.text);
  for (const i of shownIssues(issues)) lines.push(`${ISSUE_LABEL[issueKind(i)]}: ${i.message}`);
  lines.push("Drag to move · drag the top or bottom edge to change the dates");
  return lines.join("\n");
}

function ScheduledCard({ item, issues, gpu, selected, highlighted, resizing, canResize, onSelect, onResizeStart, guards }) {
  const { task } = item;
  const kind = cardKind(task);
  const level = cardIssueLevel(issues);
  const range = formatPlanned(task.plannedStart, task.plannedEnd);
  // One visible day has room for a title and one status line only.
  const compact = item.rowEnd - item.rowStart < 2;
  const issueCount = shownIssues(issues).length;

  return (
    <button
      type="button"
      className={[
        "wt-card",
        kind,
        compact ? "compact" : "full",
        level ? `has-${level}` : "",
        selected ? "selected" : "",
        highlighted ? "highlight" : "",
        resizing ? "resizing" : "",
      ].join(" ")}
      style={{ gridRow: `${item.rowStart} / ${item.rowEnd}`, gridColumn: `${item.colStart} / span ${item.colSpan}` }}
      draggable={!resizing}
      data-task-id={task.id}
      aria-haspopup="dialog"
      title={tooltipText(task, range, issues, gpu)}
      aria-label={`${task.title}, ${range}, ${task.stateText || shortStatus(task)}${issueCount ? `, ${issueCount} schedule issue(s)` : ""}`}
      onDragStart={(e) => {
        if (guards.resizePressed.current) {
          e.preventDefault(); // the edge handles resize instead of moving
          return;
        }
        e.dataTransfer.setData(DRAG_TYPE, task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => {
        if (guards.suppressClick.current) {
          guards.suppressClick.current = false; // the click that ends a resize
          return;
        }
        onSelect?.(task.id, e.currentTarget.getBoundingClientRect());
      }}
    >
      {canResize.start && (
        <span
          className="wt-handle start"
          aria-hidden="true"
          title="Drag to change the planned start date"
          onPointerDown={(e) => onResizeStart(e, task, "start")}
        />
      )}
      {!compact && item.continuesBefore && <span className="wt-continues">↑ from {monthDay(task.plannedStart)}</span>}
      <span className="wt-card-title">{task.title}</span>

      {resizing ? (
        <span className="wt-resize-label">{range}</span>
      ) : compact ? (
        <span className={`wt-compact-line status ${kind}`}>
          <i className="dot" aria-hidden="true" />
          {item.continuesBefore && <span aria-hidden="true">↑</span>}
          <span className="wt-compact-text">{shortStatus(task)}</span>
          {level && (
            <span className={`wt-mark ${level}`} aria-hidden="true">
              {level === "error" ? "!" : "⚠"}
            </span>
          )}
          {gpu && <span className={`wt-gpu-chip ${gpu.kind}`}>GPU</span>}
          {item.continuesAfter && <span aria-hidden="true">↓</span>}
        </span>
      ) : (
        <>
          <span className="wt-card-meta">
            {range}
            {task.workHours != null && ` · ${task.workHours}h work`}
          </span>
          {task.stateText && (
            <span className={`status ${kind} wt-state`}>
              <i className="dot" aria-hidden="true" />
              <span className="wt-state-text">{task.stateText}</span>
            </span>
          )}
          {level && (
            <span className={`wt-issue ${level}`}>
              {level === "error" ? "Schedule conflict" : "Warning"}
              {issueCount > 1 && ` (${issueCount})`}
            </span>
          )}
          {gpu && <span className={`wt-gpu-line gpu-band ${gpu.kind}`}>{gpu.text}</span>}
          {item.continuesAfter && <span className="wt-continues">↓ until {monthDay(task.plannedEnd)}</span>}
        </>
      )}
      {canResize.end && (
        <span
          className="wt-handle end"
          aria-hidden="true"
          title="Drag to change the planned end date"
          onPointerDown={(e) => onResizeStart(e, task, "end")}
        />
      )}
    </button>
  );
}

function MemberHeader({ member, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(member.name);
  const cancelledRef = useRef(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!onRename) return member.name;

  const commit = async () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const next = draft.trim();
    setEditing(false);
    if (!next || next === member.name) return;
    await onRename(member.id, next);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="wt-member-input"
        value={draft}
        maxLength={80}
        aria-label={`Rename ${member.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            cancelledRef.current = true;
            setDraft(member.name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="wt-member-btn"
      title="Click to rename"
      onClick={() => {
        cancelledRef.current = false;
        setDraft(member.name);
        setEditing(true);
      }}
    >
      {member.name}
    </button>
  );
}

/**
 * Props
 *   members         [{ id, name }]
 *   tasks           [{ id, title, status, blocked, pendingCount, stateText, assigneeId, plannedStart, plannedEnd, workHours }]
 *   weekStart       "YYYY-MM-DD" (any day; shown from that week's Monday)
 *   today           "YYYY-MM-DD", highlighted when visible
 *   onWeekChange    (newWeekStart) => void
 *   onDropTask      (taskId, memberId, date) => void
 *   onResizeTask    (taskId, plannedStart, plannedEnd) => void, once per resize
 *   onSelectTask    (taskId, cardRect) => void
 *   onRenameMember  (memberId, name) => Promise<void>
 *   onManageMembers () => void
 *   issuesByTask    { taskId: [{ severity, code, message }] }
 *   selectedId      task id to outline
 *   highlightId     task id to flash (e.g. "show this card")
 *   gpuInfo         (task) => { kind, text } | null, the task's GPU strip
 */
export default function WeekTimeline({
  members,
  tasks,
  weekStart,
  today,
  onWeekChange,
  onDropTask,
  onResizeTask,
  onSelectTask,
  onRenameMember,
  onManageMembers,
  issuesByTask = {},
  selectedId = null,
  highlightId = null,
  gpuInfo,
}) {
  const start = startOfWeek(weekStart);
  const weekEnd = addDays(start, DAYS - 1);
  const dates = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(start, i)), [start]);
  const [over, setOver] = useState(null); // "memberId|date" under the pointer
  const [dragging, setDragging] = useState(false);
  // Edge resize in progress: { taskId, edge, origStart, origEnd, start, end }.
  const [resize, setResize] = useState(null);
  const guards = { resizePressed: useRef(false), suppressClick: useRef(false) };
  const cleanupRef = useRef(null);

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
  useEffect(() => () => cleanupRef.current?.(), []);

  // While resizing, lay out the task with its preview dates.
  const shown = useMemo(
    () =>
      resize
        ? tasks.map((t) => (t.id === resize.taskId ? { ...t, plannedStart: resize.start, plannedEnd: resize.end } : t))
        : tasks,
    [tasks, resize]
  );
  const layouts = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, layoutMember(shown.filter((t) => t.assigneeId === m.id), start)])),
    [members, shown, start]
  );

  /** Start dragging the top ("start") or bottom ("end") edge of a card. */
  const startResize = (e, task, edge) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const column = e.currentTarget.closest(".wt-column");
    if (!column) return;
    guards.resizePressed.current = true;
    const orig = { start: task.plannedStart, end: task.plannedEnd };
    let current = { ...orig };
    setResize({ taskId: task.id, edge, ...orig });

    const dateAt = (clientY) => {
      const rect = column.getBoundingClientRect();
      const index = Math.floor((clientY - rect.top) / (rect.height / DAYS)); // may leave the week
      return addDays(start, index);
    };
    const move = (ev) => {
      const date = dateAt(ev.clientY);
      current =
        edge === "start"
          ? { start: date > orig.end ? orig.end : date, end: orig.end }
          : { start: orig.start, end: date < orig.start ? orig.start : date };
      setResize((r) => (r && (r.start !== current.start || r.end !== current.end) ? { ...r, ...current } : r));
    };
    const finish = (commit) => {
      cleanup();
      guards.resizePressed.current = false;
      guards.suppressClick.current = true;
      setTimeout(() => (guards.suppressClick.current = false), 0);
      setResize(null);
      if (commit && (current.start !== orig.start || current.end !== orig.end)) {
        onResizeTask?.(task.id, current.start, current.end);
      }
    };
    const up = () => finish(true);
    const key = (ev) => ev.key === "Escape" && finish(false);
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      cleanupRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    cleanupRef.current = cleanup;
  };

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

  const original = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  return (
    <section
      className={`wt panel ${dragging ? "is-dragging" : ""} ${resize ? "is-resizing" : ""}`}
      aria-label="Timeline"
    >
      <div className="wt-head">
        <h2>Timeline</h2>
        <span className="hint">
          Drop a card on a member and day to schedule it; drag a card's top or bottom edge to change its dates. Changes are
          checked against prerequisites before saving.
        </span>
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
        <div
          className="wt-grid"
          style={{
            gridTemplateColumns: `var(--wt-axis-w) ${members
              .map((m) => `minmax(${Math.max(COLUMN_MIN_PX, layouts[m.id].maxLanes * LANE_MIN_PX)}px, 1fr)`)
              .join(" ")}`,
          }}
        >
          <div className="wt-corner" style={{ gridRow: 1, gridColumn: 1 }} />
          {members.map((m, ci) => (
            <div key={m.id} className="wt-member" style={{ gridRow: 1, gridColumn: ci + 2 }}>
              <MemberHeader member={m} onRename={onRenameMember} />
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
            const { items, slots } = layouts[m.id];
            return (
              <div
                key={m.id}
                className="wt-column"
                style={{ gridRow: `2 / ${DAYS + 2}`, gridColumn: ci + 2, gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}
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
                {items.map((item) => {
                  // An edge can be dragged only when the real edge is in this week.
                  const real = original.get(item.task.id) || item.task;
                  const isResizing = resize?.taskId === item.task.id;
                  return (
                    <ScheduledCard
                      key={item.task.id}
                      item={item}
                      issues={issuesByTask[item.task.id] || []}
                      gpu={gpuInfo?.(item.task) || null}
                      selected={selectedId === item.task.id}
                      highlighted={highlightId === item.task.id}
                      resizing={isResizing}
                      canResize={{
                        start: Boolean(onResizeTask) && (isResizing ? resize.edge === "start" : real.plannedStart >= start),
                        end: Boolean(onResizeTask) && (isResizing ? resize.edge === "end" : real.plannedEnd <= weekEnd),
                      }}
                      onSelect={onSelectTask}
                      onResizeStart={startResize}
                      guards={guards}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {onManageMembers && (
        <button
          type="button"
          className="wt-member-fab"
          aria-label="Manage members"
          title="Add or manage members"
          onClick={onManageMembers}
        >
          +
        </button>
      )}
    </section>
  );
}
