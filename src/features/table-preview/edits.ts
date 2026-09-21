import type { RowUpdate } from "../../bindings/RowUpdate";

/** A row the reader has changed but not saved, and what it takes to save it. */
export type PendingRow = {
  key: Record<string, string | null>;
  /** The row's version when it was read, which is what a save is checked against. */
  version: string;
  set: Record<string, string | null>;
};

/** Pending rows by their key, so that a second edit to a row joins the first. */
export type PendingEdits = Record<string, PendingRow>;

/**
 * Names a row by its primary key. The parts are encoded rather than joined,
 * because a key value is free to contain whatever a separator would be.
 */
export function rowKeyOf(key: Record<string, string | null>): string {
  return JSON.stringify(
    Object.keys(key)
      .sort()
      .map((column) => [column, key[column]]),
  );
}

export function withEdit(
  edits: PendingEdits,
  row: PendingRow,
  column: string,
  value: string | null,
): PendingEdits {
  const id = rowKeyOf(row.key);
  const existing = edits[id];
  return {
    ...edits,
    [id]: {
      ...row,
      // The version is the one the row was read with the first time it was
      // edited: a page that has since been refetched must not quietly carry an
      // edit onto a row someone else has rewritten.
      version: existing?.version ?? row.version,
      set: { ...existing?.set, [column]: value },
    },
  };
}

export function editCount(edits: PendingEdits): number {
  return Object.values(edits).reduce((cells, row) => cells + Object.keys(row.set).length, 0);
}

export function updatesOf(edits: PendingEdits): RowUpdate[] {
  return Object.values(edits).map((row) => ({
    key: row.key,
    set: row.set,
    version: row.version,
  }));
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const row = (id: string, version = "100"): PendingRow => ({
    key: { id },
    version,
    set: {},
  });

  describe("withEdit", () => {
    it("keeps both changes to one row together", () => {
      const first = withEdit({}, row("1"), "name", "Ada");
      const second = withEdit(first, row("1"), "note", null);

      expect(Object.keys(second)).toHaveLength(1);
      expect(updatesOf(second)).toEqual([
        { key: { id: "1" }, set: { name: "Ada", note: null }, version: "100" },
      ]);
    });

    it("keeps the version the row was first edited at", () => {
      const first = withEdit({}, row("1", "100"), "name", "Ada");
      const refetched = withEdit(first, row("1", "200"), "name", "Grace");

      expect(updatesOf(refetched)[0]?.version).toBe("100");
    });

    it("keeps rows apart", () => {
      const edits = withEdit(withEdit({}, row("1"), "name", "a"), row("2"), "name", "b");
      expect(editCount(edits)).toBe(2);
    });

    it("counts a column changed twice once", () => {
      const edits = withEdit(withEdit({}, row("1"), "name", "a"), row("1"), "name", "b");
      expect(editCount(edits)).toBe(1);
      expect(updatesOf(edits)[0]?.set).toEqual({ name: "b" });
    });
  });

  describe("rowKeyOf", () => {
    it("does not care what order the key columns arrive in", () => {
      expect(rowKeyOf({ a: "1", b: "2" })).toBe(rowKeyOf({ b: "2", a: "1" }));
    });

    it("tells apart keys a separator would have run together", () => {
      expect(rowKeyOf({ a: "1:2" })).not.toBe(rowKeyOf({ a: "1", b: "2" }));
    });
  });
}
