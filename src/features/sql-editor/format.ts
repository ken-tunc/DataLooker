import { bigquery, formatDialect, postgresql } from "sql-formatter";

export type Dialect = "postgresql" | "bigquery";

const DIALECTS = { postgresql, bigquery } as const;

/** A line and a column, counting from one, as Monaco does. */
export type Place = { line: number; column: number };

/** Where a refusal was found, when the formatter said, in `text`'s own lines. */
export type Formatted =
  | { ok: true; text: string }
  | { ok: false; reason: string; at: Place | null };

/** The formatter ends its first line with where it stopped, counted in what it was given. */
const WHERE = /\s*at line (\d+) column (\d+)\.?$/;

/**
 * Keywords keep the case they were written in: a reader who wrote them lower
 * case did not ask for them upper case. The whitespace around the statement is
 * kept, and its lines take the indent of the line it starts on, so a selection
 * stays where it sat. `lineStart` is what precedes `text` on that line.
 */
export function formatted(
  text: string,
  dialect: Dialect,
  tabWidth: number,
  lineStart = "",
): Formatted {
  const body = text.trim();
  if (!body) return { ok: true, text };
  const before = text.slice(0, text.indexOf(body));
  const after = text.slice(before.length + body.length);
  const indent = /^[ \t]*/.exec((lineStart + before).split("\n").at(-1) ?? "")?.[0] ?? "";
  try {
    const options = { dialect: DIALECTS[dialect], tabWidth };
    const laid = formatDialect(body, options);
    const shifted = laid.replace(/\n(?=.)/g, `\n${indent}`);
    // A line break inside a literal is part of its value, which an indent would
    // change. The formatter keeps literals as written, so laying the indented
    // text out again gives something else exactly when one was touched.
    const kept = indent && formatDialect(shifted, options) === laid ? shifted : laid;
    return { ok: true, text: before + kept + after };
  } catch (error) {
    // The first line says what and where; the rest is the grammar's working.
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    const where = WHERE.exec(first);
    if (!where) return { ok: false, reason: first, at: null };
    // It counted from the trimmed statement, so what was trimmed is added back.
    const skipped = before.split("\n");
    const line = Number(where[1]) + skipped.length - 1;
    const column = Number(where[2]) + (line === skipped.length ? (skipped.at(-1)?.length ?? 0) : 0);
    return { ok: false, reason: first.slice(0, where.index), at: { line, column } };
  }
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("formatted", () => {
    it("lays a statement out and keeps its comments and case", () => {
      expect(formatted("select a, b -- why\nFROM t where x=1", "postgresql", 2)).toEqual({
        ok: true,
        text: "select\n  a,\n  b -- why\nFROM\n  t\nwhere\n  x = 1",
      });
    });

    it("indents by the width it is given", () => {
      expect(formatted("select a from t", "postgresql", 4)).toEqual({
        ok: true,
        text: "select\n    a\nfrom\n    t",
      });
    });

    it("keeps the whitespace around the statement", () => {
      expect(formatted("\nselect 1  \n", "postgresql", 2)).toEqual({
        ok: true,
        text: "\nselect\n  1  \n",
      });
    });

    it("indents every line as far as the line the statement starts on", () => {
      const nested = { ok: true, text: "\n    select\n      1" };
      expect(formatted("\n    select 1", "postgresql", 2)).toEqual(nested);
      expect(formatted("select 1", "postgresql", 2, "    ")).toEqual({
        ok: true,
        text: "select\n      1",
      });
      expect(formatted("select 1;\nselect 2", "postgresql", 2, "  ")).toEqual({
        ok: true,
        text: "select\n    1;\n\n  select\n    2",
      });
      // Only the indent: what else precedes it on the line is not repeated.
      expect(formatted("select 1", "postgresql", 2, "  x in (")).toEqual({
        ok: true,
        text: "select\n    1",
      });
    });

    it("leaves a literal's line breaks as they are, even if its lines go unindented", () => {
      expect(formatted("select 'a\nb'", "postgresql", 2, "  ")).toEqual({
        ok: true,
        text: "select\n  'a\nb'",
      });
    });

    it("reads each dialect's own syntax", () => {
      expect(formatted("select a::int from t", "postgresql", 2)).toMatchObject({ ok: true });
      expect(formatted("select * from `p.d.t` where x = @x", "bigquery", 2)).toEqual({
        ok: true,
        text: "select\n  *\nfrom\n  `p.d.t`\nwhere\n  x = @x",
      });
    });

    it("says in one line why it cannot read a statement, and where", () => {
      expect(formatted("select (( from", "postgresql", 2)).toEqual({
        ok: false,
        reason: "Parse error at token: «EOF»",
        at: { line: 1, column: 15 },
      });
      expect(formatted("select 'open", "postgresql", 2)).toEqual({
        ok: false,
        reason: `Parse error: Unexpected "'open"`,
        at: { line: 1, column: 8 },
      });
    });

    it("counts where in the text it was given, whitespace around it included", () => {
      expect(formatted("\n\n  select ((", "postgresql", 2)).toMatchObject({
        at: { line: 3, column: 12 },
      });
      expect(formatted("  select 1;\nselect ((", "postgresql", 2)).toMatchObject({
        at: { line: 2, column: 10 },
      });
    });

    it("leaves an empty document alone", () => {
      expect(formatted("  \n", "postgresql", 2)).toEqual({ ok: true, text: "  \n" });
    });
  });
}
