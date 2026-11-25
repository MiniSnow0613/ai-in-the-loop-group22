import { useCallback, useEffect, useRef, useState } from "react";
import { createTask, deleteTask, fetchBoard, requestGpuEstimate, updateTask } from "./api.js";
import ChatPanel from "./ChatPanel.jsx";
import GpuSchedule from "./GpuSchedule.jsx";
import NewTaskForm from "./NewTaskForm.jsx";
import SplitHandle, { loadPanelSizes, savePanelSizes } from "./SplitHandle.jsx";
import TaskDetail from "./TaskDetail.jsx";
import WeekTimeline from "./WeekTimeline.jsx";
import { addDays, daysBetween, isScheduled, startOfWeek, todayStr } from "./dates.js";
import { cardBand } from "./gpuState.js";
import { shownIssues } from "./scheduleIssues.js";
import { stateKind } from "./taskState.js";

const POOL = "__pool__";
const POLL_MS = 5000;
const ESTIMATE_POLL_MS = 1500;
const HIGHLIGHT_MS = 3000;

// Task Pool groups, in display order. "Completed" only shows when it has cards.
const POOL_GROUPS = [
  { kind: "ready", label: "Ready", alwaysShow: true },
  { kind: "waiting", label: "Waiting for prerequisites", alwaysShow: true },
  { kind: "done", label: "Completed", alwaysShow: false },
];

/** Strip at the bottom of a card: the task's GPU booking (details in the GPU schedule tab). */
function GpuBand({ task }) {
  const band = cardBand(task);
  if (!band) return null;
  return (
    <span className={`gpu-band ${band.kind}`} data-testid="gpu-band">
      {band.text}
    </span>
  );
}

function TaskCard({ task, selectedId, highlightId, onSelect, onDragStart, ownerName }) {
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
      {ownerName !== undefined && (
        <span className="owner-badge">
          {ownerName ? `Owner: ${ownerName}` : "No owner"}
          {task.workHours != null && ` · ${task.workHours}h work`}
        </span>
      )}
      <GpuBand task={task} />
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

function TaskPool({ tasks, allTasks, dragging, cardProps, onDropTask, onCreateTask, memberName }) {
  const { over, handlers } = useDropTarget(POOL, onDropTask);
  const [adding, setAdding] = useState(false);
  return (
    <section
      className={`panel pool-panel ${dragging ? "droppable" : ""} ${over ? "over" : ""}`}
      aria-label="Task Pool"
      data-zone={POOL}
      {...handlers}
    >
      <div className="panel-head">
        <h2>Task Pool</h2>
        <span className="hint">Unscheduled · drag a card onto a member and day above to schedule it</span>
        <span className="head-spacer" />
        {!adding && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            + New task
          </button>
        )}
      </div>
      <div className="pool-body">
        {adding && (
          <NewTaskForm boardTasks={allTasks} onCreate={onCreateTask} onClose={() => setAdding(false)} />
        )}
        {tasks.length === 0 ? (
          <div className="pool-row">
            <p className="empty">Every task is scheduled. Drag a card back here to clear its dates.</p>
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
                      group.map((t) => (
                        <TaskCard key={t.id} task={t} {...cardProps} ownerName={memberName(t.assigneeId) || null} />
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [board, setBoard] = useState(null);
  // `error`: the last action failed (stays until the next successful action or
  // until dismissed). `loadError`: the board could not be fetched; polling
  // clears only this one, so an action's error is not wiped 5 seconds later.
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [dragging, setDragging] = useState(null);
  const [selected, setSelected] = useState(null); // { id, rect }
  const [highlightId, setHighlightId] = useState(null);
  const highlightTimer = useRef(null);
  const [view, setView] = useState("tasks"); // "tasks" | "gpu"
  // What the GPU tab should show when opened from a task: { bookingId } or { bookTaskId }.
  const [gpuFocus, setGpuFocus] = useState(null);
  // Date-based Timeline: the visible week, and warnings from the last saved change.
  const today = todayStr();
  const [week, setWeek] = useState(() => startOfWeek(today));
  // After a save: { kind: "warning", messages } for dependency warnings, else null
  // (same-member overlaps are allowed and not announced).
  const [notice, setNotice] = useState(null);
  const [panelSizes, setPanelSizes] = useState(() => loadPanelSizes());
  const [resizingAxis, setResizingAxis] = useState(null); // "x" | "y" | null
  const layoutRef = useRef(null);
  const workSplitRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
      setLoadError("");
    } catch (err) {
      setLoadError(`Could not load the board: ${err.message}`);
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

  // While the AI is estimating a card's GPU need, check back sooner than the normal poll.
  const estimating = Boolean(board?.tasks.some((t) => t.gpuEstimate?.status === "pending"));
  useEffect(() => {
    if (!estimating) return undefined;
    const timer = setInterval(load, ESTIMATE_POLL_MS);
    return () => clearInterval(timer);
  }, [estimating, load]);

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

  // Same-member overlaps are allowed and not announced; other warnings are.
  const showWarnings = (data) => {
    const warnings = shownIssues(data?.warnings);
    setNotice(warnings.length ? { kind: "warning", messages: warnings.map((w) => w.message) } : null);
  };

  // One schedule change = one request. The card moves at once; if the server
  // rejects the change (e.g. it would start before a prerequisite ends), the
  // board goes back to what it was and the reason is shown.
  const saveSchedule = async (taskId, changes) => {
    const previous = board;
    setBoard((b) => ({ ...b, tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, ...changes } : t)) }));
    try {
      const data = await updateTask(taskId, changes);
      setBoard(data);
      setError("");
      showWarnings(data);
    } catch (err) {
      setBoard(previous);
      setNotice(null);
      setError(err.message);
      load();
    }
  };

  // Dropped on a member/day cell of the Timeline.
  const handleTimelineDrop = (taskId, memberId, date) => {
    setDragging(null);
    const task = board?.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (isScheduled(task) && task.assigneeId === memberId && task.plannedStart === date) return;
    // A new card covers just the dropped day (work hours don't decide the
    // length); a scheduled one moves with its number of days kept.
    const length = isScheduled(task) ? daysBetween(task.plannedStart, task.plannedEnd) : 0;
    saveSchedule(taskId, { assigneeId: memberId, plannedStart: date, plannedEnd: addDays(date, length) });
  };

  // A card's top or bottom edge was dragged on the Timeline (only dates change).
  const handleTimelineResize = (taskId, plannedStart, plannedEnd) =>
    saveSchedule(taskId, { plannedStart, plannedEnd });

  // Dropped on the Task Pool: clear the dates only (owner, prerequisites,
  // status, work hours and GPU information stay).
  const handleDrop = (taskId, zoneId) => {
    setDragging(null);
    if (zoneId !== POOL) return;
    const task = board?.tasks.find((t) => t.id === taskId);
    if (!task || !isScheduled(task)) return;
    saveSchedule(taskId, { plannedStart: null, plannedEnd: null });
  };

  const handleToggleDone = (task) =>
    save(task.id, { status: task.status === "done" ? "todo" : "done" });

  // From the detail popover: close it, bring the related card into view and
  // outline it briefly (works for Timeline and Task Pool cards alike).
  const locateTask = (taskId) => {
    setSelected(null);
    const target = board?.tasks.find((t) => t.id === taskId);
    if (target && isScheduled(target)) {
      const shown = startOfWeek(week);
      if (target.plannedEnd < shown || target.plannedStart > addDays(shown, 6)) setWeek(startOfWeek(target.plannedStart));
    }
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

  const handleSetNeedsGpu = (task, needsGpu) => save(task.id, { needsGpu });

  // Errors are thrown back to the form so it can show them and stay open.
  const handleCreateTask = async (task) => {
    const data = await createTask(task);
    setBoard(data.board);
    setError("");
    locateTask(data.createdId);
  };

  // Errors are thrown back to the caller (edit form, Scheduling section).
  const handleSaveTask = async (taskId, changes) => {
    const data = await updateTask(taskId, changes);
    setBoard(data);
    setError("");
    showWarnings(data);
    return data;
  };

  // Errors go back to the GPU section so it can show them.
  const handleEstimateGpu = async (taskId) => {
    setBoard(await requestGpuEstimate(taskId));
    setError("");
  };

  const handleDeleteTask = async (taskId) => {
    const newBoard = await deleteTask(taskId);
    setSelected(null);
    setBoard(newBoard);
    setError("");
  };

  const openGpu = (focus) => {
    setSelected(null);
    setView("gpu");
    setGpuFocus({ ...focus, nonce: Date.now() });
  };

  const showTaskOnBoard = (taskId) => {
    setView("tasks");
    locateTask(taskId);
  };

  if (!board) {
    return (
      <main className="loading">{loadError ? <p className="error">{loadError}</p> : <p>Loading…</p>}</main>
    );
  }

  const unscheduled = board.tasks.filter((t) => !isScheduled(t));
  const issuesByTask = Object.fromEntries(board.tasks.map((t) => [t.id, t.scheduleIssues || []]));
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

  const clampChatWidth = (w) => {
    const total = layoutRef.current?.clientWidth || window.innerWidth;
    const max = Math.max(260, total - 340);
    return Math.round(Math.min(max, Math.max(260, w)));
  };

  const clampPoolHeight = (h) => {
    const total = workSplitRef.current?.clientHeight || window.innerHeight;
    const max = Math.max(110, total - 190);
    return Math.round(Math.min(max, Math.max(110, h)));
  };

  const commitPanelSizes = (changes) => {
    setPanelSizes((prev) => {
      const next = { ...prev, ...changes };
      savePanelSizes(next);
      return next;
    });
  };

  const currentChatWidth = () => {
    const chatEl = layoutRef.current?.querySelector(".chat");
    return chatEl ? chatEl.getBoundingClientRect().width : panelSizes.chatWidth ?? 320;
  };

  const currentPoolHeight = () => {
    const poolEl = workSplitRef.current?.querySelector(".pool-panel");
    return poolEl ? poolEl.getBoundingClientRect().height : panelSizes.poolHeight ?? 190;
  };

  return (
    <div
      ref={layoutRef}
      className={`layout ${resizingAxis ? `is-resizing-${resizingAxis}` : ""}`}
      style={panelSizes.chatWidth != null ? { "--chat-w": `${panelSizes.chatWidth}px` } : undefined}
    >
      <main className="work">
        <header className="topbar">
          <h1>Experiment Coordination Board</h1>
          <nav className="view-tabs" role="tablist" aria-label="Views">
            {[
              ["tasks", "Tasks"],
              ["gpu", "GPU schedule"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                className={`view-tab ${view === id ? "on" : ""}`}
                onClick={() => {
                  setSelected(null);
                  setView(id);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          {loadError && (
            <p className="error" role="alert">
              {loadError}
            </p>
          )}
          {error && (
            <div className="error schedule-error" role="alert">
              <span>{error}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {notice && !error && (
            <div className={`schedule-notice ${notice.kind}`} role="status">
              <span>Saved with warnings:</span>
              <ul>
                {notice.messages.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
                ×
              </button>
            </div>
          )}
        </header>

        {view === "tasks" ? (
          <div
            ref={workSplitRef}
            className={`work-split ${panelSizes.poolHeight != null ? "has-pool-height" : ""}`}
            style={panelSizes.poolHeight != null ? { "--pool-h": `${panelSizes.poolHeight}px` } : undefined}
          >
            <WeekTimeline
              members={board.members}
              tasks={board.tasks}
              weekStart={week}
              today={today}
              onWeekChange={setWeek}
              onDropTask={handleTimelineDrop}
              onResizeTask={handleTimelineResize}
              onSelectTask={cardProps.onSelect}
              issuesByTask={issuesByTask}
              selectedId={selected?.id}
              highlightId={highlightId}
              gpuInfo={cardBand}
            />
            <SplitHandle
              orientation="horizontal"
              label="Resize Timeline and Task Pool"
              onDragStart={() => {
                setResizingAxis("y");
                const start = currentPoolHeight();
                workSplitRef.current?.classList.add("has-pool-height");
                workSplitRef.current?.style.setProperty("--pool-h", `${Math.round(start)}px`);
                return start;
              }}
              onDragMove={(startH, deltaY) => {
                const next = clampPoolHeight(startH - deltaY);
                workSplitRef.current?.style.setProperty("--pool-h", `${next}px`);
                return next;
              }}
              onDragEnd={(finalH) => {
                setResizingAxis(null);
                commitPanelSizes({ poolHeight: clampPoolHeight(finalH) });
              }}
              onStep={(deltaY) => {
                const next = clampPoolHeight(currentPoolHeight() - deltaY);
                commitPanelSizes({ poolHeight: next });
              }}
              onReset={() => {
                workSplitRef.current?.style.removeProperty("--pool-h");
                commitPanelSizes({ poolHeight: null });
              }}
            />
            <TaskPool
              tasks={unscheduled}
              allTasks={board.tasks}
              dragging={dragging}
              cardProps={cardProps}
              onDropTask={handleDrop}
              onCreateTask={handleCreateTask}
              memberName={memberName}
            />
          </div>
        ) : (
          <GpuSchedule
            board={board}
            focus={gpuFocus}
            onBoard={(newBoard) => {
              setBoard(newBoard);
              setError("");
            }}
            onShowTask={showTaskOnBoard}
          />
        )}
      </main>

      <SplitHandle
        orientation="vertical"
        label="Resize Board and AI Assistant"
        onDragStart={() => {
          setResizingAxis("x");
          const start = currentChatWidth();
          layoutRef.current?.style.setProperty("--chat-w", `${Math.round(start)}px`);
          return start;
        }}
        onDragMove={(startW, deltaX) => {
          const next = clampChatWidth(startW - deltaX);
          layoutRef.current?.style.setProperty("--chat-w", `${next}px`);
          return next;
        }}
        onDragEnd={(finalW) => {
          setResizingAxis(null);
          commitPanelSizes({ chatWidth: clampChatWidth(finalW) });
        }}
        onStep={(deltaX) => {
          const next = clampChatWidth(currentChatWidth() - deltaX);
          commitPanelSizes({ chatWidth: next });
        }}
        onReset={() => {
          layoutRef.current?.style.removeProperty("--chat-w");
          commitPanelSizes({ chatWidth: null });
        }}
      />

      <ChatPanel
        boardTasks={board.tasks}
        onTasksAdded={(newBoard, createdIds) => {
          setBoard(newBoard);
          setError("");
          if (createdIds.length > 0) locateTask(createdIds[0]);
        }}
      />

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          tasksById={tasksById}
          members={board.members}
          assigneeName={memberName(selectedTask.assigneeId)}
          anchor={selected.rect}
          onToggleDone={handleToggleDone}
          onLocate={locateTask}
          onClose={() => setSelected(null)}
          onOpenGpu={openGpu}
          onSetNeedsGpu={handleSetNeedsGpu}
          onSaveTask={handleSaveTask}
          onDeleteTask={handleDeleteTask}
          onEstimateGpu={handleEstimateGpu}
        />
      )}
    </div>
  );
}
