import type { TableEdits } from "../../bindings/TableEdits";

/** A row the reader changed but has not saved, and what it takes to save it. */
export type PendingRow = {
  key: Record<string, string | null>;
  /** The row's version when it was read, which is what a save is checked against. */
  version: string;
  set: Record<string, string | null>;
};

/** A row the reader is adding. A column it leaves out takes the table's default. */
export type DraftRow = { id: string; values: Record<string, string | null> };

export type PendingEdits = {
  updates: Record<string, PendingRow>;
  deletes: Record<string, { key: Record<string, string | null>; version: string }>;
  inserts: DraftRow[];
};

export const NO_EDITS: PendingEdits = { updates: {}, deletes: {}, inserts: [] };

/** Encoded rather than joined: a key value may contain any separator. */
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
  const existing = edits.updates[id];
  return {
    ...edits,
    updates: {
      ...edits.updates,
      [id]: {
        ...row,
        // The version from the first edit, so a refetch cannot carry the edit
        // onto a row someone else has rewritten.
        version: existing?.version ?? row.version,
        set: { ...existing?.set, [column]: value },
      },
    },
  };
}

/** Marking a row again unmarks it. */
export function withDeleted(
  edits: PendingEdits,
  key: Record<string, string | null>,
  version: string,
): PendingEdits {
  const id = rowKeyOf(key);
  const { [id]: marked, ...rest } = edits.deletes;
  return { ...edits, deletes: marked ? rest : { ...edits.deletes, [id]: { key, version } } };
}

export function isDeleted(edits: PendingEdits, key: Record<string, string | null>): boolean {
  return edits.deletes[rowKeyOf(key)] !== undefined;
}

export function withNewRow(edits: PendingEdits, id: string): PendingEdits {
  return { ...edits, inserts: [...edits.inserts, { id, values: {} }] };
}

export function withNewValue(
  edits: PendingEdits,
  id: string,
  column: string,
  value: string | null,
): PendingEdits {
  return {
    ...edits,
    inserts: edits.inserts.map((row) =>
      row.id === id ? { ...row, values: { ...row.values, [column]: value } } : row,
    ),
  };
}

export function withoutNewRow(edits: PendingEdits, id: string): PendingEdits {
  return { ...edits, inserts: edits.inserts.filter((row) => row.id !== id) };
}

/**
 * The delete runs first, so an update to the same row would match nothing and
 * refuse the whole save.
 */
function liveUpdates(edits: PendingEdits): PendingRow[] {
  return Object.entries(edits.updates)
    .filter(([id]) => edits.deletes[id] === undefined)
    .map(([, row]) => row);
}

/** What the reader would lose by discarding: rows added or removed, cells changed. */
export function editCount(edits: PendingEdits): number {
  const cells = liveUpdates(edits).reduce((total, row) => total + Object.keys(row.set).length, 0);
  return cells + Object.keys(edits.deletes).length + edits.inserts.length;
}

export function tableEdits(
  connectionId: string,
  schema: string,
  table: string,
  edits: PendingEdits,
): TableEdits {
  return {
    connection_id: connectionId,
    schema,
    table,
    inserts: edits.inserts.map((row) => ({ values: row.values })),
    updates: liveUpdates(edits).map((row) => ({
      key: row.key,
      set: row.set,
      version: row.version,
    })),
    deletes: Object.values(edits.deletes),
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const row = (id: string, version = "100"): PendingRow => ({ key: { id }, version, set: {} });
  const saved = (edits: PendingEdits) => tableEdits("c1", "shop", "people", edits);

  describe("withEdit", () => {
    it("keeps both changes to one row together", () => {
      const first = withEdit(NO_EDITS, row("1"), "name", "Ada");
      const second = withEdit(first, row("1"), "note", null);

      expect(saved(second).updates).toEqual([
        { key: { id: "1" }, set: { name: "Ada", note: null }, version: "100" },
      ]);
    });

    it("keeps the version the row was first edited at", () => {
      const first = withEdit(NO_EDITS, row("1", "100"), "name", "Ada");
      const refetched = withEdit(first, row("1", "200"), "name", "Grace");

      expect(saved(refetched).updates[0]?.version).toBe("100");
    });

    it("counts a column changed twice once", () => {
      const edits = withEdit(withEdit(NO_EDITS, row("1"), "name", "a"), row("1"), "name", "b");
      expect(editCount(edits)).toBe(1);
    });
  });

  describe("withDeleted", () => {
    it("drops an edit to a row that is being removed", () => {
      const edited = withEdit(NO_EDITS, row("1"), "name", "Ada");
      const removed = withDeleted(edited, { id: "1" }, "100");

      expect(saved(removed).updates).toEqual([]);
      expect(editCount(removed)).toBe(1);
      // Unmarking the row brings the edit back — it was never thrown away.
      expect(saved(withDeleted(removed, { id: "1" }, "100")).updates).toHaveLength(1);
    });

    it("marks a row and unmarks it again", () => {
      const marked = withDeleted(NO_EDITS, { id: "1" }, "100");
      expect(isDeleted(marked, { id: "1" })).toBe(true);
      expect(saved(marked).deletes).toEqual([{ key: { id: "1" }, version: "100" }]);

      const unmarked = withDeleted(marked, { id: "1" }, "100");
      expect(isDeleted(unmarked, { id: "1" })).toBe(false);
      expect(editCount(unmarked)).toBe(0);
    });
  });

  describe("new rows", () => {
    it("carries only the columns the reader filled in", () => {
      const started = withNewRow(NO_EDITS, "draft-1");
      const filled = withNewValue(started, "draft-1", "name", "Katherine");

      expect(saved(filled).inserts).toEqual([{ values: { name: "Katherine" } }]);
    });

    it("drops one draft without touching the others", () => {
      const two = withNewRow(withNewRow(NO_EDITS, "draft-1"), "draft-2");
      expect(withoutNewRow(two, "draft-1").inserts.map((row) => row.id)).toEqual(["draft-2"]);
    });

    it("counts a row the reader has not filled in yet", () => {
      expect(editCount(withNewRow(NO_EDITS, "draft-1"))).toBe(1);
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
