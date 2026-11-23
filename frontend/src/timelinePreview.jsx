/*
 * Dev-only preview of WeekTimeline with mock data (no backend).
 *   cd frontend; npm run dev   ->  http://localhost:5173/timeline-preview.html
 * `npm run build` only builds index.html, so this page never ships.
 *
 * Drop rules, same as App.jsx (the server checks them in backend/schedule.py):
 * - a new card covers just the dropped day; a moved card keeps its number of days;
 *   work hours never decide the length;
 * - dropping on the Task Pool clears only the dates (assignee and prerequisites stay).
 * Schedule warnings are static examples from the mock, not recomputed.
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import WeekTimeline, { DRAG_TYPE } from "./WeekTimeline.jsx";
import { addDays, daysBetween } from "./dates.js";
import { makeMockBoard } from "./weekTimelineMock.js";
import "./styles.css";

function spanDays(task) {
  return task.plannedStart && task.plannedEnd ? daysBetween(task.plannedStart, task.plannedEnd) + 1 : 1;
}

function Pool({ tasks, members, onClear }) {
  const [over, setOver] = useState(false);
  const name = (id) => members.find((m) => m.id === id)?.name;
  return (
    <section
      className={`panel preview-pool ${over ? "over" : ""}`}
      aria-label="Task Pool (unscheduled)"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) onClear(id);
      }}
    >
      <h2>Task Pool · unscheduled</h2>
      <div className="preview-pool-cards">
        {tasks.length === 0 && <p className="muted">Drop a card here to clear its dates.</p>}
        {tasks.map((t) => (
          <button
            key={t.id}
            type="button"
            className="card ready"
            draggable
            data-task-id={t.id}
            onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, t.id)}
          >
            <span className="card-title">{t.title}</span>
            <span className="status">
              {name(t.assigneeId) ? `Owner: ${name(t.assigneeId)}` : "No owner"}
              {t.workHours != null ? ` · ${t.workHours}h work` : " · hours unknown"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Preview() {
  const [board, setBoard] = useState(() => makeMockBoard());
  const [week, setWeek] = useState(board.today);
  const [selectedId, setSelectedId] = useState(null);
  const [log, setLog] = useState("Drag a card onto a member and day, or back to the Task Pool.");

  const update = (id, changes, message) => {
    setBoard((b) => ({ ...b, tasks: b.tasks.map((t) => (t.id === id ? { ...t, ...changes } : t)) }));
    setLog(message);
  };
  const find = (id) => board.tasks.find((t) => t.id === id);
  const memberName = (id) => board.members.find((m) => m.id === id)?.name;

  const handleDrop = (taskId, memberId, date) => {
    const task = find(taskId);
    if (!task) return;
    const end = addDays(date, spanDays(task) - 1);
    update(taskId, { assigneeId: memberId, plannedStart: date, plannedEnd: end },
      `onDropTask("${taskId}", "${memberId}", "${date}") → ${memberName(memberId)}, ${date} to ${end}`);
  };

  const handleClear = (taskId) => {
    if (!find(taskId)?.plannedStart) return;
    update(taskId, { plannedStart: null, plannedEnd: null }, `“${find(taskId).title}” moved to the Task Pool: dates cleared, owner kept.`);
  };

  const selected = selectedId && find(selectedId);
  const unscheduled = board.tasks.filter((t) => !t.plannedStart);

  return (
    <div className="preview-layout">
      <p className="preview-banner">
        WeekTimeline preview · mock data, nothing is saved · warnings are static examples
      </p>
      <WeekTimeline
        members={board.members}
        tasks={board.tasks}
        weekStart={week}
        today={board.today}
        onWeekChange={setWeek}
        onDropTask={handleDrop}
        onSelectTask={setSelectedId}
        issuesByTask={board.issuesByTask}
        selectedId={selectedId}
      />
      <Pool tasks={unscheduled} members={board.members} onClear={handleClear} />
      <p className="preview-log" aria-live="polite" data-testid="preview-log">
        {selected
          ? `Selected: ${selected.title} · ${memberName(selected.assigneeId) || "no owner"} · ${selected.plannedStart || "no dates"}${selected.plannedEnd ? ` to ${selected.plannedEnd}` : ""}`
          : log}
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>
);
