/**
 * Edit a list of prerequisite ids: chips with a remove button, plus a select to
 * add another one. `options` are [{ id, label, kind: "new" | "existing", group }].
 * Ids in `value` that are not in `options` show as "Not found" so they can be removed.
 */
export default function PrereqPicker({ value, options, onChange, disabled = false }) {
  const byId = new Map(options.map((o) => [o.id, o]));
  const remaining = options.filter((o) => !value.includes(o.id));
  const groups = [...new Set(remaining.map((o) => o.group))];

  return (
    <div className="prereq-picker">
      {value.length === 0 && <span className="muted">nothing (can start first)</span>}
      {value.map((id) => {
        const opt = byId.get(id);
        return (
          <span key={id} className={`chip ${opt ? opt.kind : "unknown"}`}>
            {opt ? opt.label : `Not found: ${id}`}
            {!disabled && (
              <button
                type="button"
                className="chip-x"
                aria-label={`Remove prerequisite ${opt ? opt.label : id}`}
                onClick={() => onChange(value.filter((x) => x !== id))}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
      {!disabled && remaining.length > 0 && (
        <select
          className="prereq-add"
          value=""
          aria-label="Add a prerequisite"
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
        >
          <option value="">+ Add prerequisite…</option>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {remaining
                .filter((o) => o.group === g)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      )}
    </div>
  );
}
