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
 * Virtualized rows cannot be laid out by the browser's table algorithm, so the
 * columns need widths up front. They come from the widest cell in the first
 * rows, which is what the reader sees first anyway. The header carries the type
 * name after the column name, and both have to fit.
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

    it("measures a NULL as what it renders, not as nothing", () => {
      expect(columnWidths([header("a")], [[null]])).toEqual(
        columnWidths([header("a")], [["NULL"]]),
      );
    });
  });
}
