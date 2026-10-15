/**
 * The handle a board column is resized by.
 *
 * It writes nothing until the drag ends: a column's width lives in the
 * database (`shared/board.ts`'s `Board.widths`), and a verb a database write
 * per pixel of drag would be, so the drag itself moves `--col-w` on the
 * column's own element directly — no React state, no re-render — and only
 * `onResize` is told, once, on pointerup. A drag that never moved is a click
 * and commits nothing.
 */
import { useRef } from "react";
import { clampLaneWidth } from "../../../shared/board";

export function ColumnResizeHandle({ onResize, onReset }: { onResize: (width: number) => void; onReset: () => void }) {
  const start = useRef<{ x: number; width: number; moved: boolean } | null>(null);

  const column = (event: React.PointerEvent | React.MouseEvent) => event.currentTarget.closest<HTMLElement>(".board-col");

  return (
    <div
      className="board-col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      title="Drag to resize — double-click to reset"
      onPointerDown={(event) => {
        const col = column(event);
        if (!col) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: col.getBoundingClientRect().width, moved: false };
      }}
      onPointerMove={(event) => {
        const drag = start.current;
        const col = column(event);
        if (!drag || !col || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const delta = event.clientX - drag.x;
        if (delta !== 0) drag.moved = true;
        col.style.setProperty("--col-w", `${clampLaneWidth(drag.width + delta)}px`);
      }}
      onPointerUp={(event) => {
        const drag = start.current;
        start.current = null;
        if (!drag?.moved) return;
        const col = column(event);
        const next = col ? Number.parseFloat(col.style.getPropertyValue("--col-w")) : NaN;
        if (Number.isFinite(next)) onResize(next);
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        column(event)?.style.removeProperty("--col-w");
        onReset();
      }}
    />
  );
}
