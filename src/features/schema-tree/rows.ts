import type { SchemaTree } from "../../bindings/SchemaTree";
import type { TableKind } from "../../bindings/TableKind";

export type TreeRow =
  | { kind: "schema"; id: string; name: string; tables: number; expanded: boolean }
  | {
      kind: "table";
      id: string;
      schema: string;
      name: string;
      tableKind: TableKind;
      columns: number;
      expanded: boolean;
    }
  | { kind: "column"; id: string; name: string; dataType: string; nullable: boolean };

export const schemaRowId = (schema: string) => `schema:${schema}`;
export const tableRowId = (schema: string, table: string) => `table:${schema}.${table}`;

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
      const tableOpen = expanded.has(tableRowId(schema.name, table.name));
      rows.push({
        kind: "table",
        id: tableRowId(schema.name, table.name),
        schema: schema.name,
        name: table.name,
        tableKind: table.kind,
        columns: table.columns.length,
        expanded: tableOpen,
      });
      if (!tableOpen) continue;

      for (const column of table.columns) {
        rows.push({
          kind: "column",
          id: `${tableRowId(schema.name, table.name)}.${column.name}`,
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
          {
            name: "people",
            kind: "table",
            columns: [
              { name: "id", data_type: "integer", nullable: false },
              { name: "email", data_type: "text", nullable: true },
            ],
          },
          { name: "orders", kind: "table", columns: [] },
        ],
      },
      {
        name: "analytics",
        tables: [{ name: "daily_people", kind: "view", columns: [] }],
      },
    ],
  };

  const ids = (rows: TreeRow[]) => rows.map((row) => row.id);

  describe("treeRows", () => {
    it("shows the schemas alone until one is expanded", () => {
      expect(ids(treeRows(tree, new Set(), ""))).toEqual(["schema:public", "schema:analytics"]);
      expect(ids(treeRows(tree, new Set(["schema:public"]), ""))).toEqual([
        "schema:public",
        "table:public.people",
        "table:public.orders",
        "schema:analytics",
      ]);
    });

    it("shows a table's columns once the table is expanded", () => {
      const rows = treeRows(tree, new Set(["schema:public", "table:public.people"]), "");
      expect(ids(rows)).toContain("table:public.people.email");
      expect(rows.find((row) => row.kind === "column")).toMatchObject({
        name: "id",
        dataType: "integer",
        nullable: false,
      });
    });

    it("keeps only the schemas holding a match, and opens them", () => {
      const rows = treeRows(tree, new Set(), "people");
      expect(ids(rows)).toEqual([
        "schema:public",
        "table:public.people",
        "schema:analytics",
        "table:analytics.daily_people",
      ]);
    });

    it("matches a table name whatever the case, and ignores surrounding space", () => {
      expect(ids(treeRows(tree, new Set(), "  ORD  "))).toEqual([
        "schema:public",
        "table:public.orders",
      ]);
    });

    it("leaves a table's columns closed while filtering", () => {
      const rows = treeRows(tree, new Set(), "people");
      expect(rows.some((row) => row.kind === "column")).toBe(false);
    });

    it("counts the tables it is showing, not the ones it filtered out", () => {
      const [schema] = treeRows(tree, new Set(), "orders");
      expect(schema).toMatchObject({ kind: "schema", name: "public", tables: 1 });
    });
  });
}
