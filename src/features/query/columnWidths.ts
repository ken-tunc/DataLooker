import { type PointerEvent, useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import { formatCell } from "./cell";

/** A character of the 14px monospace the cells are set in. */
const CHAR_PX = 8.5;
const PADDING_PX = 24;
const MIN_PX = 96;
const MAX_PX = 480;
/** Rows past this one do not change the width enough to be worth measuring. */
const SAMPLE_ROWS = 100;

export type ColumnHeader = { name: string; typeName: string };

/**
 * Virtualized rows get no table layout from the browser, so widths come up
 * front from the widest cell in the first rows and the header.
 */
export function columnWidths(headers: ColumnHeader[], rows: readonly unknown[][]): number[] {
  return headers.map((header, index) => {
    let longest = header.name.length + 1 + header.typeName.length;
    for (const row of rows.slice(0, SAMPLE_ROWS)) {
      const cell = row[index];
      if (cell !== undefined) longest = Math.max(longest, formatCell(cell).length);
    }
    const width = Math.round(longest * CHAR_PX + PADDING_PX);
    return Math.min(Math.max(width, MIN_PX), MAX_PX);
  });
}

/**
 * Wider bounds than the guess's: a reader who drags a column narrow or wide
 * means it.
 */
export function clampColumnWidth(px: number): number {
  return Math.min(Math.max(Math.round(px), 40), 1200);
}

/** Widths the reader dragged, and the columns they were dragged for. */
type Dragged = { columns: string; widths: Record<number, number> };

/**
 * Each column's width: measured from the rows, unless the reader dragged it.
 * `rows` are the cells as the grid shows them.
 */
export function useColumnWidths(columns: QueryResult["columns"], rows: readonly unknown[][]) {
  const [dragged, setDragged] = useState<Dragged>({ columns: "", widths: {} });
  const names = columns.map((column) => column.name).join("\u0000");
  // Widths dragged for other columns mean nothing here.
  const overrides = dragged.columns === names ? dragged.widths : {};
  const widths = columnWidths(
    columns.map((column) => ({ name: column.name, typeName: column.type_name })),
    rows,
  ).map((width, index) => overrides[index] ?? width);

  /** Follows the pointer from a column's resize handle until it is let go. */
  function startResize(event: PointerEvent<HTMLElement>, index: number) {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = widths[index] as number;
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: globalThis.PointerEvent) => {
      const width = clampColumnWidth(startWidth + move.clientX - startX);
      setDragged((current) => ({
        columns: names,
        widths: { ...(current.columns === names ? current.widths : {}), [index]: width },
      }));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  function reset(index: number) {
    setDragged((current) => {
      const { [index]: _dropped, ...rest } = current.columns === names ? current.widths : {};
      return { columns: names, widths: rest };
    });
  }

  return { widths, startResize, reset };
}

function header(name: string, typeName = ""): ColumnHeader {
  return { name, typeName };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("columnWidths", () => {
    it("never goes below the minimum or above the maximum", () => {
      const [narrow, wide] = columnWidths([header("id"), header("essay")], [[1, "x".repeat(500)]]);
      expect(narrow).toBe(96);
      expect(wide).toBe(480);
    });

    it("widens a column to fit its longest cell", () => {
      const [short, long] = columnWidths(
        [header("a"), header("b")],
        [
          ["x", "a value long enough to matter"],
          ["y", "short"],
        ],
      );
      expect(long).toBeGreaterThan(short as number);
    });

    it("fits the column name and the type name beside it", () => {
      const [withType] = columnWidths([header("created", "TIMESTAMPTZ")], [["x"]]);
      const [withoutType] = columnWidths([header("created")], [["x"]]);
      expect(withType).toBeGreaterThan(withoutType as number);
    });

    it("keeps a dragged width inside its own, wider bounds", () => {
      expect(clampColumnWidth(10)).toBe(40);
      expect(clampColumnWidth(5000)).toBe(1200);
      expect(clampColumnWidth(60.4)).toBe(60);
    });

    it("measures a NULL as what it renders, not as nothing", () => {
      expect(columnWidths([header("a")], [[null]])).toEqual(
        columnWidths([header("a")], [["NULL"]]),
      );
    });
  });
}
