import type { HistoryEntry } from "../../bindings/HistoryEntry";

/**
 * The newest run of each distinct statement that matches. The log keeps every
 * run, but a reader wants the statement, not every time they ran it.
 */
export function recentQueries(entries: readonly HistoryEntry[], search: string): HistoryEntry[] {
  const needle = search.trim().toLowerCase();
  const seen = new Set<string>();
  const found: HistoryEntry[] = [];

  // The log arrives newest first.
  for (const entry of entries) {
    const sql = entry.sql.trim();
    if (seen.has(sql)) continue;
    seen.add(sql);
    if (needle === "" || sql.toLowerCase().includes(needle)) found.push(entry);
  }
  return found;
}

/** A statement written over five lines is one line wide in a list. */
export function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const entry = (id: number, sql: string): HistoryEntry => ({
    id,
    sql,
    ran_at: "2026-09-21T00:00:00.000Z",
    duration_ms: 1,
    row_count: 1,
    error: null,
    source: "reader",
  });

  describe("recentQueries", () => {
    it("keeps the newest run of a statement and drops the repeats", () => {
      const log = [entry(3, "SELECT 1"), entry(2, "SELECT 2"), entry(1, "SELECT 1")];

      expect(recentQueries(log, "").map((found) => found.id)).toEqual([3, 2]);
    });

    it("reads a statement run again with different whitespace as the same one", () => {
      const log = [entry(2, "SELECT 1\n"), entry(1, "SELECT 1")];

      expect(recentQueries(log, "")).toHaveLength(1);
    });

    it("matches the search however it was typed", () => {
      const log = [entry(2, "SELECT * FROM people"), entry(1, "SELECT 1")];

      expect(recentQueries(log, "  PEOPLE ").map((found) => found.id)).toEqual([2]);
    });

    it("counts a repeat as seen even when the search hides it", () => {
      const log = [entry(2, "SELECT 1"), entry(1, "SELECT 1")];

      expect(recentQueries(log, "nothing")).toEqual([]);
    });
  });

  describe("oneLine", () => {
    it("folds a statement onto one line", () => {
      expect(oneLine("SELECT *\n  FROM people\n")).toBe("SELECT * FROM people");
    });
  });
}
