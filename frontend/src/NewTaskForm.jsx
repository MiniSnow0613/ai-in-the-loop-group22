import { useState } from "react";
import PrereqPicker from "./PrereqPicker.jsx";

/** Add a task by hand. It goes to the Task Pool; prerequisites are board tasks. */
export default function NewTaskForm({ boardTasks, onCreate, onClose }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [prerequisites, setPrerequisites] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const options = boardTasks.map((t) => ({
    id: t.id,
    kind: "existing",
    label: t.title,
    group: t.status === "done" ? "Completed" : "Not completed",
  }));

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onCreate({ title, description, prerequisites });
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="new-task-form" onSubmit={submit} aria-label="New task">
      <label htmlFor="new-task-title">Title</label>
      <input
        id="new-task-title"
        value={title}
        maxLength={120}
        placeholder="e.g. Clean the raw dataset"
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      <label htmlFor="new-task-desc">Description</label>
      <textarea
        id="new-task-desc"
        rows={2}
        value={description}
        maxLength={500}
        placeholder="Optional"
        onChange={(e) => setDescription(e.target.value)}
      />
      <span className="form-label">Depends on</span>
      <PrereqPicker value={prerequisites} options={options} onChange={setPrerequisites} />
      {error && (
        <p className="msg-error-inline form-wide" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions form-wide">
        <button type="submit" className="btn primary" disabled={!title.trim() || saving}>
          {saving ? "Adding…" : "Add to Task Pool"}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
