import { formatCell } from "./cell";

const CHAR_PX = 7.2;
const PADDING_PX = 24;
const MIN_PX = 80;
const MAX_PX = 420;
/** Rows past this one do not change the width enough to be worth measuring. */
const SAMPLE_ROWS = 100;

/**
 * Virtualized rows cannot be laid out by the browser's table algorithm, so the
 * columns need widths up front. They come from the widest cell in the first
 * rows, which is what the reader sees first anyway.
 */
export function columnWidths(headers: string[], rows: readonly unknown[][]): number[] {
  return headers.map((header, index) => {
    let longest = header.length;
    for (const row of rows.slice(0, SAMPLE_ROWS)) {
      const cell = row[index];
      if (cell !== undefined) longest = Math.max(longest, formatCell(cell).length);
    }
    const width = Math.round(longest * CHAR_PX + PADDING_PX);
    return Math.min(Math.max(width, MIN_PX), MAX_PX);
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("columnWidths", () => {
    it("never goes below the minimum or above the maximum", () => {
      const [narrow, wide] = columnWidths(["id", "essay"], [[1, "x".repeat(500)]]);
      expect(narrow).toBe(80);
      expect(wide).toBe(420);
    });

    it("widens a column to fit its longest cell", () => {
      const [short, long] = columnWidths(
        ["a", "b"],
        [
          ["x", "a value long enough to matter"],
          ["y", "short"],
        ],
      );
      expect(long).toBeGreaterThan(short as number);
    });

    it("measures the header when it is wider than the values", () => {
      const [onlyHeader] = columnWidths(["a_rather_long_column_name"], [["x"]]);
      const [onlyShort] = columnWidths(["a"], [["x"]]);
      expect(onlyHeader).toBeGreaterThan(onlyShort as number);
    });

    it("measures a NULL as what it renders, not as nothing", () => {
      expect(columnWidths(["a"], [[null]])).toEqual(columnWidths(["a"], [["NULL"]]));
    });
  });
}
