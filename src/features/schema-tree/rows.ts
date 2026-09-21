import type { Column } from "../../bindings/Column";
import type { SchemaTree } from "../../bindings/SchemaTree";
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

export type TreeRow =
  | { kind: "schema"; id: string; name: string; tables: number; expanded: boolean }
  | {
      kind: "table";
      id: string;
      schema: string;
      name: string;
      tableKind: TableKind;
      expanded: boolean;
    }
  | { kind: "column"; id: string; name: string; dataType: string; nullable: boolean }
  /** Where a table's columns would be, while they are on their way or lost. */
  | { kind: "note"; id: string; text: string };

/**
 * An id has to survive the periods a schema, table or column name may contain,
 * so the parts are encoded rather than joined.
 */
const rowId = (...parts: string[]) => JSON.stringify(parts);

export const schemaRowId = (schema: string) => rowId("schema", schema);
export const tableRowId = (schema: string, table: string) => rowId("table", schema, table);

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
 * The tree as the list renders it: one flat array, because the rows are
 * virtualized and a virtualizer counts rows, not nesting.
 *
 * A filter matches table names. Schemas without a match drop out, and the ones
 * left open up whether or not they were expanded — hunting for a table should
 * not mean clicking through the schemas that hold it.
 */
export function treeRows(
  tree: SchemaTree,
  expanded: ReadonlySet<string>,
  filter: string,
  columnsOf: (schema: string, table: string) => ColumnsState,
): TreeRow[] {
  const needle = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];

  for (const schema of tree.schemas) {
    const tables =
      needle === ""
        ? schema.tables
        : schema.tables.filter((table) => table.name.toLowerCase().includes(needle));
    if (needle !== "" && tables.length === 0) continue;

    const schemaOpen = needle !== "" || expanded.has(schemaRowId(schema.name));
    rows.push({
      kind: "schema",
      id: schemaRowId(schema.name),
      name: schema.name,
      tables: tables.length,
      expanded: schemaOpen,
    });
    if (!schemaOpen) continue;

    for (const table of tables) {
      const id = tableRowId(schema.name, table.name);
      const tableOpen = expanded.has(id);
      rows.push({
        kind: "table",
        id,
        schema: schema.name,
        name: table.name,
        tableKind: table.kind,
        expanded: tableOpen,
      });
      if (!tableOpen) continue;

      const state = columnsOf(schema.name, table.name);
      if (state.status === "reading") {
        rows.push({ kind: "note", id: `${id}:reading`, text: "Reading the columns…" });
        continue;
      }
      if (state.status === "failed") {
        rows.push({ kind: "note", id: `${id}:failed`, text: state.message });
        continue;
      }
      if (state.columns.length === 0) {
        rows.push({ kind: "note", id: `${id}:none`, text: "No columns." });
        continue;
      }

      for (const column of state.columns) {
        rows.push({
          kind: "column",
          id: columnRowId(schema.name, table.name, column.name),
          name: column.name,
          dataType: column.data_type,
          nullable: column.nullable,
        });
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
  });
}
