import { type KeyboardEvent, useRef, useState } from "react";

export type Cell = { row: number; column: number };

/**
 * A rectangle of cells, from the cell the reader started at, which the
 * keys that act on one cell act on, to the corner the range was stretched to.
 */
type Selection = { anchor: Cell; focus: Cell };

export type Bounds = { top: number; bottom: number; left: number; right: number };

function boundsOf({ anchor, focus }: Selection): Bounds {
  return {
    top: Math.min(anchor.row, focus.row),
    bottom: Math.max(anchor.row, focus.row),
    left: Math.min(anchor.column, focus.column),
    right: Math.max(anchor.column, focus.column),
  };
}

export function holds(bounds: Bounds | null, { row, column }: Cell): boolean {
  return (
    bounds !== null &&
    row >= bounds.top &&
    row <= bounds.bottom &&
    column >= bounds.left &&
    column <= bounds.right
  );
}

export function sameCell(a: Cell | null, b: Cell): boolean {
  return a?.row === b.row && a.column === b.column;
}

/** [rows down, columns across] */
const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/**
 * Where an arrow leads from `from`: one cell, or with `toEdge` (⌘) as far as
 * the grid goes. Null past the edge, where the selection stays as it is.
 */
function arrowTarget(
  from: Cell,
  [down, across]: [number, number],
  toEdge: boolean,
  last: Cell,
): Cell | null {
  const toward = (at: number, by: number, end: number) =>
    !toEdge ? at + by : by < 0 ? 0 : by > 0 ? end : at;
  const next = {
    row: toward(from.row, down, last.row),
    column: toward(from.column, across, last.column),
  };
  if (next.row < 0 || next.row > last.row) return null;
  if (next.column < 0 || next.column > last.column) return null;
  return next;
}

export type GridSelection = ReturnType<typeof useGridSelection>;

/**
 * The selected range and every way the reader changes it: a click, a
 * shift-click, a drag, the arrows and ⌘A.
 */
export function useGridSelection(onSelectRow?: (row: number | null) => void) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const dragging = useRef(false);
  const bounds = selection && boundsOf(selection);

  function select(cell: Cell) {
    setSelection({ anchor: cell, focus: cell });
    onSelectRow?.(cell.row);
  }

  function extend(focus: Cell) {
    setSelection((current) => (current ? { ...current, focus } : { anchor: focus, focus }));
  }

  function press(cell: Cell, stretch: boolean) {
    if (stretch && selection) extend(cell);
    else select(cell);
    // Pressed and dragged, the range follows the pointer until it is let go.
    dragging.current = true;
    window.addEventListener("pointerup", () => (dragging.current = false), { once: true });
  }

  function dragOver(cell: Cell) {
    if (dragging.current) extend(cell);
  }

  /** As a spreadsheet does: a menu acts on the range it was opened in. */
  function selectForMenu(cell: Cell) {
    if (!holds(bounds, cell)) select(cell);
  }

  /** Handles an arrow or ⌘A, and says whether it did. */
  function navigate(event: KeyboardEvent, last: Cell): boolean {
    if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
      if (last.row >= 0) {
        setSelection({ anchor: { row: 0, column: 0 }, focus: last });
        onSelectRow?.(0);
      }
      return true;
    }
    const arrow = ARROWS[event.key];
    if (!arrow || !selection) return false;
    // Shift stretches the range from its far corner.
    const from = event.shiftKey ? selection.focus : selection.anchor;
    const next = arrowTarget(from, arrow, event.metaKey, last);
    if (next && event.shiftKey) extend(next);
    else if (next) select(next);
    return true;
  }

  return {
    /** The cell the range started at, which the keys for one cell act on. */
    anchor: selection?.anchor ?? null,
    /** The row the range was last stretched to, which is kept in view. */
    focusRow: selection?.focus.row ?? null,
    bounds,
    press,
    dragOver,
    selectForMenu,
    navigate,
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const last = { row: 9, column: 4 };

  describe("arrowTarget", () => {
    it("moves one cell, and nowhere past the edge", () => {
      expect(arrowTarget({ row: 3, column: 2 }, [1, 0], false, last)).toEqual({
        row: 4,
        column: 2,
      });
      expect(arrowTarget({ row: 0, column: 2 }, [-1, 0], false, last)).toBeNull();
      expect(arrowTarget({ row: 3, column: 4 }, [0, 1], false, last)).toBeNull();
    });

    it("goes to the edge with ⌘, keeping the other axis", () => {
      expect(arrowTarget({ row: 3, column: 2 }, [1, 0], true, last)).toEqual({ row: 9, column: 2 });
      expect(arrowTarget({ row: 3, column: 2 }, [0, -1], true, last)).toEqual({
        row: 3,
        column: 0,
      });
    });
  });

  describe("boundsOf", () => {
    it("is the same rectangle whichever corner the range started at", () => {
      const up = boundsOf({ anchor: { row: 5, column: 3 }, focus: { row: 1, column: 0 } });
      const down = boundsOf({ anchor: { row: 1, column: 0 }, focus: { row: 5, column: 3 } });
      expect(up).toEqual(down);
      expect(holds(up, { row: 3, column: 2 })).toBe(true);
      expect(holds(up, { row: 6, column: 2 })).toBe(false);
    });
  });
}
