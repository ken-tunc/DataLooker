import type { DriverKind } from "../connections/driver";

/** One `@name` in a statement; `start` is at the `@`. */
type Blank = { name: string; start: number; end: number };

/** How a value is written into the statement. */
export type ValueType = "text" | "number" | "boolean" | "null" | "raw";

export type Value = { type: ValueType; text: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
/** A PostgreSQL dollar quote's opening tag: `$$` or `$tag$`. */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Where an `@` is not a blank: inside a string, a quoted name or a comment.
 * The drivers quote differently — PostgreSQL doubles a quote and has dollar
 * quotes, GoogleSQL escapes with a backslash and has `#` comments and
 * triple-quoted strings — and `@@name` is a BigQuery system variable.
 */
function blanks(sql: string, driver: DriverKind): Blank[] {
  const bigQuery = driver === "bigquery";
  const found: Blank[] = [];
  let at = 0;

  /** Past the quote that closes the one at `at`, or the end of an unclosed one. */
  function closing(quote: string, backslashes: boolean): number {
    let next = at + quote.length;
    while (next < sql.length) {
      if (backslashes && sql[next] === "\\") {
        next += 2;
      } else if (sql.startsWith(quote, next)) {
        // Doubled, it is a quote inside rather than the end.
        if (!backslashes && sql.startsWith(quote, next + 1)) next += 2;
        else return next + quote.length;
      } else {
        next += 1;
      }
    }
    return sql.length;
  }

  function lineEnd(): number {
    const newline = sql.indexOf("\n", at);
    return newline === -1 ? sql.length : newline + 1;
  }

  while (at < sql.length) {
    const rest = sql.slice(at);
    const char = sql[at];
    if (bigQuery && (rest.startsWith("'''") || rest.startsWith('"""'))) {
      at = closing(rest.slice(0, 3), true);
    } else if (char === "'" || char === '"' || char === "`") {
      // A backquote is BigQuery's quoted name, and not PostgreSQL at all.
      at = closing(char, bigQuery || char === "`");
    } else if (!bigQuery && DOLLAR_TAG.test(rest)) {
      const tag = (DOLLAR_TAG.exec(rest) as RegExpExecArray)[0];
      const close = sql.indexOf(tag, at + tag.length);
      at = close === -1 ? sql.length : close + tag.length;
    } else if (rest.startsWith("--") || (bigQuery && char === "#")) {
      at = lineEnd();
    } else if (rest.startsWith("/*")) {
      // PostgreSQL nests them; GoogleSQL has no reason to write one inside another.
      let depth = 0;
      do {
        if (sql.startsWith("/*", at)) {
          depth += 1;
          at += 2;
        } else if (sql.startsWith("*/", at)) {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      } while (depth > 0 && at < sql.length);
    } else if (char === "@") {
      const system = sql[at + 1] === "@";
      const name = NAME.exec(sql.slice(at + (system ? 2 : 1)))?.[0];
      if (name && !system) found.push({ name, start: at, end: at + 1 + name.length });
      at += (system ? 2 : 1) + (name?.length ?? 0);
    } else if (/[A-Za-z0-9_$]/.test(char as string)) {
      // A word as a whole, so the `$` of `a$b` does not open a dollar quote.
      at += /^[A-Za-z0-9_$]+/.exec(rest)?.[0].length ?? 1;
    } else {
      at += 1;
    }
  }
  return found;
}

/** Each blank once, in the order the statement first uses it. */
export function variablesIn(sql: string, driver: DriverKind): string[] {
  return [...new Set(blanks(sql, driver).map((blank) => blank.name))];
}

/** What is wrong with a value, or null when it can be written in. */
export function invalid(value: Value): string | null {
  switch (value.type) {
    case "number":
      return NUMBER.test(value.text.trim()) ? null : "Not a number";
    case "raw":
      return value.text.trim() === "" ? "Write the SQL to put here" : null;
    default:
      return null;
  }
}

/**
 * PostgreSQL's literal assumes `standard_conforming_strings`, on by default
 * since 9.1, under which a backslash is itself. A GoogleSQL literal cannot hold
 * a line break as written.
 */
function literal(text: string, driver: DriverKind): string {
  if (driver === "postgres") return `'${text.replaceAll("'", "''")}'`;
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `'${escaped}'`;
}

function written(value: Value, driver: DriverKind): string {
  switch (value.type) {
    case "text":
      return literal(value.text, driver);
    case "number":
      return value.text.trim();
    case "boolean":
      return value.text === "false" ? "FALSE" : "TRUE";
    case "null":
      return "NULL";
    case "raw":
      return value.text;
  }
}

/** A blank with no value is left as it was. */
export function filledIn(sql: string, driver: DriverKind, values: Record<string, Value>): string {
  let out = "";
  let from = 0;
  for (const blank of blanks(sql, driver)) {
    const value = values[blank.name];
    if (!value) continue;
    out += sql.slice(from, blank.start) + written(value, driver);
    from = blank.end;
  }
  return out + sql.slice(from);
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("variablesIn", () => {
    it("finds each blank once, in the order it is first used", () => {
      expect(variablesIn("SELECT @b, @a_1, @b", "postgres")).toEqual(["b", "a_1"]);
    });

    it("skips strings and quoted names", () => {
      expect(variablesIn(`SELECT '@a', "@b", @c`, "postgres")).toEqual(["c"]);
      expect(variablesIn("SELECT `@a`, @b FROM t", "bigquery")).toEqual(["b"]);
    });

    it("reads a doubled quote as PostgreSQL does, and a backslash as GoogleSQL does", () => {
      expect(variablesIn("SELECT 'it''s @a', @b", "postgres")).toEqual(["b"]);
      expect(variablesIn("SELECT 'it\\'s @a', @b", "bigquery")).toEqual(["b"]);
      // In PostgreSQL the backslash is a character, and the next quote closes.
      expect(variablesIn("SELECT 'a\\', @b", "postgres")).toEqual(["b"]);
    });

    it("skips PostgreSQL's dollar quotes, tagged or not", () => {
      expect(variablesIn("SELECT $$ @a $$, $fn$ @b $$ @c $fn$, @d", "postgres")).toEqual(["d"]);
    });

    it("does not read a dollar inside a name as a quote", () => {
      expect(variablesIn("SELECT a$b, @c, $1", "postgres")).toEqual(["c"]);
    });

    it("skips GoogleSQL's triple-quoted strings", () => {
      expect(variablesIn("SELECT '''it's @a''', @b", "bigquery")).toEqual(["b"]);
    });

    it("skips comments, nested ones included", () => {
      expect(variablesIn("-- @a\nSELECT /* @b /* @c */ @d */ @e", "postgres")).toEqual(["e"]);
    });

    it("reads # as a comment in GoogleSQL only", () => {
      expect(variablesIn("# @a\nSELECT @b", "bigquery")).toEqual(["b"]);
      expect(variablesIn("# @a\nSELECT @b", "postgres")).toEqual(["a", "b"]);
    });

    it("leaves BigQuery's system variables and a lone @ alone", () => {
      expect(variablesIn("SELECT @@time_zone, @tz", "bigquery")).toEqual(["tz"]);
      expect(variablesIn("SELECT @ -5, a @> b", "postgres")).toEqual([]);
    });

    it("stops at an unclosed quote rather than reading past it", () => {
      expect(variablesIn("SELECT @a, 'open @b", "postgres")).toEqual(["a"]);
    });
  });

  describe("invalid", () => {
    it("takes a number as SQL writes one", () => {
      expect(invalid({ type: "number", text: " -1.5e3 " })).toBeNull();
      expect(invalid({ type: "number", text: ".5" })).toBeNull();
      expect(invalid({ type: "number", text: "12abc" })).toBe("Not a number");
      expect(invalid({ type: "number", text: "" })).toBe("Not a number");
    });

    it("needs something to write for SQL, and nothing for text", () => {
      expect(invalid({ type: "raw", text: " " })).not.toBeNull();
      expect(invalid({ type: "text", text: "" })).toBeNull();
    });
  });

  describe("filledIn", () => {
    it("writes every use of a blank", () => {
      const values: Record<string, Value> = {
        id: { type: "number", text: " 42 " },
        name: { type: "text", text: "Ann" },
      };
      expect(filledIn("WHERE id = @id OR parent = @id AND name = @name", "postgres", values)).toBe(
        "WHERE id = 42 OR parent = 42 AND name = 'Ann'",
      );
    });

    it("quotes text the way each driver reads it back", () => {
      const value: Value = { type: "text", text: "it's C:\\\nnext" };
      expect(filledIn("@v", "postgres", { v: value })).toBe("'it''s C:\\\nnext'");
      expect(filledIn("@v", "bigquery", { v: value })).toBe("'it\\'s C:\\\\\\nnext'");
    });

    it("writes the other types as they are", () => {
      const sql = "@b, @n, @r";
      expect(
        filledIn(sql, "postgres", {
          b: { type: "boolean", text: "false" },
          n: { type: "null", text: "ignored" },
          r: { type: "raw", text: "now()" },
        }),
      ).toBe("FALSE, NULL, now()");
    });

    it("leaves strings, comments and blanks with no value alone", () => {
      const values: Record<string, Value> = { v: { type: "number", text: "9" } };
      expect(filledIn("SELECT '@v' -- @v\n, @v, @w", "postgres", values)).toBe(
        "SELECT '@v' -- @v\n, 9, @w",
      );
    });
  });
}
