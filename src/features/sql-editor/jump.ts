import type { SchemaTree } from "../../bindings/SchemaTree";

/** A name as the statement wrote it, folded the way PostgreSQL folds one. */
export type QualifiedName = { schema: string | null; name: string };

export type NamedTable = { schema: string; table: string };

type Token = { text: string; start: number; end: number };

const IDENTIFIER = /[\p{L}\p{N}_$]/u;

/**
 * Keywords come out as identifiers too; the catalog lookup tells them apart.
 *
 * An unquoted identifier is folded to lower case, as PostgreSQL does, so it
 * compares to the catalog's names by equality.
 */
function scan(line: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < line.length) {
    const char = line[at] as string;
    if (char === '"') {
      let close = at + 1;
      // A doubled quote is a quote in the name rather than the end of it.
      while (close < line.length && (line[close] !== '"' || line[close + 1] === '"')) {
        close += line[close] === '"' ? 2 : 1;
      }
      // An unclosed quote is a name still being typed.
      const text = line.slice(at + 1, Math.min(close, line.length)).replaceAll('""', '"');
      const end = Math.min(close + 1, line.length);
      tokens.push({ text, start: at, end });
      at = end;
      continue;
    }
    if (IDENTIFIER.test(char)) {
      let end = at;
      while (end < line.length && IDENTIFIER.test(line[end] as string)) end += 1;
      tokens.push({ text: line.slice(at, end).toLowerCase(), start: at, end });
      at = end;
      continue;
    }
    at += 1;
  }
  return tokens;
}

function joined(line: string, left: Token, right: Token): boolean {
  return /^\s*\.\s*$/.test(line.slice(left.end, right.start));
}

/** A cursor just after a name counts as in it. */
export function identifierAt(line: string, index: number): QualifiedName | null {
  const tokens = scan(line);
  const at = tokens.findIndex((token) => index >= token.start && index <= token.end);
  const token = tokens[at];
  if (!token) return null;

  const before = tokens[at - 1];
  if (before && joined(line, before, token)) {
    return { schema: before.text, name: token.text };
  }
  // On `shop` in `shop.orders`, the table is what was meant.
  const after = tokens[at + 1];
  if (after && joined(line, token, after)) {
    return { schema: token.text, name: after.text };
  }
  return { schema: null, name: token.text };
}

/**
 * More than one is not a failure: which one an unqualified name means is the
 * server's search path to decide, not this tree's.
 */
export function tablesNamed(tree: SchemaTree, wanted: QualifiedName): NamedTable[] {
  const found: NamedTable[] = [];
  for (const schema of tree.schemas) {
    if (wanted.schema !== null && schema.name !== wanted.schema) continue;
    for (const table of schema.tables) {
      if (table.name === wanted.name) found.push({ schema: schema.name, table: table.name });
    }
  }
  return found;
}

export function written(name: QualifiedName): string {
  return name.schema === null ? name.name : `${name.schema}.${name.name}`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const at = (line: string) => identifierAt(line, line.indexOf("|"));
  /** The cursor is written as `|`, and taken back out before the line is read. */
  const cursor = (marked: string) => identifierAt(marked.replace("|", ""), marked.indexOf("|"));

  describe("identifierAt", () => {
    it("reads the name the cursor is in", () => {
      expect(cursor("select * from ord|ers")).toEqual({ schema: null, name: "orders" });
    });

    it("counts either end of a name as being in it", () => {
      expect(cursor("select * from |orders")).toEqual({ schema: null, name: "orders" });
      expect(cursor("select * from orders|")).toEqual({ schema: null, name: "orders" });
    });

    it("takes the schema that qualifies the name", () => {
      expect(cursor("select * from shop.ord|ers")).toEqual({ schema: "shop", name: "orders" });
    });

    it("means the table when the cursor is on the schema", () => {
      expect(cursor("select * from sh|op.orders")).toEqual({ schema: "shop", name: "orders" });
    });

    it("reads a name the way PostgreSQL does: folded unless it was quoted", () => {
      expect(cursor("select * from Ord|ers")).toEqual({ schema: null, name: "orders" });
      expect(cursor('select * from "Ord|ers"')).toEqual({ schema: null, name: "Orders" });
      expect(cursor('select * from "Shop"."Ord|ers"')).toEqual({
        schema: "Shop",
        name: "Orders",
      });
    });

    it("joins a name across the spaces a statement is allowed", () => {
      expect(cursor("select * from shop . ord|ers")).toEqual({ schema: "shop", name: "orders" });
    });

    it("keeps two names apart when nothing joins them", () => {
      expect(cursor("select * from orders o|ld")).toEqual({ schema: null, name: "old" });
    });

    it("has nothing to say about a cursor on nothing", () => {
      expect(cursor("select * from orders |")).toBeNull();
      expect(at("")).toBeNull();
    });

    it("reads a quote the name quoted twice to hold", () => {
      expect(cursor('select * from "order""it|ems"')).toEqual({
        schema: null,
        name: 'order"items',
      });
    });

    it("survives a quote nothing closes", () => {
      expect(cursor('select * from "ord|ers')).toEqual({ schema: null, name: "orders" });
    });
  });

  describe("tablesNamed", () => {
    const table = (name: string) => ({ name, kind: "table" as const, columns: [] });
    const tree: SchemaTree = {
      schemas: [
        { name: "public", tables: [table("orders"), table("people")] },
        { name: "shop", tables: [table("orders")] },
      ],
    };

    it("finds the one table a qualified name can mean", () => {
      expect(tablesNamed(tree, { schema: "shop", name: "orders" })).toEqual([
        { schema: "shop", table: "orders" },
      ]);
    });

    it("gives every table an unqualified name can mean", () => {
      expect(tablesNamed(tree, { schema: null, name: "orders" })).toEqual([
        { schema: "public", table: "orders" },
        { schema: "shop", table: "orders" },
      ]);
    });

    it("finds nothing for a name no schema holds", () => {
      expect(tablesNamed(tree, { schema: null, name: "o" })).toEqual([]);
      expect(tablesNamed(tree, { schema: "archive", name: "orders" })).toEqual([]);
    });
  });

  describe("written", () => {
    it("puts the name back the way it was qualified", () => {
      expect(written({ schema: null, name: "orders" })).toBe("orders");
      expect(written({ schema: "shop", name: "orders" })).toBe("shop.orders");
    });
  });
}
