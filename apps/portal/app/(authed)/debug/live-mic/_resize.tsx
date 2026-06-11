'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

/**
 * Column-resize support for the live-mic debug layout: the utterances (left)
 * and outputs (right) columns are user-resizable via drag handles; the trace
 * column takes the remainder. Widths persist per-handle in localStorage.
 */

export function clampWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** A persisted, clamped column width + a pointer-drag starter for its handle.
 *  `direction` is which way the column grows when the pointer moves right:
 *  +1 for a column whose handle sits on its RIGHT edge (left column),
 *  -1 for a column whose handle sits on its LEFT edge (right column). */
export function useStoredColumnWidth(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
  direction: 1 | -1,
): { width: number; dragging: boolean; onPointerDown: (e: React.PointerEvent) => void } {
  const [width, setWidth] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  // Restore the persisted width after mount (SSR-safe).
  useEffect(() => {
    const raw = window.localStorage.getItem(storageKey);
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n)) setWidth(clampWidth(n, min, max));
    }
  }, [storageKey, min, max]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startW: width };
      setDragging(true);

      const onMove = (ev: PointerEvent): void => {
        if (drag.current === null) return;
        const dx = ev.clientX - drag.current.startX;
        setWidth(clampWidth(drag.current.startW + direction * dx, min, max));
      };
      const onUp = (): void => {
        drag.current = null;
        setDragging(false);
        // Persist via the state setter to read the final value.
        setWidth((w) => {
          window.localStorage.setItem(storageKey, String(w));
          return w;
        });
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [width, min, max, direction, storageKey],
  );

  return { width, dragging, onPointerDown };
}

/** The visible drag handle: a slim hit area with a hairline that highlights on
 *  hover/drag. Sits as its own grid column between panels. */
export function ColResizeHandle({
  onPointerDown,
  dragging,
  label,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  dragging: boolean;
  label: string;
}): ReactElement {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      className="group flex w-2 flex-none cursor-col-resize items-stretch justify-center"
    >
      <div
        className={`w-px rounded transition-colors ${dragging ? 'bg-accent' : 'bg-border group-hover:bg-accent/60'}`}
      />
    </div>
  );
}
