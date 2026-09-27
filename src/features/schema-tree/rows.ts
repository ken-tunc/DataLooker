import type { Column } from "../../bindings/Column";
import type { Index } from "../../bindings/Index";
import type { Routine } from "../../bindings/Routine";
import type { RoutineKind } from "../../bindings/RoutineKind";
import type { UserTypeKind } from "../../bindings/UserTypeKind";
import type { Schema } from "../../bindings/Schema";
import type { SchemaTree } from "../../bindings/SchemaTree";
import type { Table } from "../../bindings/Table";
import type { TableKind } from "../../bindings/TableKind";

export const KIND_LABELS: Record<TableKind, string> = {
  table: "",
  view: "view",
  materialized_view: "materialized view",
  foreign_table: "foreign table",
};

export const ROUTINE_LABELS: Record<RoutineKind, string> = {
  function: "function",
  procedure: "procedure",
  aggregate: "aggregate",
  window: "window function",
  table_function: "table function",
};

export type NamedTable = { schema: string; table: string };

/** What is known about an opened table's columns, which are read on demand. */
export type ColumnsState =
  | { status: "reading" }
  | { status: "failed"; message: string }
  | { status: "read"; columns: Column[] };

/** An opened table's indexes, read beside its columns. */
export type IndexesState =
  | { status: "reading" }
  | { status: "failed"; message: string }
  | { status: "read"; indexes: Index[] };

type IndexesOf = (schema: string, table: string) => IndexesState;

/** For a caller with no indexes to show, such as a test about columns. */
const NO_INDEXES: IndexesOf = () => ({ status: "read", indexes: [] });

export type TreeRow = { id: string; indent: number } &
  /** `items` counts what is shown under it: tables, and whatever the folders hold. */
  (
    | { kind: "schema"; name: string; items: number; expanded: boolean }
    /** Where a schema keeps what is not a table, so its tables stay near the top. */
    | { kind: "folder"; title: string; count: number; expanded: boolean }
    /** The one row a set of date-sharded tables is shown as. */
    | { kind: "shards"; schema: string; prefix: string; shards: number; expanded: boolean }
    | {
        kind: "table";
        schema: string;
        name: string;
        tableKind: TableKind;
        comment: string | null;
        expanded: boolean;
      }
    | { kind: "column"; name: string; dataType: string; nullable: boolean; comment: string | null }
    | {
        kind: "routine";
        schema: string;
        name: string;
        arguments: string;
        routineKind: RoutineKind;
        comment: string | null;
      }
    | {
        kind: "sequence";
        name: string;
        lastValue: string | null;
        ownedBy: string | null;
        comment: string | null;
      }
    /** `expanded` is null for a type with nothing to show under it. */
    | {
        kind: "type";
        name: string;
        typeKind: UserTypeKind;
        base: string | null;
        comment: string | null;
        expanded: boolean | null;
      }
    | {
        kind: "index";
        name: string;
        method: string;
        keys: string;
        unique: boolean;
        primary: boolean;
        bytes: number;
      }
    /** An enum's label, or a composite type's attribute. */
    | { kind: "member"; name: string; dataType: string | null }
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
export const folderRowId = (schema: string, folder: string) => rowId("folder", schema, folder);
export const indexesRowId = (schema: string, table: string) => rowId("indexes", schema, table);
export const typeRowId = (schema: string, type: string) => rowId("type", schema, type);
const routineRowId = (schema: string, routine: Routine) =>
  rowId("routine", schema, routine.name, routine.arguments);

/** The tables whose columns are wanted, read back out of the open rows' ids. */
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
 * A table named after a day (`events_20250101`) is one shard of a table written
 * a day at a time, and a project can hold years of them. Views are never
 * shards, and a year before 1000 is a number that happens to have four digits.
 */
const SHARD = /^(.+)_([1-9]\d{3})(\d{2})(\d{2})$/;

export function shardPrefix(name: string): string | null {
  const match = SHARD.exec(name);
  if (!match) return null;
  const [, prefix, year, month, day] = match;
  if (prefix === undefined || year === undefined || month === undefined || day === undefined) {
    return null;
  }
  // Read as a date rather than range-checked: February 2025 has 28 days.
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
 * Each set of shards is folded into a group where it first appears. A prefix
 * only one table carries stays that table: a group of one hides it.
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

  // Newest first. The names differ only in the date, so they sort as dates.
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
  indexesOf: IndexesOf,
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
    comment: table.comment,
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
      comment: column.comment,
    })),
    ...indexRows(schema, table.name, under, expanded, indexesOf(schema, table.name)),
  ];
}

/**
 * A folder after the columns, closed until asked for: what a reader opens a
 * table for is usually its columns. Nothing while they are on their way.
 */
function indexRows(
  schema: string,
  table: string,
  indent: number,
  expanded: ReadonlySet<string>,
  state: IndexesState,
): TreeRow[] {
  const id = indexesRowId(schema, table);
  if (state.status === "reading") return [];
  if (state.status === "failed") {
    return [{ kind: "note", id, indent, text: `Indexes: ${state.message}` }];
  }
  if (state.indexes.length === 0) return [];

  const open = expanded.has(id);
  return [
    { kind: "folder", id, indent, title: "Indexes", count: state.indexes.length, expanded: open },
    ...(open
      ? state.indexes.map((index): TreeRow => ({
          kind: "index",
          id: rowId("index", schema, table, index.name),
          indent: indent + 1,
          name: index.name,
          method: index.method,
          keys: index.keys,
          unique: index.unique,
          primary: index.primary,
          bytes: index.bytes,
        }))
      : []),
  ];
}

/** `count` is how many things it holds; `rows` also has what an open one holds. */
type Folder = { key: string; title: string; count: number; rows: TreeRow[] };

/**
 * What a schema keeps besides its tables, a folder per kind, holding what
 * `named` lets through. Rows are laid out at the indent a folder's go at.
 */
function folders(
  schema: Schema,
  named: (name: string) => boolean,
  expanded: ReadonlySet<string>,
): Folder[] {
  const routines = schema.routines.filter((routine) => named(routine.name));
  const sequences = schema.sequences.filter((sequence) => named(sequence.name));
  const types = schema.types.filter((type) => named(type.name));
  return [
    {
      key: "routines",
      title: "Routines",
      count: routines.length,
      rows: routines.map((routine): TreeRow => ({
        kind: "routine",
        id: routineRowId(schema.name, routine),
        indent: 2,
        schema: schema.name,
        name: routine.name,
        arguments: routine.arguments,
        routineKind: routine.kind,
        comment: routine.comment,
      })),
    },
    {
      key: "sequences",
      title: "Sequences",
      count: sequences.length,
      rows: sequences.map((sequence): TreeRow => ({
        kind: "sequence",
        id: rowId("sequence", schema.name, sequence.name),
        indent: 2,
        name: sequence.name,
        lastValue: sequence.last_value,
        ownedBy: sequence.owned_by,
        comment: sequence.comment,
      })),
    },
    {
      key: "types",
      title: "Types",
      count: types.length,
      rows: types.flatMap((type): TreeRow[] => {
        const id = typeRowId(schema.name, type.name);
        const expandable = type.members.length > 0;
        const open = expandable && expanded.has(id);
        const row: TreeRow = {
          kind: "type",
          id,
          indent: 2,
          name: type.name,
          typeKind: type.kind,
          base: type.base,
          comment: type.comment,
          expanded: expandable ? open : null,
        };
        if (!open) return [row];
        return [
          row,
          ...type.members.map((member): TreeRow => ({
            kind: "member",
            id: rowId("member", schema.name, type.name, member.name),
            indent: 3,
            name: member.name,
            dataType: member.data_type,
          })),
        ];
      }),
    },
  ];
}

/**
 * Flat, because a virtualizer counts rows, not nesting.
 *
 * A filter matches names — of tables, and of what the folders hold. Schemas,
 * folders and shard groups with a match open whether or not they were
 * expanded, and the rest drop out.
 */
export function treeRows(
  tree: SchemaTree,
  expanded: ReadonlySet<string>,
  filter: string,
  columnsOf: (schema: string, table: string) => ColumnsState,
  indexesOf: IndexesOf = NO_INDEXES,
): TreeRow[] {
  const needle = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];

  const named = (name: string) => needle === "" || name.toLowerCase().includes(needle);
  const matches = (table: Table) => named(table.name);

  for (const schema of tree.schemas) {
    // Grouped before filtering: a set narrowed to one day is still a set.
    const groups = shardGroups(schema.tables).flatMap((group): ShardGroup[] => {
      if (group.kind === "table") return matches(group.table) ? [group] : [];
      const shards = group.shards.filter(matches);
      return shards.length === 0 ? [] : [{ ...group, shards }];
    });
    const held = folders(schema, named, expanded).filter((folder) => folder.count > 0);
    if (needle !== "" && groups.length === 0 && held.length === 0) continue;

    const schemaOpen = needle !== "" || expanded.has(schemaRowId(schema.name));
    const tables = groups.reduce(
      (count, group) => count + (group.kind === "table" ? 1 : group.shards.length),
      0,
    );
    rows.push({
      kind: "schema",
      id: schemaRowId(schema.name),
      indent: 0,
      name: schema.name,
      items: held.reduce((count, folder) => count + folder.count, tables),
      expanded: schemaOpen,
    });
    if (!schemaOpen) continue;

    for (const folder of held) {
      const id = folderRowId(schema.name, folder.key);
      const open = needle !== "" || expanded.has(id);
      rows.push({
        kind: "folder",
        id,
        indent: 1,
        title: folder.title,
        count: folder.count,
        expanded: open,
      });
      if (open) rows.push(...folder.rows);
    }

    for (const group of groups) {
      if (group.kind === "table") {
        rows.push(...tableRows(schema.name, group.table, 1, expanded, columnsOf, indexesOf));
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
        rows.push(...tableRows(schema.name, shard, 2, expanded, columnsOf, indexesOf));
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
        sequences: [],
        types: [],
        routines: [],
        tables: [
          { name: "people", kind: "table", comment: null },
          { name: "orders", kind: "table", comment: null },
        ],
      },
      {
        name: "analytics",
        sequences: [],
        types: [],
        routines: [],
        tables: [{ name: "daily_people", kind: "view", comment: null }],
      },
    ],
  };

  /** What the tables of the fixture hold, once someone has asked for them. */
  const read = (schema: string, table: string): ColumnsState =>
    schema === "public" && table === "people"
      ? {
          status: "read",
          columns: [
            { name: "id", data_type: "integer", nullable: false, comment: null },
            { name: "email", data_type: "text", nullable: true, comment: null },
          ],
        }
      : { status: "read", columns: [] };

  const sharded: SchemaTree = {
    schemas: [
      {
        name: "logs",
        sequences: [],
        types: [],
        routines: [],
        tables: [
          { name: "events_20250101", kind: "table", comment: null },
          { name: "events_20250103", kind: "table", comment: null },
          { name: "events_20250102", kind: "table", comment: null },
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
            sequences: [],
            types: [],
            routines: [],
            tables: [
              { name: "a.b", kind: "table", comment: null },
              { name: "a", kind: "table", comment: null },
            ],
          },
        ],
      };
      const rows = treeRows(
        awkward,
        new Set([schemaRowId("public"), tableRowId("public", "a")]),
        "",
        () => ({
          status: "read",
          columns: [{ name: "b", data_type: "text", nullable: true, comment: null }],
        }),
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

    it("counts what it is showing, not what it filtered out", () => {
      const [schema] = treeRows(tree, new Set(), "orders", read);
      expect(schema).toMatchObject({ kind: "schema", name: "public", items: 1 });
    });

    it("keeps routines in a folder ahead of the tables, and leaves out an empty one", () => {
      const withRoutines: SchemaTree = {
        schemas: [
          {
            name: "public",
            tables: [{ name: "people", kind: "table", comment: null }],
            sequences: [],
            types: [],
            routines: [{ name: "add", kind: "function", arguments: "a int", comment: null }],
          },
          { name: "empty", tables: [], sequences: [], types: [], routines: [] },
        ],
      };
      const open = new Set([schemaRowId("public"), schemaRowId("empty")]);

      expect(treeRows(withRoutines, open, "", read).map((row) => row.kind)).toEqual([
        "schema",
        "folder",
        "table",
        "schema",
      ]);
      expect(treeRows(withRoutines, open, "", read)[0]).toMatchObject({ items: 2 });

      const inside = treeRows(
        withRoutines,
        new Set([...open, folderRowId("public", "routines")]),
        "",
        read,
      );
      expect(inside[2]).toMatchObject({ kind: "routine", name: "add", indent: 2 });

      // A routine matching the filter keeps its schema and opens its folder.
      expect(treeRows(withRoutines, new Set(), "ad", read).map((row) => row.kind)).toEqual([
        "schema",
        "folder",
        "routine",
      ]);
    });

    it("counts a folder's types, not the labels of the ones open", () => {
      const typed: SchemaTree = {
        schemas: [
          {
            name: "public",
            tables: [],
            routines: [],
            sequences: [{ name: "tickets", last_value: "7", owned_by: null, comment: null }],
            types: [
              {
                name: "mood",
                kind: "enum",
                base: null,
                members: [
                  { name: "sad", data_type: null },
                  { name: "happy", data_type: null },
                ],
                comment: null,
              },
              { name: "positive", kind: "domain", base: "integer", members: [], comment: null },
            ],
          },
        ],
      };
      const rows = treeRows(
        typed,
        new Set([
          schemaRowId("public"),
          folderRowId("public", "types"),
          typeRowId("public", "mood"),
          typeRowId("public", "positive"),
        ]),
        "",
        read,
      );

      expect(rows.map((row) => [row.kind, row.indent])).toEqual([
        ["schema", 0],
        ["folder", 1],
        ["folder", 1],
        ["type", 2],
        ["member", 3],
        ["member", 3],
        ["type", 2],
      ]);
      expect(rows[0]).toMatchObject({ items: 3 });
      expect(rows[2]).toMatchObject({ title: "Types", count: 2 });
      // A domain has nothing to open, whatever the set of open rows says.
      expect(rows[6]).toMatchObject({ name: "positive", expanded: null });
    });

    it("lists a table's indexes in a folder after its columns, once both are read", () => {
      const open = new Set([schemaRowId("public"), tableRowId("public", "people")]);
      const index = {
        name: "people_pkey",
        method: "btree",
        keys: "id",
        unique: true,
        primary: true,
        bytes: 8192,
      };
      const indexed = (): IndexesState => ({ status: "read", indexes: [index] });

      const closed = treeRows(tree, open, "", read, indexed);
      expect(closed.slice(2, 5).map((row) => row.kind)).toEqual(["column", "column", "folder"]);
      expect(closed[4]).toMatchObject({ title: "Indexes", count: 1, indent: 2 });

      const opened = treeRows(
        tree,
        new Set([...open, indexesRowId("public", "people")]),
        "",
        read,
        indexed,
      );
      expect(opened[5]).toMatchObject({ kind: "index", name: "people_pkey", indent: 3 });

      // Nothing stands in for indexes on their way; a table without any has no folder.
      expect(ids(treeRows(tree, open, "", read, () => ({ status: "reading" })))).toEqual(
        ids(treeRows(tree, open, "", read)),
      );
      expect(
        note(treeRows(tree, open, "", read, () => ({ status: "failed", message: "denied" }))),
      ).toMatchObject({ text: "Indexes: denied" });
    });

    it("tells overloads apart", () => {
      const overloaded: SchemaTree = {
        schemas: [
          {
            name: "public",
            tables: [],
            sequences: [],
            types: [],
            routines: [
              { name: "add", kind: "function", arguments: "a int", comment: null },
              { name: "add", kind: "function", arguments: "a text", comment: null },
            ],
          },
        ],
      };
      const rows = treeRows(overloaded, new Set(), "add", read);
      expect(new Set(ids(rows)).size).toBe(rows.length);
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
        () => ({
          status: "read",
          columns: [{ name: "id", data_type: "int64", nullable: true, comment: null }],
        }),
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
          { name: "customers", kind: "table", comment: null },
          { name: "events_20250101", kind: "table", comment: null },
          { name: "orders", kind: "table", comment: null },
          { name: "events_20250102", kind: "table", comment: null },
        ]).map((group) => (group.kind === "table" ? group.table.name : `${group.prefix}_*`)),
      ).toEqual(["customers", "events_*", "orders"]);
    });

    it("leaves a lone day as the table it is", () => {
      const groups = shardGroups([{ name: "events_20250101", kind: "table", comment: null }]);
      expect(groups).toEqual([
        { kind: "table", table: { name: "events_20250101", kind: "table", comment: null } },
      ]);
    });

    it("folds tables and not views, which are named like a day by coincidence", () => {
      const groups = shardGroups([
        { name: "events_20250101", kind: "view", comment: null },
        { name: "events_20250102", kind: "view", comment: null },
      ]);
      expect(groups.every((group) => group.kind === "table")).toBe(true);
    });
  });
}
