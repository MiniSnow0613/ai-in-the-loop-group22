/**
 * Chatbot sidebar. UI only for now: the AI assistant is not connected yet, so
 * input and send are disabled. Later, candidate tasks it proposes will appear
 * in the Task Pool for the user to drag onto the Timeline.
 */
export default function ChatPanel() {
  return (
    <aside className="panel chat" aria-label="AI assistant">
      <div className="panel-head">
        <h2>AI Assistant</h2>
        <span className="status waiting">
          <i className="dot" aria-hidden="true" />
          Not enabled
        </span>
      </div>

      <div className="chat-messages" role="log">
        <div className="msg system">
          <strong>The AI assistant is not enabled yet</strong>
          <p>
            Later, you will describe your upcoming work here. Candidate tasks from the AI will
            appear in the Task Pool at the bottom left, ready for you to drag onto the Timeline.
          </p>
          <p>For now, drag the tasks in the Task Pool directly.</p>
        </div>
      </div>

      <form className="chat-input" onSubmit={(e) => e.preventDefault()}>
        <textarea
          rows={3}
          placeholder="The AI assistant is not enabled yet"
          disabled
          aria-label="Message"
        />
        <button type="submit" className="btn primary" disabled>
          Send
        </button>
      </form>
    </aside>
  );
}
