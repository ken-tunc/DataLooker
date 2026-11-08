import type { QueryResult } from "../../bindings/QueryResult";

/** What a statement gave back, in a few words. */
export function said(result: QueryResult): string {
  return result.columns.length > 0 ? counted(result.rows.length, "row") : changed(result);
}

export function changed(result: QueryResult): string {
  const affected = result.rows_affected;
  return affected === null || affected === undefined
    ? "Done"
    : `${counted(affected, "row")} affected`;
}

function counted(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const result = (rows: number, columns: number, rows_affected?: number | null) => ({
    columns: Array.from({ length: columns }, (_, at) => ({
      name: `c${at}`,
      type_name: "INT4",
      instant: false,
    })),
    rows: Array.from({ length: rows }, () => []),
    truncated: false,
    elapsed_ms: 1,
    rows_affected,
  });

  describe("said", () => {
    it("counts the rows of a statement that returns them, none included", () => {
      expect(said(result(1, 1))).toBe("1 row");
      expect(said(result(0, 2, 0))).toBe("0 rows");
    });

    it("counts what any other statement changed, if the server said", () => {
      expect(said(result(0, 0, 3))).toBe("3 rows affected");
      expect(said(result(0, 0, null))).toBe("Done");
    });
  });
}
