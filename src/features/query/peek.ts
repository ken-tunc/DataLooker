import { useId, useRef, useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import type { Cell } from "./selection";

/** Long enough that sweeping the pointer across the grid opens nothing. */
export const PEEK_DELAY_MS = 400;
/** Long enough to cross the gap from a cell to its full view. */
const PEEK_GRACE_MS = 150;

/**
 * The cell shown in full and its place on the screen. The text is read from
 * the cell at each render, so an edit shows in the view; the result it was
 * opened on retires it when the rows are replaced.
 */
type Peek = { cell: Cell; anchor: DOMRect; result: QueryResult };

export type CellPeekState = ReturnType<typeof useCellPeek>;

/** Which cell of `result` is shown in full, if any. */
export function useCellPeek(result: QueryResult) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const closing = useRef<number | undefined>(undefined);
  const id = useId();
  const shown = peek?.result === result ? peek : null;

  function open(cell: Cell, anchor: DOMRect) {
    window.clearTimeout(closing.current);
    setPeek({ cell, anchor, result });
  }

  /** Delayed, so that the pointer can move from the cell onto the full view. */
  function leave() {
    window.clearTimeout(closing.current);
    closing.current = window.setTimeout(() => setPeek(null), PEEK_GRACE_MS);
  }

  /** The pointer reached the full view before it closed. */
  function stay() {
    window.clearTimeout(closing.current);
  }

  function close() {
    window.clearTimeout(closing.current);
    setPeek(null);
  }

  return { id, shown, open, leave, stay, close };
}
