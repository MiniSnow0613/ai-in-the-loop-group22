import { useEffect, useRef, useState } from "react";
import { acceptSuggestions, fetchAiStatus, requestSuggestions } from "./api.js";
import PrereqPicker from "./PrereqPicker.jsx";
import { starText } from "./workload.js";
import { StarPicker } from "./WorkloadSection.jsx";

const ERROR_TITLES = {
  missing_key: "API key missing",
  invalid_key: "API key rejected",
  rate_limited: "Rate limited",
  bad_format: "Unexpected answer from the model",
  model_unavailable: "Model unavailable",
  timeout: "Timed out",
  network_error: "Network problem",
  offline: "Server unreachable",
  invalid_dependencies: "Not added",
};

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 500;

const DRAG_TYPE = "application/x-suggestion";

/** One cycle among `tasks` as a list of ids (first repeated at the end), or null. */
function findCycle(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, t.prerequisites.filter((p) => tasks.some((x) => x.id === p))]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, "visiting");
    stack.push(id);
    for (const d of deps.get(id)) {
      if (state.get(d) === "visiting") return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) {
        const found = visit(d);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of deps.keys()) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Check the selected tasks. `issues` block adding (the server would reject them);
 * `warnings` don't: a prerequisite from this suggestion that is not selected is
 * simply left out when the tasks are added.
 */
function checkSelection(chosen, tasks, boardIds) {
  const issues = [];
  const warnings = [];
  const chosenIds = new Set(chosen.map((t) => t.id));
  const batch = new Map(tasks.map((t) => [t.id, t]));
  for (const t of chosen) {
    const name = t.title || t.id;
    if (!t.title.trim()) issues.push(`${t.id} needs a title.`);
    for (const p of t.prerequisites) {
      if (chosenIds.has(p) || boardIds.has(p)) continue;
      if (batch.has(p)) {
        warnings.push(`“${name}” will be added without waiting for “${batch.get(p).title || p}” (not selected).`);
      } else {
        issues.push(`Prerequisite "${p}" of “${name}” does not exist. Remove it in Edit.`);
      }
    }
  }
  const cycle = findCycle(chosen);
  if (cycle) {
    const byId = new Map(chosen.map((t) => [t.id, t]));
    issues.push(`Circular dependency: ${cycle.map((id) => `“${byId.get(id).title || id}”`).join(" → ")}.`);
  }
  return { issues, warnings };
}

/** GPU need of a candidate: the AI's estimate (marked) or the person's edit. */
function SuggestionGpu({ task, editing, onChange }) {
  const gpu = task.gpu;
  const set = (changes) =>
    onChange(task.id, {
      gpu: { needed: false, hours: null, reason: "", ...gpu, ...changes, source: "user" },
    });
  if (editing) {
    return (
      <div className="dep-line suggestion-gpu">
        <span className="dep-label">GPU</span>
        <label className="gpu-needed-toggle">
          <input
            type="checkbox"
            checked={Boolean(gpu?.needed)}
            onChange={(e) => set({ needed: e.target.checked, hours: e.target.checked ? gpu?.hours ?? null : null })}
          />
          Needs a GPU
        </label>
        {gpu?.needed && (
          <label className="gpu-needed-toggle">
            <input
              type="number"
              min={0.5}
              max={336}
              step={0.5}
              value={gpu.hours ?? ""}
              placeholder="?"
              aria-label={`GPU hours of ${task.id}`}
              onChange={(e) => set({ hours: e.target.value === "" ? null : Number(e.target.value) })}
            />
            hours in total
          </label>
        )}
      </div>
    );
  }
  if (!gpu) return null;
  const ai = gpu.source === "ai";
  const text = !gpu.needed
    ? "No GPU"
    : gpu.hours == null
      ? "Needs a GPU · time unknown"
      : `Needs a GPU · ${ai ? "~" : ""}${gpu.hours}h`;
  return (
    <div className="dep-line suggestion-gpu">
      <span className="dep-label">GPU</span>
      <span className={`chip ${gpu.needed ? "gpu" : ""}`} title={gpu.reason || undefined}>
        {text}
      </span>
      {ai && <span className="ai-tag">AI estimate</span>}
      {ai && gpu.reason && <span className="muted">{gpu.reason}</span>}
    </div>
  );
}

/** Workload of a candidate: work hours and 1-5 star difficulty, AI estimate (marked) or the person's edit. */
function SuggestionWork({ task, editing, onChange }) {
  const work = task.work;
  const set = (changes) =>
    onChange(task.id, {
      work: { hours: null, difficulty: null, reason: "", ...work, ...changes, source: "user" },
    });
  if (editing) {
    return (
      <div className="dep-line suggestion-work">
        <span className="dep-label">Work</span>
        <label className="gpu-needed-toggle">
          <input
            type="number"
            min={0.5}
            max={1000}
            step={0.5}
            value={work?.hours ?? ""}
            placeholder="?"
            aria-label={`Work hours of ${task.id}`}
            onChange={(e) => set({ hours: e.target.value === "" ? null : Number(e.target.value) })}
          />
          hours
        </label>
        <StarPicker value={work?.difficulty ?? null} onChange={(difficulty) => set({ difficulty })} idPrefix={`star-${task.id}`} />
      </div>
    );
  }
  if (!work) return null;
  const ai = work.source === "ai";
  return (
    <div className={`dep-line suggestion-work ${ai ? "ai" : ""}`}>
      <span className="dep-label">Work</span>
      <span title={work.reason || undefined}>
        {work.hours != null ? `${ai ? "~" : ""}${work.hours}h` : "hours unknown"}
        {work.difficulty && (
          <>
            {" · "}
            <span className="card-stars" aria-label={`difficulty ${work.difficulty} of 5`}>
              {starText(work.difficulty)}
            </span>
          </>
        )}
      </span>
      {ai && <span className="ai-tag">AI estimate</span>}
      {ai && work.reason && <span className="muted">{work.reason}</span>}
    </div>
  );
}

/** One previewed candidate task: select it, see its dependencies, or edit it. */
function SuggestionCard({
  task,
  batch,
  boardTasks,
  selected,
  editing,
  actionable,
  dragging,
  onToggle,
  onEdit,
  onChange,
  onRemove,
  dragProps,
}) {
  const byTempId = new Map(batch.map((t) => [t.id, t]));
  const boardById = new Map(boardTasks.map((t) => [t.id, t]));
  const unlocks = batch.filter((t) => t.prerequisites.includes(task.id));
  const options = [
    ...batch
      .filter((t) => t.id !== task.id)
      .map((t) => ({ id: t.id, kind: "new", label: `${t.id} · ${t.title || "(untitled)"}`, group: "In this suggestion" })),
    ...boardTasks.map((t) => ({ id: t.id, kind: "existing", label: `On board: ${t.title}`, group: "On the board" })),
  ];

  return (
    <li
      className={`suggestion ${selected ? "" : "unselected"} ${dragging ? "dragging" : ""}`}
      data-temp-id={task.id}
      {...(actionable ? dragProps : {})}
    >
      <div className="suggestion-head">
        {actionable && (
          <span
            className="drag-handle"
            draggable
            title="Drag to reorder"
            aria-label={`Drag to reorder ${task.title || task.id}`}
            onDragStart={dragProps.onHandleDragStart}
            onDragEnd={dragProps.onHandleDragEnd}
          >
            ⋮⋮
          </span>
        )}
        <input
          type="checkbox"
          checked={selected}
          disabled={!actionable}
          onChange={() => onToggle(task.id)}
          aria-label={`Include ${task.title || task.id}`}
        />
        <span className="temp-id">{task.id}</span>
        {editing ? (
          <input
            className="suggestion-title-input"
            value={task.title}
            maxLength={MAX_TITLE}
            placeholder="Task title"
            aria-label={`Title of ${task.id}`}
            autoFocus={!task.title}
            onChange={(e) => onChange(task.id, { title: e.target.value })}
          />
        ) : (
          <strong>{task.title || <span className="muted">(untitled)</span>}</strong>
        )}
        {actionable && (
          <button type="button" className="link-btn" onClick={() => onEdit(task.id)}>
            {editing ? "Done" : "Edit"}
          </button>
        )}
        {actionable && (
          <button
            type="button"
            className="icon-btn remove-suggestion"
            aria-label={`Remove ${task.title || task.id} from this suggestion`}
            title="Remove from this suggestion"
            onClick={() => onRemove(task.id)}
          >
            ×
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          className="suggestion-desc-input"
          rows={2}
          value={task.description}
          maxLength={MAX_DESCRIPTION}
          placeholder="Description (optional)"
          aria-label={`Description of ${task.id}`}
          onChange={(e) => onChange(task.id, { description: e.target.value })}
        />
      ) : (
        task.description && <p className="suggestion-desc">{task.description}</p>
      )}
      <div className="dep-line">
        <span className="dep-label">Depends on</span>
        {editing ? (
          <PrereqPicker
            value={task.prerequisites}
            options={options}
            onChange={(prerequisites) => onChange(task.id, { prerequisites })}
          />
        ) : task.prerequisites.length === 0 ? (
          <span className="muted">nothing (can start first)</span>
        ) : (
          task.prerequisites.map((id) => {
            const inBatch = byTempId.get(id);
            const onBoard = boardById.get(id);
            const kind = inBatch ? "new" : onBoard ? "existing" : "unknown";
            return (
              <span key={id} className={`chip ${kind}`} title={kind === "unknown" ? "Not found" : undefined}>
                {kind === "new" && `${id} · ${inBatch.title || "(untitled)"}`}
                {kind === "existing" && `On board: ${onBoard.title}`}
                {kind === "unknown" && `Not found: ${id}`}
              </span>
            );
          })
        )}
      </div>
      {unlocks.length > 0 && (
        <div className="dep-line">
          <span className="dep-label">Unlocks</span>
          {unlocks.map((t) => (
            <span key={t.id} className="chip new">
              {t.id} · {t.title || "(untitled)"}
            </span>
          ))}
        </div>
      )}
      <SuggestionWork task={task} editing={editing} onChange={onChange} />
      <SuggestionGpu task={task} editing={editing} onChange={onChange} />
    </li>
  );
}

function SuggestionMessage({ msg, boardTasks, onAccept, onDiscard, onUpdate }) {
  const { tasks, selected, editing, state, error } = msg.suggestion;
  const actionable = state === "pending" || state === "failed";
  const boardIds = new Set(boardTasks.map((t) => t.id));
  const chosen = tasks.filter((t) => selected.includes(t.id));
  const { issues, warnings } = actionable ? checkSelection(chosen, tasks, boardIds) : { issues: [], warnings: [] };
  const [dragId, setDragId] = useState(null);

  // Selection is free: ticking or unticking one task never changes another.
  const toggle = (id) =>
    onUpdate({ selected: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });

  const change = (id, changes) => onUpdate({ tasks: tasks.map((t) => (t.id === id ? { ...t, ...changes } : t)) });

  // Removing a task also removes it from the other tasks' prerequisites.
  const remove = (id) =>
    onUpdate({
      tasks: tasks
        .filter((t) => t.id !== id)
        .map((t) => ({ ...t, prerequisites: t.prerequisites.filter((p) => p !== id) })),
      selected: selected.filter((x) => x !== id),
      editing: editing.filter((x) => x !== id),
    });

  // Drag a card by its handle; the list reorders live while hovering other cards.
  // The order is the order the tasks get in the Task Pool.
  const dragPropsFor = (id) => ({
    onHandleDragStart: (e) => {
      e.dataTransfer.setData(DRAG_TYPE, id);
      e.dataTransfer.effectAllowed = "move";
      const li = e.currentTarget.closest("li");
      if (li) e.dataTransfer.setDragImage(li, 12, 12);
      setDragId(id);
    },
    onHandleDragEnd: () => setDragId(null),
    onDragOver: (e) => {
      if (!dragId || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragId === id) return;
      const from = tasks.findIndex((t) => t.id === dragId);
      const to = tasks.findIndex((t) => t.id === id);
      const next = [...tasks];
      next.splice(to, 0, next.splice(from, 1)[0]);
      onUpdate({ tasks: next });
    },
    onDrop: (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      setDragId(null);
    },
  });

  const toggleEdit = (id) =>
    onUpdate({ editing: editing.includes(id) ? editing.filter((x) => x !== id) : [...editing, id] });

  const addTask = () => {
    let n = tasks.length + 1;
    while (tasks.some((t) => t.id === `T${n}`) || boardIds.has(`T${n}`)) n += 1;
    const id = `T${n}`;
    onUpdate({
      tasks: [...tasks, { id, title: "", description: "", prerequisites: [], gpu: null, work: null }],
      selected: [...selected, id],
      editing: [...editing, id],
    });
  };

  const allSelected = chosen.length === tasks.length;

  return (
    <div className={`msg suggestion-msg ${state}`}>
      <strong>
        {tasks.length} candidate {tasks.length === 1 ? "task" : "tasks"}
      </strong>
      {msg.suggestion.source && <p className="muted source">From {msg.suggestion.source}</p>}
      <p className="muted">
        Preview only. Nothing is on the board until you add it. Tick the tasks you want, use Edit to
        change one, × to remove it, ⋮⋮ to drag it into another order, or add one the AI missed.
      </p>
      {actionable && tasks.length > 1 && (
        <div className="suggestion-select-all">
          <button
            type="button"
            className="link-btn"
            onClick={() => onUpdate({ selected: allSelected ? [] : tasks.map((t) => t.id) })}
          >
            {allSelected ? "Clear selection" : "Select all"}
          </button>
          <span className="muted">{chosen.length} of {tasks.length} selected</span>
        </div>
      )}
      <ol className="suggestion-list">
        {tasks.map((t) => (
          <SuggestionCard
            key={t.id}
            task={t}
            batch={tasks}
            boardTasks={boardTasks}
            selected={selected.includes(t.id)}
            editing={actionable && editing.includes(t.id)}
            actionable={actionable}
            dragging={dragId === t.id}
            onToggle={toggle}
            onEdit={toggleEdit}
            onChange={change}
            onRemove={remove}
            dragProps={dragPropsFor(t.id)}
          />
        ))}
      </ol>
      {actionable && tasks.length === 0 && <p className="muted">All suggested tasks were removed.</p>}
      {actionable && (
        <button type="button" className="btn add-suggestion" onClick={addTask}>
          + Add a task
        </button>
      )}
      {warnings.length > 0 && (
        <div className="msg-notice" role="note">
          <strong>Heads-up</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {issues.length > 0 && (
        <div className="msg-warning" role="note">
          <strong>Dependency problems</strong>
          <ul>
            {issues.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="msg-error-inline" role="alert">
          {error}
        </p>
      )}
      {(actionable || state === "adding") && (
        <div className="suggestion-actions">
          <button
            type="button"
            className="btn primary"
            disabled={state === "adding" || chosen.length === 0 || issues.length > 0}
            onClick={() => onAccept(msg)}
          >
            {state === "adding"
              ? "Adding…"
              : chosen.length === tasks.length
                ? "Add to Task Pool"
                : `Add ${chosen.length} selected to Task Pool`}
          </button>
          <button type="button" className="btn" disabled={state === "adding"} onClick={() => onDiscard(msg)}>
            Discard
          </button>
        </div>
      )}
      {state === "added" && <p className="status ok">Added to the Task Pool.</p>}
      {state === "discarded" && <p className="muted">Discarded.</p>}
      {state === "superseded" && <p className="muted">Replaced by a newer suggestion.</p>}
    </div>
  );
}

/**
 * AI assistant sidebar. The user describes upcoming work; Flask asks the
 * provider chosen by AI_PROVIDER (OpenRouter or Groq) for candidate tasks. The
 * user can pick, edit and add tasks in the preview; only the selected ones are
 * added to the Task Pool, after the user confirms. Errors stay in this panel so
 * the board keeps working.
 */
export default function ChatPanel({ boardTasks = [], onTasksAdded }) {
  // From /api/ai/status: { configured, providerName, model, keyEnv, configError? },
  // or { fetchError } when the status request itself failed.
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const nextId = useRef(1);
  const logRef = useRef(null);

  useEffect(() => {
    fetchAiStatus()
      .then(setStatus)
      .catch((err) => setStatus({ fetchError: err.message }));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending]);

  const push = (msg) => setMessages((m) => [...m, { id: nextId.current++, ...msg }]);
  const updateSuggestion = (id, changes) =>
    setMessages((m) =>
      m.map((x) => (x.id === id ? { ...x, suggestion: { ...x.suggestion, ...changes } } : x))
    );

  const configured = status?.configured === true;
  const canSend = configured && !sending && input.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    const text = input.trim();
    setInput("");
    push({ role: "user", text });
    setSending(true);
    try {
      const data = await requestSuggestions(text);
      const source = data.provider ? `${data.provider} · ${data.model}` : data.model;
      // No tasks + a reply: the message was not work to plan (a greeting, an
      // unrelated question). The server sends the same fixed introduction every
      // time; show it and leave any open preview as is.
      if (data.tasks.length === 0 && data.reply) {
        push({ role: "reply", text: data.reply });
        return;
      }
      // Only the newest preview stays actionable.
      setMessages((m) =>
        m.map((x) =>
          x.suggestion && ["pending", "failed"].includes(x.suggestion.state)
            ? { ...x, suggestion: { ...x.suggestion, state: "superseded", error: null } }
            : x
        )
      );
      push({
        role: "assistant",
        suggestion: {
          tasks: data.tasks.map(({ id, title, description, prerequisites, gpu, work }) => ({
            id,
            title,
            description: description || "",
            prerequisites,
            gpu: gpu || null,
            work: work || null,
          })),
          selected: data.tasks.map((t) => t.id),
          editing: [],
          source,
          state: "pending",
        },
      });
    } catch (err) {
      push({ role: "error", title: ERROR_TITLES[err.code] || "Could not get suggestions", text: err.message });
    } finally {
      setSending(false);
    }
  };

  const accept = async (msg) => {
    const { tasks, selected } = msg.suggestion;
    updateSuggestion(msg.id, { state: "adding", error: null });
    try {
      // Send the selected tasks as edited, in the previewed order. Prerequisites
      // from this suggestion that were not selected are dropped (shown as a
      // heads-up in the preview). The server validates the rest again.
      const batchIds = new Set(tasks.map((t) => t.id));
      const chosen = tasks
        .filter((t) => selected.includes(t.id))
        .map(({ id, title, description, prerequisites, gpu, work }) => ({
          id,
          title,
          description,
          prerequisites: prerequisites.filter((p) => !batchIds.has(p) || selected.includes(p)),
          ...(gpu ? { gpu } : {}),
          ...(work ? { work } : {}),
        }));
      const data = await acceptSuggestions(chosen);
      updateSuggestion(msg.id, { state: "added", editing: [] });
      push({
        role: "info",
        text: `Added ${data.createdIds.length} ${data.createdIds.length === 1 ? "task" : "tasks"} to the Task Pool. Drag them onto the Timeline to assign owners.`,
      });
      onTasksAdded?.(data.board, data.createdIds);
    } catch (err) {
      updateSuggestion(msg.id, { state: "failed", error: err.message });
    }
  };

  const discard = (msg) => updateSuggestion(msg.id, { state: "discarded", error: null, editing: [] });

  const providerLabel = status?.providerName ? `${status.providerName} · ${status.model}` : null;
  const pill = !status
    ? { kind: "waiting", text: "Checking…" }
    : status.fetchError
      ? { kind: "waiting", text: "Unavailable" }
      : status.configError
        ? { kind: "waiting", text: "Not configured" }
        : configured
          ? { kind: "ok", text: providerLabel }
          : { kind: "waiting", text: `${status.providerName} · no API key` };

  return (
    <aside className="panel chat" aria-label="AI assistant">
      <div className="panel-head">
        <h2>AI Assistant</h2>
        <span className={`status ${pill.kind}`} data-testid="ai-status" title="AI provider and model (set by AI_PROVIDER)">
          <i className="dot" aria-hidden="true" />
          {pill.text}
        </span>
      </div>

      <div className="chat-messages" role="log" aria-live="polite" ref={logRef}>
        <div className="msg system">
          <strong>Plan work with AI</strong>
          <p>
            Describe the work coming up. The assistant suggests candidate tasks with their
            prerequisites. Pick the ones you want, edit them if needed, then add them to the Task Pool
            and drag the cards onto the Timeline.
          </p>
          {providerLabel && (
            <p className="provider-line" data-testid="ai-provider">
              Provider: <b>{status.providerName}</b> · Model: <code>{status.model}</code>
            </p>
          )}
        </div>
        {status?.providerName && !configured && (
          <div className="msg error" role="alert">
            <strong>API key missing</strong>
            <p>
              The assistant is set to use {status.providerName}. Set <code>{status.keyEnv}</code> in
              the PowerShell window that starts Flask, then restart the server. The Timeline and Task
              Pool keep working without it.
            </p>
          </div>
        )}
        {status?.configError && (
          <div className="msg error" role="alert">
            <strong>AI provider not configured</strong>
            <p>{status.configError}</p>
          </div>
        )}
        {status?.fetchError && (
          <div className="msg error" role="alert">
            <strong>Assistant status unavailable</strong>
            <p>{status.fetchError}</p>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === "user") {
            return (
              <div key={msg.id} className="msg user">
                {msg.text}
              </div>
            );
          }
          if (msg.role === "error") {
            return (
              <div key={msg.id} className="msg error" role="alert">
                <strong>{msg.title}</strong>
                <p>{msg.text}</p>
              </div>
            );
          }
          if (msg.role === "reply") {
            return (
              <div key={msg.id} className="msg reply" data-testid="ai-reply">
                {msg.text}
                {msg.source && <p className="muted source">From {msg.source}</p>}
              </div>
            );
          }
          if (msg.role === "info") {
            return (
              <div key={msg.id} className="msg info">
                {msg.text}
              </div>
            );
          }
          return (
            <SuggestionMessage
              key={msg.id}
              msg={msg}
              boardTasks={boardTasks}
              onAccept={accept}
              onDiscard={discard}
              onUpdate={(changes) => updateSuggestion(msg.id, changes)}
            />
          );
        })}
        {sending && (
          <div className="msg system">
            Asking {status?.providerName || "the model"}… this can take a little while.
          </div>
        )}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          rows={3}
          value={input}
          maxLength={2000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            configured
              ? "Describe the upcoming work… (Enter to send, Shift+Enter for a new line)"
              : status?.keyEnv
                ? `Set ${status.keyEnv} to enable the assistant`
                : "The AI assistant is not available"
          }
          disabled={!configured || sending}
          aria-label="Describe the upcoming work"
        />
        <button type="submit" className="btn primary" disabled={!canSend}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </aside>
  );
}
