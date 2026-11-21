import { useEffect, useRef, useState } from "react";
import { acceptSuggestions, fetchAiStatus, requestSuggestions } from "./api.js";

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

/** One previewed candidate task, with what it depends on and what it unlocks. */
function SuggestionCard({ task, byTempId }) {
  return (
    <li className="suggestion" data-temp-id={task.id}>
      <div className="suggestion-head">
        <span className="temp-id">{task.id}</span>
        <strong>{task.title}</strong>
      </div>
      {task.description && <p className="suggestion-desc">{task.description}</p>}
      <div className="dep-line">
        <span className="dep-label">Depends on</span>
        {task.prerequisiteRefs.length === 0 ? (
          <span className="muted">nothing (can start first)</span>
        ) : (
          task.prerequisiteRefs.map((ref) => (
            <span key={ref.id} className={`chip ${ref.kind}`} title={ref.kind === "unknown" ? "Not found" : undefined}>
              {ref.kind === "new" && `${ref.id} · ${ref.title}`}
              {ref.kind === "existing" && `On board: ${ref.title}`}
              {ref.kind === "unknown" && `Not found: ${ref.id}`}
            </span>
          ))
        )}
      </div>
      {task.unlocks.length > 0 && (
        <div className="dep-line">
          <span className="dep-label">Unlocks</span>
          {task.unlocks.map((id) => (
            <span key={id} className="chip new">
              {id} · {byTempId.get(id)?.title}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function SuggestionMessage({ msg, onAccept, onDiscard }) {
  const { tasks, issues, state, error } = msg.suggestion;
  const byTempId = new Map(tasks.map((t) => [t.id, t]));
  const actionable = state === "pending" || state === "failed" || state === "adding";
  return (
    <div className={`msg suggestion-msg ${state}`}>
      <strong>
        {tasks.length} candidate {tasks.length === 1 ? "task" : "tasks"}
      </strong>
      {msg.suggestion.source && <p className="muted source">From {msg.suggestion.source}</p>}
      <p className="muted">Preview only. Nothing is on the board until you add it.</p>
      <ol className="suggestion-list">
        {tasks.map((t) => (
          <SuggestionCard key={t.id} task={t} byTempId={byTempId} />
        ))}
      </ol>
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
      {actionable && (
        <div className="suggestion-actions">
          <button
            type="button"
            className="btn primary"
            disabled={state === "adding"}
            onClick={() => onAccept(msg)}
          >
            {state === "adding" ? "Adding…" : "Add to Task Pool"}
          </button>
          <button type="button" className="btn" disabled={state === "adding"} onClick={() => onDiscard(msg)}>
            Discard
          </button>
        </div>
      )}
      {state === "added" && <p className="status ready">Added to the Task Pool.</p>}
      {state === "discarded" && <p className="muted">Discarded.</p>}
      {state === "superseded" && <p className="muted">Replaced by a newer suggestion.</p>}
    </div>
  );
}

/**
 * AI assistant sidebar. The user describes upcoming work; Flask asks the
 * provider chosen by AI_PROVIDER (OpenRouter or Groq) for candidate tasks; the preview is added to the Task Pool only after the
 * user confirms. Errors stay in this panel so the board keeps working.
 */
export default function ChatPanel({ onTasksAdded }) {
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
  }, [messages, sending]);

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
          tasks: data.tasks,
          issues: data.issues,
          source: data.provider ? `${data.provider} · ${data.model}` : data.model,
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
    updateSuggestion(msg.id, { state: "adding", error: null });
    try {
      // Send back exactly what was previewed; the server validates it again.
      const tasks = msg.suggestion.tasks.map(({ id, title, description, prerequisites }) => ({
        id,
        title,
        description,
        prerequisites,
      }));
      const data = await acceptSuggestions(tasks);
      updateSuggestion(msg.id, { state: "added" });
      push({
        role: "info",
        text: `Added ${data.createdIds.length} ${data.createdIds.length === 1 ? "task" : "tasks"} to the Task Pool. Drag them onto the Timeline to assign owners.`,
      });
      onTasksAdded?.(data.board, data.createdIds);
    } catch (err) {
      updateSuggestion(msg.id, { state: "failed", error: err.message });
    }
  };

  const discard = (msg) => updateSuggestion(msg.id, { state: "discarded", error: null });

  const providerLabel = status?.providerName ? `${status.providerName} · ${status.model}` : null;
  const pill = !status
    ? { kind: "waiting", text: "Checking…" }
    : status.fetchError
      ? { kind: "waiting", text: "Unavailable" }
      : status.configError
        ? { kind: "waiting", text: "Not configured" }
        : configured
          ? { kind: "ready", text: providerLabel }
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
            prerequisites. Review the preview, then add it to the Task Pool and drag the cards onto
            the Timeline.
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
          if (msg.role === "info") {
            return (
              <div key={msg.id} className="msg info">
                {msg.text}
              </div>
            );
          }
          return <SuggestionMessage key={msg.id} msg={msg} onAccept={accept} onDiscard={discard} />;
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
