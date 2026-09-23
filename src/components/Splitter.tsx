import type { KeyboardEvent, PointerEvent } from "react";
import { type Pane, usePaneSize } from "../lib/paneSize";

type Props = {
  pane: Pane;
  /** Which way the pane grows: `x` for one beside it, `y` for one above it. */
  axis: "x" | "y";
  label: string;
};

/** How far an arrow key moves the line. */
const STEP = 16;

/**
 * The line between a pane and what follows it, dragged to resize the pane —
 * or moved with the arrow keys once it has focus. A double-click puts the
 * pane back to its starting size, as it does for a result column.
 *
 * It sits in the gap between the two rather than taking room of its own.
 */
export function Splitter({ pane, axis, label }: Props) {
  const [size, setSize] = usePaneSize(pane);

  function drag(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const handle = event.currentTarget;
    const start = axis === "x" ? event.clientX : event.clientY;
    const startSize = size;
    handle.setPointerCapture(event.pointerId);
    // Cancelling the press also cancels the focus it would have given, and
    // focus is what the arrow keys need. WebKit would ring a line focused this
    // way, which then stays lit after the drag, so the ring is left to the
    // keyboard.
    handle.focus({ focusVisible: false });

    const onMove = (move: globalThis.PointerEvent) => {
      setSize(startSize + (axis === "x" ? move.clientX : move.clientY) - start);
    };
    // A drag the system takes over ends without a pointerup, and its move
    // handler would otherwise answer the next drag's moves as well.
    const ends = ["pointerup", "pointercancel", "lostpointercapture"] as const;
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      for (const end of ends) handle.removeEventListener(end, onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    for (const end of ends) handle.addEventListener(end, onEnd);
  }

  function step(event: KeyboardEvent<HTMLDivElement>) {
    const grow = axis === "x" ? "ArrowRight" : "ArrowDown";
    const shrink = axis === "x" ? "ArrowLeft" : "ArrowUp";
    if (event.key !== grow && event.key !== shrink) return;
    event.preventDefault();
    setSize(size + (event.key === grow ? STEP : -STEP));
  }

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={size}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      className={`hover:bg-primary/40 focus-visible:bg-primary/40 z-10 shrink-0 transition-colors outline-none ${
        axis === "x" ? "-mx-1 w-2 cursor-col-resize" : "-my-2 h-2 cursor-row-resize"
      }`}
      onPointerDown={drag}
      onDoubleClick={() => setSize(null)}
      onKeyDown={step}
    />
  );
}
