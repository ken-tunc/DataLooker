import type { SchemaTree } from "../../bindings/SchemaTree";
import type { TableKind } from "../../bindings/TableKind";

export type TableMatch = {
  schema: string;
  table: string;
  kind: TableKind;
  /** Where the query landed in `schema.table`, for the palette to mark up. */
  hits: readonly number[];
};

/** More than a reader scans, and enough that a vague query still shows the table. */
export const MATCH_LIMIT = 50;

const CONTIGUOUS = 2;
const BOUNDARY = 3;
const IN_TABLE = 4;

type Ranked = { hits: readonly number[]; score: number };

const qualify = (schema: string, table: string) => `${schema}.${table}`;

/** `sales.order_items` is three words, and a query almost always starts at one. */
function startsWord(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1];
  return before === "." || before === "_";
}

/**
 * The leftmost subsequence from `start`. Positions are UTF-16 units, the same
 * ones the highlight slices by.
 */
function matchFrom(text: string, query: string, start: number): number[] | null {
  const hits: number[] = [];
  let index = start;
  for (let position = 0; position < query.length; position += 1) {
    while (index < text.length && text[index] !== query[position]) index += 1;
    if (index === text.length) return null;
    hits.push(index);
    index += 1;
  }
  return hits;
}

function score(text: string, hits: readonly number[], schemaLength: number): number {
  let total = hits[0] !== undefined && hits[0] > schemaLength ? IN_TABLE : 0;
  for (const [position, hit] of hits.entries()) {
    total += 1;
    if (hit === (hits[position - 1] ?? -2) + 1) total += CONTIGUOUS;
    if (startsWord(text, hit)) total += BOUNDARY;
  }
  return total;
}

/**
 * Every starting point is tried: the leftmost subsequence is not always the
 * one a reader means ("or" in `orders.order_id`).
 */
function best(text: string, query: string, schemaLength: number): Ranked | null {
  let winner: Ranked | null = null;

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== query[0]) continue;
    const hits = matchFrom(text, query, start);
    // A subsequence that does not fit from here fits from nowhere later either.
    if (!hits) break;
    const value = score(text, hits, schemaLength);
    if (!winner || value > winner.score) winner = { hits, score: value };
  }

  return winner;
}

/**
 * Matched against the qualified name, so a period narrows by schema. Spaces
 * are dropped: an identifier has none.
 */
export function searchTables(tree: SchemaTree, query: string, limit = MATCH_LIMIT): TableMatch[] {
  const needle = query.replaceAll(/\s+/gu, "").toLowerCase();
  const found: (TableMatch & Ranked)[] = [];

  for (const schema of tree.schemas) {
    for (const table of schema.tables) {
      const name = qualify(schema.name, table.name);
      const ranked =
        needle === ""
          ? { hits: [], score: 0 }
          : best(name.toLowerCase(), needle, schema.name.length);
      if (!ranked) continue;
      found.push({ schema: schema.name, table: table.name, kind: table.kind, ...ranked });
    }
  }

  // On a tie the shorter name is more specific (`people` before
  // `people_audit_2024`), then the name itself keeps the order stable. With
  // nothing typed, the tree's order stands.
  if (needle !== "") {
    found.sort(
      (left, right) =>
        right.score - left.score ||
        qualify(left.schema, left.table).length - qualify(right.schema, right.table).length ||
        qualify(left.schema, left.table).localeCompare(qualify(right.schema, right.table)),
    );
  }

  return found
    .slice(0, limit)
    .map(({ schema, table, kind, hits }) => ({ schema, table, kind, hits }));
}

/** The name split into the runs the query matched and the runs it did not. */
export function highlight(
  text: string,
  hits: readonly number[],
): { text: string; matched: boolean }[] {
  const parts: { text: string; matched: boolean }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const matched = hits.includes(index);
    const last = parts.at(-1);
    if (last && last.matched === matched) last.text += text[index];
    else parts.push({ text: text[index] ?? "", matched });
  }
  return parts;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const table = (name: string) => ({ name, kind: "table" as TableKind, columns: [] });
  const tree: SchemaTree = {
    schemas: [
      { name: "public", tables: [table("people"), table("orders"), table("order_items")] },
      { name: "analytics", tables: [table("people_daily"), table("peoplesoft_export")] },
    ],
  };

  const names = (matches: TableMatch[]) => matches.map((match) => `${match.schema}.${match.table}`);

  describe("searchTables", () => {
    it("lists every table while nothing is typed", () => {
      expect(names(searchTables(tree, ""))).toEqual([
        "public.people",
        "public.orders",
        "public.order_items",
        "analytics.people_daily",
        "analytics.peoplesoft_export",
      ]);
    });

    it("finds a table from letters scattered through its name", () => {
      expect(names(searchTables(tree, "odit"))).toEqual(["public.order_items"]);
    });

    it("puts the table whose own name matches ahead of its schema's", () => {
      expect(names(searchTables(tree, "people")).at(0)).toBe("public.people");
    });

    it("prefers a whole word to the same letters spread out", () => {
      expect(names(searchTables(tree, "order")).slice(0, 2)).toEqual([
        "public.orders",
        "public.order_items",
      ]);
    });

    it("narrows by schema once the period is typed", () => {
      expect(names(searchTables(tree, "ana.peo"))).toEqual([
        "analytics.people_daily",
        "analytics.peoplesoft_export",
      ]);
    });

    it("ignores case, and the spaces an identifier never has", () => {
      expect(names(searchTables(tree, " PUB . Ord "))).toEqual([
        "public.orders",
        "public.order_items",
      ]);
    });

    it("says nothing matches rather than guessing", () => {
      expect(searchTables(tree, "zzz")).toEqual([]);
    });

    it("hands back at most the limit it was given", () => {
      expect(searchTables(tree, "", 2)).toHaveLength(2);
    });

    it("marks where the match landed, not merely that there was one", () => {
      const [match] = searchTables(tree, "peo");
      expect(match?.hits).toEqual([7, 8, 9]);
    });
  });

  describe("highlight", () => {
    it("runs of matched and unmatched text alternate", () => {
      expect(highlight("public.people", [7, 8, 9])).toEqual([
        { text: "public.", matched: false },
        { text: "peo", matched: true },
        { text: "ple", matched: false },
      ]);
    });

    it("leaves a name nothing matched in one piece", () => {
      expect(highlight("people", [])).toEqual([{ text: "people", matched: false }]);
    });
  });
}
