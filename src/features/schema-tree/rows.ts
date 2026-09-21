import type { Column } from "../../bindings/Column";
import type { SchemaTree } from "../../bindings/SchemaTree";
import type { Table } from "../../bindings/Table";
import type { TableKind } from "../../bindings/TableKind";

export const KIND_LABELS: Record<TableKind, string> = {
  table: "",
  view: "view",
  materialized_view: "materialized view",
  foreign_table: "foreign table",
};

export type NamedTable = { schema: string; table: string };

/** What is known about an opened table's columns, which are read on demand. */
export type ColumnsState =
  | { status: "reading" }
  | { status: "failed"; message: string }
  | { status: "read"; columns: Column[] };

export type TreeRow = { id: string; indent: number } & (
  | { kind: "schema"; name: string; tables: number; expanded: boolean }
  /** The one row a set of date-sharded tables is shown as. */
  | { kind: "shards"; schema: string; prefix: string; shards: number; expanded: boolean }
  | { kind: "table"; schema: string; name: string; tableKind: TableKind; expanded: boolean }
  | { kind: "column"; name: string; dataType: string; nullable: boolean }
  /** Where a table's columns would be, while they are on their way or lost. */
  | { kind: "note"; text: string }
);

/**
 * An id has to survive the periods a schema, table or column name may contain,
 * so the parts are encoded rather than joined.
 */
const rowId = (...parts: string[]) => JSON.stringify(parts);

export const schemaRowId = (schema: string) => rowId("schema", schema);
export const tableRowId = (schema: string, table: string) => rowId("table", schema, table);
export const shardsRowId = (schema: string, prefix: string) => rowId("shards", schema, prefix);

/**
 * The tables whose columns are wanted, read back out of the rows that are
 * open. The ids were written here, so what comes back out of one is what went
 * into it.
 */
export function openTables(expanded: ReadonlySet<string>): NamedTable[] {
  return [...expanded].flatMap((id) => {
    const [kind, schema, table] = JSON.parse(id) as string[];
    return kind === "table" && schema !== undefined && table !== undefined
      ? [{ schema, table }]
      : [];
  });
}
const columnRowId = (schema: string, table: string, column: string) =>
  rowId("column", schema, table, column);

/**
 * A name ending in a date is one day of a table written a day at a time, and a
 * project can hold years of them — `events_20250101`, `events_20250102`, and
 * tens of thousands more. They are one table to the reader, so the tree shows
 * them as one row. Only a table is folded this way: a view named like a day is
 * not one of a set, and neither is a year before 1000, which is a number that
 * happens to have four digits rather than a year anything was written in.
 */
const SHARD = /^(.+)_([1-9]\d{3})(\d{2})(\d{2})$/;

export function shardPrefix(name: string): string | null {
  const match = SHARD.exec(name);
  if (!match) return null;
  const [, prefix, year, month, day] = match;
  if (prefix === undefined || year === undefined || month === undefined || day === undefined) {
    return null;
  }
  // A day that no calendar has is not one a table was written on, so the date
  // is read rather than range-checked: February has 28 days in 2025.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const written =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
  return written ? prefix : null;
}

type ShardGroup =
  | { kind: "table"; table: Table }
  | { kind: "shards"; prefix: string; shards: Table[] };

/**
 * The tables of one schema, with each set of shards folded into a group where
 * it first appears. A prefix only one table carries is left as that table: a
 * row that opens onto a single table hides it rather than summing it up.
 */
export function shardGroups(tables: readonly Table[]): ShardGroup[] {
  const prefixOf = (table: Table) => (table.kind === "table" ? shardPrefix(table.name) : null);

  const counts = new Map<string, number>();
  for (const table of tables) {
    const prefix = prefixOf(table);
    if (prefix !== null) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  const groups: ShardGroup[] = [];
  const started = new Map<string, Table[]>();
  for (const table of tables) {
    const prefix = prefixOf(table);
    if (prefix === null || (counts.get(prefix) ?? 0) < 2) {
      groups.push({ kind: "table", table });
      continue;
    }
    const shards = started.get(prefix);
    if (shards) {
      shards.push(table);
      continue;
    }
    const first = [table];
    started.set(prefix, first);
    groups.push({ kind: "shards", prefix, shards: first });
  }

  // Newest first, which is the day a reader is most often after. The names are
  // the same but for the date, so they sort as the dates do.
  for (const group of groups) {
    if (group.kind === "shards") group.shards.sort((a, b) => b.name.localeCompare(a.name));
  }
  return groups;
}

/** A table's row, and the columns under it once it is open. */
function tableRows(
  schema: string,
  table: Table,
  indent: number,
  expanded: ReadonlySet<string>,
  columnsOf: (schema: string, table: string) => ColumnsState,
): TreeRow[] {
  const id = tableRowId(schema, table.name);
  const open = expanded.has(id);
  const row: TreeRow = {
    kind: "table",
    id,
    indent,
    schema,
    name: table.name,
    tableKind: table.kind,
    expanded: open,
  };
  if (!open) return [row];

  const under = indent + 1;
  const note = (what: string, text: string): TreeRow[] => [
    row,
    { kind: "note", id: `${id}:${what}`, indent: under, text },
  ];

  const state = columnsOf(schema, table.name);
  if (state.status === "reading") return note("reading", "Reading the columns…");
  if (state.status === "failed") return note("failed", state.message);
  if (state.columns.length === 0) return note("none", "No columns.");

  return [
    row,
    ...state.columns.map((column): TreeRow => ({
      kind: "column",
      id: columnRowId(schema, table.name, column.name),
      indent: under,
      name: column.name,
      dataType: column.data_type,
      nullable: column.nullable,
    })),
  ];
}

/**
 * The tree as the list renders it: one flat array, because the rows are
 * virtualized and a virtualizer counts rows, not nesting.
 *
 * A filter matches table names. Schemas without a match drop out, and the ones
 * left open up whether or not they were expanded — hunting for a table should
 * not mean clicking through the schemas that hold it. A group of shards opens
 * with them, since a filter is aimed at names rather than at groups.
 */
export function treeRows(
  tree: SchemaTree,
  expanded: ReadonlySet<string>,
  filter: string,
  columnsOf: (schema: string, table: string) => ColumnsState,
): TreeRow[] {
  const needle = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];

  const matches = (table: Table) => needle === "" || table.name.toLowerCase().includes(needle);

  for (const schema of tree.schemas) {
    // What the schema holds decides what a set of shards is; the filter only
    // decides which of them are shown. Grouping what survived a filter would
    // make a set of a thousand days look like one table whenever the reader
    // narrowed it down to one.
    const groups = shardGroups(schema.tables).flatMap((group): ShardGroup[] => {
      if (group.kind === "table") return matches(group.table) ? [group] : [];
      const shards = group.shards.filter(matches);
      return shards.length === 0 ? [] : [{ ...group, shards }];
    });
    if (needle !== "" && groups.length === 0) continue;

    const schemaOpen = needle !== "" || expanded.has(schemaRowId(schema.name));
    rows.push({
      kind: "schema",
      id: schemaRowId(schema.name),
      indent: 0,
      name: schema.name,
      tables: groups.reduce(
        (count, group) => count + (group.kind === "table" ? 1 : group.shards.length),
        0,
      ),
      expanded: schemaOpen,
    });
    if (!schemaOpen) continue;

    for (const group of groups) {
      if (group.kind === "table") {
        rows.push(...tableRows(schema.name, group.table, 1, expanded, columnsOf));
        continue;
      }

      const id = shardsRowId(schema.name, group.prefix);
      const open = needle !== "" || expanded.has(id);
      rows.push({
        kind: "shards",
        id,
        indent: 1,
        schema: schema.name,
        prefix: group.prefix,
        shards: group.shards.length,
        expanded: open,
      });
      if (!open) continue;

      for (const shard of group.shards) {
        rows.push(...tableRows(schema.name, shard, 2, expanded, columnsOf));
      }
    }
  }

  return rows;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const tree: SchemaTree = {
    schemas: [
      {
        name: "public",
        tables: [
          { name: "people", kind: "table" },
          { name: "orders", kind: "table" },
        ],
      },
      { name: "analytics", tables: [{ name: "daily_people", kind: "view" }] },
    ],
  };

  /** What the tables of the fixture hold, once someone has asked for them. */
  const read = (schema: string, table: string): ColumnsState =>
    schema === "public" && table === "people"
      ? {
          status: "read",
          columns: [
            { name: "id", data_type: "integer", nullable: false },
            { name: "email", data_type: "text", nullable: true },
          ],
        }
      : { status: "read", columns: [] };

  const sharded: SchemaTree = {
    schemas: [
      {
        name: "logs",
        tables: [
          { name: "events_20250101", kind: "table" },
          { name: "events_20250103", kind: "table" },
          { name: "events_20250102", kind: "table" },
        ],
      },
    ],
  };

  const ids = (rows: TreeRow[]) => rows.map((row) => row.id);
  const columns = (rows: TreeRow[]) => rows.filter((row) => row.kind === "column");
  const note = (rows: TreeRow[]) => rows.find((row) => row.kind === "note");

  describe("treeRows", () => {
    it("shows the schemas alone until one is expanded", () => {
      expect(ids(treeRows(tree, new Set(), "", read))).toEqual([
        schemaRowId("public"),
        schemaRowId("analytics"),
      ]);
      expect(ids(treeRows(tree, new Set([schemaRowId("public")]), "", read))).toEqual([
        schemaRowId("public"),
        tableRowId("public", "people"),
        tableRowId("public", "orders"),
        schemaRowId("analytics"),
      ]);
    });

    it("shows a table's columns once the table is expanded", () => {
      const rows = treeRows(
        tree,
        new Set([schemaRowId("public"), tableRowId("public", "people")]),
        "",
        read,
      );
      expect(columns(rows).map((row) => row.name)).toEqual(["id", "email"]);
      expect(rows.find((row) => row.kind === "column")).toMatchObject({
        name: "id",
        dataType: "integer",
        nullable: false,
      });
    });

    it("keeps only the schemas holding a match, and opens them", () => {
      const rows = treeRows(tree, new Set(), "people", read);
      expect(ids(rows)).toEqual([
        schemaRowId("public"),
        tableRowId("public", "people"),
        schemaRowId("analytics"),
        tableRowId("analytics", "daily_people"),
      ]);
    });

    it("matches a table name whatever the case, and ignores surrounding space", () => {
      expect(ids(treeRows(tree, new Set(), "  ORD  ", read))).toEqual([
        schemaRowId("public"),
        tableRowId("public", "orders"),
      ]);
    });

    it("leaves a table's columns closed while filtering", () => {
      expect(columns(treeRows(tree, new Set(), "people", read))).toEqual([]);
    });

    it("tells a table with a period in its name apart from a column", () => {
      const awkward: SchemaTree = {
        schemas: [
          {
            name: "public",
            tables: [
              { name: "a.b", kind: "table" },
              { name: "a", kind: "table" },
            ],
          },
        ],
      };
      const rows = treeRows(
        awkward,
        new Set([schemaRowId("public"), tableRowId("public", "a")]),
        "",
        () => ({ status: "read", columns: [{ name: "b", data_type: "text", nullable: true }] }),
      );
      expect(new Set(ids(rows)).size).toBe(ids(rows).length);
    });

    it("says where the columns will be while they are still being read", () => {
      const open = new Set([schemaRowId("public"), tableRowId("public", "people")]);
      const rows = treeRows(tree, open, "", () => ({ status: "reading" }));

      expect(note(rows)).toMatchObject({ kind: "note", text: "Reading the columns…" });
      expect(columns(rows)).toEqual([]);
    });

    it("says what went wrong where the columns would have been", () => {
      const open = new Set([schemaRowId("public"), tableRowId("public", "people")]);
      const rows = treeRows(tree, open, "", () => ({
        status: "failed",
        message: "the session is gone",
      }));

      expect(note(rows)).toMatchObject({ kind: "note", text: "the session is gone" });
    });

    it("says so rather than nothing for a table with no columns", () => {
      const open = new Set([schemaRowId("public"), tableRowId("public", "orders")]);
      const rows = treeRows(tree, open, "", read);

      expect(note(rows)).toMatchObject({ kind: "note", text: "No columns." });
    });

    it("reads the open tables back out of the rows that are open", () => {
      const open = new Set([schemaRowId("public"), tableRowId("public", "a.b")]);
      expect(openTables(open)).toEqual([{ schema: "public", table: "a.b" }]);
    });

    it("counts the tables it is showing, not the ones it filtered out", () => {
      const [schema] = treeRows(tree, new Set(), "orders", read);
      expect(schema).toMatchObject({ kind: "schema", name: "public", tables: 1 });
    });

    it("shows a set of shards as one row, and its days once it is opened", () => {
      const rows = treeRows(sharded, new Set([schemaRowId("logs")]), "", read);
      expect(rows.at(-1)).toMatchObject({ kind: "shards", prefix: "events", shards: 3 });

      const opened = treeRows(
        sharded,
        new Set([schemaRowId("logs"), shardsRowId("logs", "events")]),
        "",
        read,
      );
      expect(ids(opened).slice(2)).toEqual([
        tableRowId("logs", "events_20250103"),
        tableRowId("logs", "events_20250102"),
        tableRowId("logs", "events_20250101"),
      ]);
    });

    it("opens a set of shards while filtering, as it opens a schema", () => {
      const rows = treeRows(sharded, new Set(), "events_202501", read);
      expect(rows.filter((row) => row.kind === "table")).toHaveLength(3);
    });

    it("keeps a day inside its set when the filter matches only that day", () => {
      const rows = treeRows(sharded, new Set(), "events_20250103", read);
      expect(ids(rows)).toEqual([
        schemaRowId("logs"),
        shardsRowId("logs", "events"),
        tableRowId("logs", "events_20250103"),
      ]);
      expect(rows[1]).toMatchObject({ kind: "shards", shards: 1 });
    });

    it("indents a shard's columns under the group holding it", () => {
      const rows = treeRows(
        sharded,
        new Set([
          schemaRowId("logs"),
          shardsRowId("logs", "events"),
          tableRowId("logs", "events_20250103"),
        ]),
        "",
        () => ({ status: "read", columns: [{ name: "id", data_type: "int64", nullable: true }] }),
      );
      expect(columns(rows)[0]).toMatchObject({ name: "id", indent: 3 });
    });
  });

  describe("shardPrefix", () => {
    it("takes the name of a table written a day at a time", () => {
      expect(shardPrefix("events_20250101")).toBe("events");
      expect(shardPrefix("ga_sessions_20250101")).toBe("ga_sessions");
    });

    it("leaves alone a number that is not a date", () => {
      expect(shardPrefix("events_20251301")).toBeNull();
      expect(shardPrefix("events_20250132")).toBeNull();
      expect(shardPrefix("events_20250001")).toBeNull();
      expect(shardPrefix("orders_2025")).toBeNull();
      expect(shardPrefix("20250101")).toBeNull();
    });

    it("leaves alone a day the calendar does not have", () => {
      expect(shardPrefix("events_20250230")).toBeNull();
      expect(shardPrefix("events_20250431")).toBeNull();
      expect(shardPrefix("events_20250229")).toBeNull();
      expect(shardPrefix("events_00990101")).toBeNull();
      expect(shardPrefix("events_20240229")).toBe("events");
    });
  });

  describe("shardGroups", () => {
    it("folds a set where it starts, and leaves the rest where they are", () => {
      expect(
        shardGroups([
          { name: "customers", kind: "table" },
          { name: "events_20250101", kind: "table" },
          { name: "orders", kind: "table" },
          { name: "events_20250102", kind: "table" },
        ]).map((group) => (group.kind === "table" ? group.table.name : `${group.prefix}_*`)),
      ).toEqual(["customers", "events_*", "orders"]);
    });

    it("leaves a lone day as the table it is", () => {
      const groups = shardGroups([{ name: "events_20250101", kind: "table" }]);
      expect(groups).toEqual([
        { kind: "table", table: { name: "events_20250101", kind: "table" } },
      ]);
    });

    it("folds tables and not views, which are named like a day by coincidence", () => {
      const groups = shardGroups([
        { name: "events_20250101", kind: "view" },
        { name: "events_20250102", kind: "view" },
      ]);
      expect(groups.every((group) => group.kind === "table")).toBe(true);
    });
  });
}
