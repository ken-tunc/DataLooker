import type { KeyboardEvent, PointerEvent } from "react";
import { type Pane, usePaneSize } from "../lib/paneSize";

type Props = {
  pane: Pane;
  /** Which way the pane grows: `x` for one beside it, `y` for one above it. */
  axis: "x" | "y";
  label: string;
};

const STEP = 16;

/**
 * Dragged or moved with the arrow keys; a double-click restores the starting
 * size, as for a result column. It sits in the gap and takes no room.
 */
export function Splitter({ pane, axis, label }: Props) {
  const [size, setSize] = usePaneSize(pane);

  function drag(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const handle = event.currentTarget;
    const start = axis === "x" ? event.clientX : event.clientY;
    const startSize = size;
    handle.setPointerCapture(event.pointerId);
    // Cancelling the press cancels its focus too, which the arrow keys need.
    // Without `focusVisible: false` WebKit leaves the ring lit after a drag.
    handle.focus({ focusVisible: false });

    const onMove = (move: globalThis.PointerEvent) => {
      setSize(startSize + (axis === "x" ? move.clientX : move.clientY) - start);
    };
    // A drag the system takes over ends without a pointerup.
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
