import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBoard, updateTask } from "./api.js";
import ChatPanel from "./ChatPanel.jsx";
import TaskDetail from "./TaskDetail.jsx";
import { stateKind } from "./taskState.js";

const POOL = "__pool__";
const POLL_MS = 5000;
const MIN_ROWS = 4;
const HIGHLIGHT_MS = 3000;

// Task Pool groups, in display order. "Completed" only shows when it has cards.
const POOL_GROUPS = [
  { kind: "ready", label: "Ready", alwaysShow: true },
  { kind: "waiting", label: "Waiting for prerequisites", alwaysShow: true },
  { kind: "done", label: "Completed", alwaysShow: false },
];

function TaskCard({ task, selectedId, highlightId, onSelect, onDragStart }) {
  const kind = stateKind(task);
  const selected = selectedId === task.id;
  const highlighted = highlightId === task.id;
  return (
    <button
      type="button"
      className={`card ${kind} ${selected ? "selected" : ""} ${highlighted ? "highlight" : ""}`}
      draggable
      data-task-id={task.id}
      aria-haspopup="dialog"
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(task.id);
      }}
      onClick={(e) => onSelect(task.id, e.currentTarget.getBoundingClientRect())}
    >
      <span className="card-title">
        {task.title}
        {task.isExample && <span className="badge">Example</span>}
      </span>
      <span className={`status ${kind}`} data-testid="task-state">
        <i className="dot" aria-hidden="true" />
        {task.stateText}
      </span>
    </button>
  );
}

/** Shared drag-over handling for any drop target (member column or pool). */
function useDropTarget(zoneId, onDropTask) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOver(false);
      },
      onDrop: (e) => {
        e.preventDefault();
        setOver(false);
        const taskId = e.dataTransfer.getData("text/plain");
        if (taskId) onDropTask(taskId, zoneId);
      },
    },
  };
}

function Timeline({ members, allTasks, tasksFor, dragging, cardProps, onDropTask }) {
  // Rows are shared by all members and come from the server (task.row): a task
  // sits one row after its latest prerequisite. Rows are computed over every
  // task, including unassigned ones, so empty cells are kept, cards never move
  // up to fill a gap, and one spare row stays at the bottom.
  const lastRow = Math.max(0, ...allTasks.map((t) => t.row));
  const rows = Math.max(MIN_ROWS, lastRow + 1);
  const [overMember, setOverMember] = useState(null);

  // Every cell of a member's column (including the filler under the last row)
  // drops onto that member; the whole column highlights together.
  const cellDrop = (memberId) => ({
    "data-member": memberId,
    onDragOver: (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (overMember !== memberId) setOverMember(memberId);
    },
    onDragLeave: (e) => {
      if (e.relatedTarget?.closest?.("[data-member]")?.dataset.member !== memberId) {
        setOverMember((m) => (m === memberId ? null : m));
      }
    },
    onDrop: (e) => {
      e.preventDefault();
      setOverMember(null);
      const taskId = e.dataTransfer.getData("text/plain");
      if (taskId) onDropTask(taskId, memberId);
    },
  });
  const zoneClass = (memberId) =>
    `${dragging ? "droppable" : ""} ${overMember === memberId ? "over" : ""}`;

  return (
    <section className="panel timeline-panel" aria-label="Timeline">
      <div className="panel-head">
        <h2>Timeline</h2>
        <span className="hint">
          Dependency level: each card sits one level below its latest prerequisite. A card can start
          once its own prerequisites are completed, without waiting for other cards on earlier levels.
        </span>
      </div>
      <div className="timeline-scroll">
        <div
          className="timeline-grid"
          style={{
            gridTemplateColumns: `var(--axis-w) repeat(${members.length}, minmax(var(--col-min), 1fr))`,
            gridTemplateRows: `auto repeat(${rows}, minmax(var(--row-h), auto)) 1fr`,
          }}
        >
          <div className="axis-head" style={{ gridRow: 1, gridColumn: 1 }}>
            Dependency level
          </div>
          {members.map((m, ci) => (
            <div className="member-head" key={m.id} style={{ gridRow: 1, gridColumn: ci + 2 }}>
              {m.name}
            </div>
          ))}

          {Array.from({ length: rows }, (_, ri) => (
            <div
              className="axis-cell"
              key={`axis-${ri}`}
              data-row={ri + 1}
              style={{ gridRow: ri + 2, gridColumn: 1 }}
            >
              {ri + 1}
            </div>
          ))}
          <div className="axis-fill" style={{ gridRow: rows + 2, gridColumn: 1 }} />

          {members.map((m, ci) => {
            const memberTasks = tasksFor(m.id);
            return [
              ...Array.from({ length: rows }, (_, ri) => (
                <div
                  key={`${m.id}-${ri}`}
                  className={`cell ${zoneClass(m.id)}`}
                  data-zone={m.id}
                  data-row={ri + 1}
                  style={{ gridRow: ri + 2, gridColumn: ci + 2 }}
                  {...cellDrop(m.id)}
                >
                  {memberTasks
                    .filter((t) => t.row === ri + 1)
                    .map((t) => (
                      <TaskCard key={t.id} task={t} {...cardProps} />
                    ))}
                </div>
              )),
              <div
                key={`${m.id}-fill`}
                className={`cell fill ${zoneClass(m.id)}`}
                data-zone={m.id}
                style={{ gridRow: rows + 2, gridColumn: ci + 2 }}
                {...cellDrop(m.id)}
              >
                {dragging && <span className="drop-hint">Assign to {m.name}</span>}
              </div>,
            ];
          })}
        </div>
      </div>
    </section>
  );
}

function TaskPool({ tasks, dragging, cardProps, onDropTask }) {
  const { over, handlers } = useDropTarget(POOL, onDropTask);
  return (
    <section
      className={`panel pool-panel ${dragging ? "droppable" : ""} ${over ? "over" : ""}`}
      aria-label="Task Pool"
      data-zone={POOL}
      {...handlers}
    >
      <div className="panel-head">
        <h2>Task Pool</h2>
        <span className="hint">Unassigned · drag a card to a member column above to assign it</span>
      </div>
      {tasks.length === 0 ? (
        <div className="pool-row">
          <p className="empty">All tasks are assigned. Drag a card back here to unassign it.</p>
        </div>
      ) : (
        <div className="pool-row">
          {POOL_GROUPS.map(({ kind, label, alwaysShow }) => {
            const group = tasks.filter((t) => stateKind(t) === kind);
            if (group.length === 0 && !alwaysShow) return null;
            return (
              <div className="pool-group" key={kind} data-pool-group={kind}>
                <h3 className={`status ${kind}`}>
                  <i className="dot" aria-hidden="true" />
                  {label}
                  <span className="count">{group.length}</span>
                </h3>
                <div className="pool-cards">
                  {group.length === 0 ? (
                    <p className="empty">None</p>
                  ) : (
                    group.map((t) => <TaskCard key={t.id} task={t} {...cardProps} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(null);
  const [selected, setSelected] = useState(null); // { id, rect }
  const [highlightId, setHighlightId] = useState(null);
  const highlightTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
      setError("");
    } catch (err) {
      setError(`Could not load the board: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    load();
    // Light polling so another browser's changes show up even without a refresh.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The dragged card may re-mount in its new column, so clear drag state globally.
  useEffect(() => {
    const clear = () => setDragging(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  const save = async (taskId, changes) => {
    try {
      setBoard(await updateTask(taskId, changes));
      setError("");
    } catch (err) {
      setError(err.message);
      load();
    }
  };

  const handleDrop = (taskId, zoneId) => {
    setDragging(null);
    const assigneeId = zoneId === POOL ? null : zoneId;
    const current = board?.tasks.find((t) => t.id === taskId);
    if (!current || current.assigneeId === assigneeId) return;
    // Optimistic move; the server response replaces it.
    setBoard((b) => ({
      ...b,
      tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, assigneeId } : t)),
    }));
    save(taskId, { assigneeId });
  };

  const handleToggleDone = (task) =>
    save(task.id, { status: task.status === "done" ? "todo" : "done" });

  // From the detail popover: close it, bring the related card into view and
  // outline it briefly (works for Timeline and Task Pool cards alike).
  const locateTask = (taskId) => {
    setSelected(null);
    setHighlightId(taskId);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-task-id="${CSS.escape(taskId)}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    });
  };
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  if (!board) {
    return (
      <main className="loading">{error ? <p className="error">{error}</p> : <p>Loading…</p>}</main>
    );
  }

  const tasksFor = (assigneeId) => board.tasks.filter((t) => t.assigneeId === assigneeId);
  const tasksById = new Map(board.tasks.map((t) => [t.id, t]));
  const selectedTask = selected && tasksById.get(selected.id);
  const memberName = (id) => board.members.find((m) => m.id === id)?.name;

  const cardProps = {
    onDragStart: (id) => {
      setSelected(null);
      setDragging(id);
    },
    onSelect: (id, rect) => setSelected((s) => (s?.id === id ? null : { id, rect })),
    selectedId: selected?.id,
    highlightId,
  };

  return (
    <div className="layout">
      <main className="work">
        <header className="topbar">
          <h1>Experiment Coordination Board</h1>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </header>

        <Timeline
          members={board.members}
          allTasks={board.tasks}
          tasksFor={tasksFor}
          dragging={dragging}
          cardProps={cardProps}
          onDropTask={handleDrop}
        />
        <TaskPool
          tasks={tasksFor(null)}
          dragging={dragging}
          cardProps={cardProps}
          onDropTask={handleDrop}
        />
      </main>

      <ChatPanel />

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          tasksById={tasksById}
          assigneeName={memberName(selectedTask.assigneeId)}
          anchor={selected.rect}
          onToggleDone={handleToggleDone}
          onLocate={locateTask}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
