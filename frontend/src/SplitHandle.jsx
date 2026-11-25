import { useRef, useState } from "react";

const PANEL_SIZES_STORAGE = "group22_panel_sizes";
const KEY_STEP_PX = 24;

export function loadPanelSizes() {
  try {
    const raw = window.localStorage.getItem(PANEL_SIZES_STORAGE);
    if (!raw) return { chatWidth: null, poolHeight: null };
    const parsed = JSON.parse(raw);
    return {
      chatWidth: typeof parsed?.chatWidth === "number" && parsed.chatWidth > 0 ? parsed.chatWidth : null,
      poolHeight: typeof parsed?.poolHeight === "number" && parsed.poolHeight > 0 ? parsed.poolHeight : null,
    };
  } catch {
    return { chatWidth: null, poolHeight: null };
  }
}

export function savePanelSizes({ chatWidth, poolHeight }) {
  try {
    if (chatWidth == null && poolHeight == null) {
      window.localStorage.removeItem(PANEL_SIZES_STORAGE);
    } else {
      window.localStorage.setItem(PANEL_SIZES_STORAGE, JSON.stringify({ chatWidth, poolHeight }));
    }
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Draggable, keyboard-accessible divider between two panels.
 *
 * `orientation="vertical"` separates left/right panels (drag horizontally).
 * `orientation="horizontal"` separates top/bottom panels (drag vertically).
 */
export default function SplitHandle({
  orientation = "vertical",
  label,
  onDragStart,
  onDragMove,
  onDragEnd,
  onStep,
  onReset,
}) {
  const [active, setActive] = useState(false);
  const dragRef = useRef(null);

  const handlePointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startPos = orientation === "vertical" ? e.clientX : e.clientY;
    const startVal = onDragStart?.() ?? 0;
    dragRef.current = { pointerId: e.pointerId, startPos, startVal, currentVal: startVal };
    setActive(true);
  };

  const handlePointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const pos = orientation === "vertical" ? e.clientX : e.clientY;
    const delta = pos - drag.startPos;
    const next = onDragMove?.(drag.startVal, delta);
    if (typeof next === "number") drag.currentVal = next;
  };

  const finishDrag = (e) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setActive(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onDragEnd?.(drag.currentVal);
  };

  const handleKeyDown = (e) => {
    if (orientation === "vertical") {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onStep?.(-KEY_STEP_PX);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onStep?.(KEY_STEP_PX);
      }
    } else {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onStep?.(-KEY_STEP_PX);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onStep?.(KEY_STEP_PX);
      }
    }
    if (e.key === "Home") {
      e.preventDefault();
      onReset?.();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className={`split-handle ${orientation} ${active ? "active" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    >
      <span className="split-grip" aria-hidden="true" />
    </div>
  );
}
