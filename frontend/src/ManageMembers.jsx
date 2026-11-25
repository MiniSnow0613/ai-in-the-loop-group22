import { useEffect, useRef, useState } from "react";

/**
 * Modal dialog to add, rename, and delete board members.
 * Uses native <dialog> with showModal() for focus management, Esc dismissal,
 * and light-dismiss (with pointer fallback for browsers without closedby).
 */
export default function ManageMembers({ members, tasks, onCreate, onRename, onDelete, onClose }) {
  const dialogRef = useRef(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();

    // Fallback light-dismiss when browser lacks HTMLDialogElement.closedBy.
    const supported = "closedBy" in HTMLDialogElement.prototype;
    let pressedOutside = false;
    const isOutside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    const onPointerDown = (e) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e) => {
      if (pressedOutside && isOutside(e)) dialog.close();
    };
    if (!supported) {
      dialog.addEventListener("pointerdown", onPointerDown);
      dialog.addEventListener("pointerup", onPointerUp);
    }
    return () => {
      if (!supported) {
        dialog.removeEventListener("pointerdown", onPointerDown);
        dialog.removeEventListener("pointerup", onPointerUp);
      }
    };
  }, []);

  const taskCountFor = (memberId) => tasks.filter((t) => t.assigneeId === memberId).length;

  const run = async (fn, okText) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (okText) setNotice(okText);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitAdd = async (e) => {
    e.preventDefault();
    const added = name.trim();
    if (!added) {
      setError("Enter a member name.");
      return;
    }
    if (await run(() => onCreate(added), `${added} added.`)) {
      setName("");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="member-modal"
      closedby="any"
      aria-labelledby="manage-members-title"
      onClose={() => onClose()}
    >
      <div className="detail-head">
        <h1 id="manage-members-title">Manage members</h1>
        <button type="button" className="icon-btn" aria-label="Close" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
      </div>
      <p className="muted">
        Click a name to rename it. Deleting a member unassigns their tasks and returns them to the Task Pool.
      </p>

      <div className="member-manage">
        <div className="member-manage-row head">
          <span>Name</span>
          <span>Assigned</span>
          <span />
        </div>
        {members.map((m) => {
          const count = taskCountFor(m.id);
          return (
            <div className="member-manage-row" key={m.id}>
              <input
                key={`${m.id}-${m.name}`}
                className="centered-name-input"
                defaultValue={m.name}
                aria-label={`Member name for ${m.name}`}
                maxLength={80}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    e.currentTarget.value = m.name;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={async (e) => {
                  const input = e.currentTarget;
                  const value = input.value.trim();
                  if (!value) {
                    input.value = m.name;
                    return;
                  }
                  if (value === m.name) return;
                  if (!(await run(() => onRename(m.id, value), "Saved."))) {
                    input.value = m.name;
                  }
                }}
              />
              <span className="muted">
                {count} {count === 1 ? "task" : "tasks"}
              </span>
              <span className="member-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || members.length <= 1}
                  title={members.length <= 1 ? "Keep at least one member." : `Delete ${m.name}`}
                  onClick={() => {
                    const extra =
                      count > 0
                        ? ` ${count} assigned ${count === 1 ? "task" : "tasks"} will be unassigned and moved back to the Task Pool.`
                        : "";
                    if (window.confirm(`Delete ${m.name}?${extra}`)) {
                      run(() => onDelete(m.id), `${m.name} deleted.`);
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          );
        })}
      </div>

      <form className="member-manage-row add" onSubmit={submitAdd}>
        <input
          className="centered-name-input"
          value={name}
          maxLength={80}
          autoFocus
          placeholder="New member name"
          aria-label="New member name"
          onChange={(e) => {
            setName(e.target.value);
            setError("");
          }}
        />
        <span />
        <span className="member-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            Add member
          </button>
        </span>
      </form>

      {notice && <p className="msg info">{notice}</p>}
      {error && (
        <p className="msg-error-inline" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
