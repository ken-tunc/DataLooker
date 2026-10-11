import { useEffect, useRef } from "react";
import type { CellPeekState } from "./peek";

/**
 * A cell's whole value, for one the grid cuts short. A popover rather than a
 * `title`, so that a document keeps its lines and the text can be selected.
 * It sits in the top layer, above the grid's clipping and the panes' stacking.
 */
export function CellPeek({
  peek,
  anchor,
  text,
}: {
  peek: CellPeekState;
  /** Where the shown cell sits on the screen. */
  anchor: DOMRect;
  text: string;
}) {
  const { close } = peek;
  const popover = useRef<HTMLDivElement>(null);

  // Placed once its size is known: below the cell if it fits, else above,
  // and moved left rather than past the window's edge.
  useEffect(() => {
    const node = popover.current;
    if (!node) return;
    if (!node.matches(":popover-open")) node.showPopover();
    const margin = 8;
    const box = node.getBoundingClientRect();
    const below = anchor.bottom + box.height + margin <= window.innerHeight;
    node.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin))}px`;
    node.style.top = `${below ? anchor.bottom : Math.max(margin, anchor.top - box.height)}px`;
  }, [anchor, text]);

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [close]);

  return (
    <div
      ref={popover}
      id={peek.id}
      popover="manual"
      role="tooltip"
      className="hairline bg-base-200 m-0 max-h-[60vh] max-w-[min(40rem,calc(100vw-1rem))] overflow-auto rounded-box border p-3 shadow-lg"
      style={{ inset: "auto", left: anchor.left, top: anchor.bottom }}
      onPointerEnter={peek.stay}
      onPointerLeave={peek.leave}
    >
      <pre className="font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>
    </div>
  );
}
