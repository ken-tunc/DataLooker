import type { Candidate } from "../../bindings/Candidate";
import type { SchemaTree } from "../../bindings/SchemaTree";

/** A name offered where the statement says what may go there. */
export type Offered = {
  label: string;
  kind: Candidate["kind"] | "dataset" | "table";
  detail?: string;
  /** Monaco sorts by this before it sorts by how well the label matches. */
  sortText: string;
};

const ordered = (index: number) => String(index).padStart(5, "0");

/**
 * What a list of names becomes. A column two tables of the same query share is
 * offered with the table's name before it, since the name on its own is one
 * BigQuery would refuse as ambiguous. A name of the type the place wants comes
 * first, and then what the query the cursor is in can see, before what the
 * queries around it can.
 */
export function offered(candidates: Candidate[], expected: string | null): Offered[] {
  const qualifiers = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (candidate.kind !== "column" || candidate.qualifier === null) continue;
    const key = `${candidate.depth}:${candidate.name}`;
    qualifiers.set(key, (qualifiers.get(key) ?? new Set()).add(candidate.qualifier));
  }

  return candidates.map((candidate, index) => {
    const shared = (qualifiers.get(`${candidate.depth}:${candidate.name}`)?.size ?? 0) > 1;
    const fits = expected !== null && candidate.type_name === expected;
    const detail = [candidate.qualifier, candidate.type_name].filter(Boolean).join(" · ");
    return {
      label:
        shared && candidate.qualifier !== null
          ? `${candidate.qualifier}.${candidate.name}`
          : candidate.name,
      kind: candidate.kind,
      detail: detail === "" ? undefined : detail,
      sortText: `${fits ? 0 : 1}${String(candidate.depth).padStart(3, "0")}${ordered(index)}`,
    };
  });
}

/**
 * What a table's name being typed after `FROM` can go on to: the datasets
 * where nothing is written yet, or only the project, and a dataset's tables
 * once one is. The tree is the connection's project, so a name in any other
 * project is not one it can offer.
 */
export function tablesAfter(path: string[], tree: SchemaTree, project: string): Offered[] {
  const within = path[0] === project ? path.slice(1) : path;
  if (within.length === 0) {
    return tree.schemas.map((schema, index) => ({
      label: schema.name,
      kind: "dataset",
      detail: "dataset",
      sortText: ordered(index),
    }));
  }
  if (within.length > 1) return [];
  const dataset = tree.schemas.find((schema) => schema.name === within[0]);
  return (dataset?.tables ?? []).map((table, index) => ({
    label: table.name,
    kind: "table",
    detail: table.kind === "table" ? undefined : table.kind.replaceAll("_", " "),
    sortText: ordered(index),
  }));
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const column = (name: string, qualifier: string | null, type = "INT64", depth = 0) =>
    ({ name, kind: "column", type_name: type, qualifier, depth }) as const;

  describe("offered", () => {
    it("writes a column two tables share after the table it is from", () => {
      const names = offered(
        [column("id", "o"), column("id", "c"), column("total", "o"), column("id", "x", "INT64", 1)],
        null,
      ).map((name) => name.label);
      // The outer query's `id` is its only one, so it needs no table.
      expect(names).toEqual(["o.id", "c.id", "total", "id"]);
    });

    it("puts what the place wants first, and then what is nearest", () => {
      const names = offered(
        [column("outer_flag", "x", "BOOL", 1), column("id", "o"), column("flag", "o", "BOOL")],
        "BOOL",
      );
      const sorted = [...names].sort((a, b) => a.sortText.localeCompare(b.sortText));
      expect(sorted.map((name) => name.label)).toEqual(["flag", "outer_flag", "id"]);
    });

    it("says what a name is and where it is from", () => {
      expect(offered([column("id", "o")], null)[0]?.detail).toBe("o · INT64");
      expect(
        offered(
          [{ name: "o", kind: "range_variable", type_name: null, qualifier: null, depth: 0 }],
          null,
        )[0]?.detail,
      ).toBeUndefined();
    });
  });

  describe("tablesAfter", () => {
    const tree: SchemaTree = {
      schemas: [
        {
          name: "sales",
          tables: [
            { name: "orders", kind: "table" },
            { name: "recent", kind: "materialized_view" },
          ],
        },
        { name: "logs", tables: [] },
      ],
    };

    it("offers the datasets before one is named", () => {
      expect(tablesAfter([], tree, "shop").map((name) => name.label)).toEqual(["sales", "logs"]);
      expect(tablesAfter(["shop"], tree, "shop").map((name) => name.label)).toEqual([
        "sales",
        "logs",
      ]);
    });

    it("offers a dataset's tables once it is named, with or without the project", () => {
      expect(tablesAfter(["sales"], tree, "shop").map((name) => name.label)).toEqual([
        "orders",
        "recent",
      ]);
      expect(tablesAfter(["shop", "sales"], tree, "shop")[1]?.detail).toBe("materialized view");
    });

    it("offers nothing it does not know about", () => {
      expect(tablesAfter(["elsewhere", "sales"], tree, "shop")).toEqual([]);
      expect(tablesAfter(["nothing"], tree, "shop")).toEqual([]);
    });
  });
}
