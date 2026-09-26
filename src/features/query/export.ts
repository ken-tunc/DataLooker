import type { QueryColumn } from "../../bindings/QueryColumn";
import { formatCell } from "./cell";

/**
 * Rows as the grid shows them, under the columns they were taken from.
 * `typed` marks a cell holding text the reader typed and has not saved.
 */
export type Block = { columns: QueryColumn[]; rows: unknown[][]; typed?: boolean[][] };

/** The table rows are copied out of, for a statement that puts them back. */
export type InsertTarget = { schema: string; table: string };

/**
 * The shape a spreadsheet reads when it is pasted. A field is quoted only if
 * it holds a tab or a line break, or starts with a quote: a quote further in
 * is read as itself, so a document pastes as it reads. NULL is an empty
 * field, since a spreadsheet has no other way to hold one.
 */
export function toTsv({ columns, rows }: Block, headers: boolean): string {
  const lines = rows.map((row) => row.map((cell) => delimited(cell, "\t")).join("\t"));
  if (headers) lines.unshift(columns.map((column) => delimited(column.name, "\t")).join("\t"));
  return lines.join("\n");
}

/** RFC 4180, with a header. NULL is an empty field, as it is in TSV. */
export function toCsv({ columns, rows }: Block): string {
  return [columns.map((column) => column.name), ...rows]
    .map((row) => row.map((cell) => delimited(cell, ",")).join(","))
    .join("\n");
}

function delimited(cell: unknown, separator: string): string {
  if (cell === null) return "";
  const text = formatCell(cell);
  const quote = separator === "\t" ? text.startsWith('"') : text.includes('"');
  return quote || text.includes(separator) || /[\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

/** For a message or a document: the cells as the grid writes them, NULL included. */
export function toMarkdown({ columns, rows }: Block): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const escape = (text: string) => text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
  return [
    line(columns.map((column) => escape(column.name))),
    line(columns.map(() => "---")),
    ...rows.map((row) => line(row.map((cell) => escape(formatCell(cell))))),
  ].join("\n");
}

/**
 * An object per row, each cell the JSON it crossed as: an integer JavaScript
 * would round stays a string. Two columns of one name would be one key, so a
 * later one is numbered.
 */
export function toJson({ columns, rows }: Block): string {
  const keys: string[] = [];
  for (const { name } of columns) {
    let key = name;
    for (let n = 2; keys.includes(key); n += 1) key = `${name}_${n}`;
    keys.push(key);
  }
  const objects = rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]])));
  return JSON.stringify(objects, null, 2);
}

/**
 * One PostgreSQL `INSERT` for all the rows. A value is written as the text
 * PostgreSQL reads for its type, left for the column to cast, which is how a
 * grid save sends one too; a column not copied takes its default.
 */
export function toInsert(target: InsertTarget, { columns, rows, typed }: Block): string {
  const names = columns.map((column) => identifier(column.name)).join(", ");
  const values = rows.map((row, r) => {
    const cells = row.map((cell, i) =>
      // Typed text is already what the column reads, as a save sends it.
      typed?.[r]?.[i] && typeof cell === "string"
        ? quoted(cell)
        : literal(cell, columns[i]?.type_name ?? ""),
    );
    return `  (${cells.join(", ")})`;
  });
  return `INSERT INTO ${identifier(target.schema)}.${identifier(target.table)} (${names}) VALUES\n${values.join(",\n")};`;
}

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoted(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function literal(cell: unknown, typeName: string): string {
  if (cell === null) return "NULL";
  // sqlx names an array `INT4[]`; a column read as text is named `int4[]`.
  const array = typeName.endsWith("[]");
  const json = /^jsonb?(\[\])?$/i.test(typeName);
  if (array && Array.isArray(cell)) return quoted(arrayLiteral(cell, json));
  // A document may be a bare string, which only its JSON form tells from text.
  if (json) return quoted(JSON.stringify(cell));
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return quoted(formatCell(cell));
}

/** Every element quoted, which PostgreSQL reads for any element type. */
function arrayLiteral(items: unknown[], json: boolean): string {
  const element = (item: unknown): string => {
    if (item === null) return "NULL";
    if (!json && Array.isArray(item)) return arrayLiteral(item, json);
    const text = json ? JSON.stringify(item) : formatCell(item);
    return `"${text.replaceAll(/["\\]/g, "\\$&")}"`;
  };
  return `{${items.map(element).join(",")}}`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const column = (name: string, type_name = "TEXT"): QueryColumn => ({
    name,
    type_name,
    instant: false,
  });

  describe("toTsv", () => {
    it("quotes only a field a spreadsheet would split", () => {
      const block = {
        columns: [column("a"), column("b")],
        rows: [
          ["plain", 'say "hi"'],
          ["two\nlines", "tab\there"],
          ['"quoted"', ""],
        ],
      };
      expect(toTsv(block, false)).toBe(
        'plain\tsay "hi"\n"two\nlines"\t"tab\there"\n"""quoted"""\t',
      );
    });

    it("leaves NULL empty and writes a document as JSON", () => {
      const block = { columns: [column("a"), column("b")], rows: [[null, { k: [1] }]] };
      expect(toTsv(block, true)).toBe('a\tb\n\t{"k":[1]}');
    });
  });

  describe("toCsv", () => {
    it("heads the rows with the column names and quotes a comma", () => {
      const block = {
        columns: [column("id", "INT4"), column("name")],
        rows: [
          [1, "Lovelace, Ada"],
          [2, null],
          [3, 'say "hi"'],
        ],
      };
      expect(toCsv(block)).toBe('id,name\n1,"Lovelace, Ada"\n2,\n3,"say ""hi"""');
    });
  });

  describe("toMarkdown", () => {
    it("escapes what would break the table, and shows NULL", () => {
      const block = { columns: [column("a|b")], rows: [["x|y"], ["one\ntwo"], [null]] };
      expect(toMarkdown(block)).toBe("| a\\|b |\n| --- |\n| x\\|y |\n| one<br>two |\n| NULL |");
    });
  });

  describe("toJson", () => {
    it("keeps each cell as it crossed, and numbers a repeated name", () => {
      const block = {
        columns: [column("id", "INT8"), column("id", "INT8"), column("doc", "JSONB")],
        rows: [["9007199254740993", 1, { a: null }]],
      };
      expect(JSON.parse(toJson(block))).toEqual([
        { id: "9007199254740993", id_2: 1, doc: { a: null } },
      ]);
    });
  });

  describe("toInsert", () => {
    const target = { schema: "public", table: 'odd"name' };

    it("writes one statement with a row per line", () => {
      const block = {
        columns: [column("id", "INT4"), column("name"), column("ok", "BOOL")],
        rows: [
          [1, "O'Brien", true],
          [2, null, false],
        ],
      };
      expect(toInsert(target, block)).toBe(
        `INSERT INTO "public"."odd""name" ("id", "name", "ok") VALUES\n` +
          `  (1, 'O''Brien', TRUE),\n` +
          `  (2, NULL, FALSE);`,
      );
    });

    it("writes a document as JSON, even one that is a bare string", () => {
      const block = { columns: [column("doc", "JSONB")], rows: [[{ a: "it's" }], ["text"], [3]] };
      expect(toInsert(target, block)).toContain(`  ('{"a":"it''s"}'),\n  ('"text"'),\n  ('3');`);
    });

    it("writes an array as PostgreSQL's array literal", () => {
      const block = {
        columns: [column("tags", "TEXT[]"), column("docs", "JSONB[]"), column("grid", "INT4[]")],
        rows: [
          [
            ['a "b"', null, "c\\d"],
            [{ k: 1 }, "s"],
            [
              [1, 2],
              [3, 4],
            ],
          ],
        ],
      };
      expect(toInsert(target, block)).toContain(
        `  ('{"a \\"b\\"",NULL,"c\\\\d"}', '{"{\\"k\\":1}","\\"s\\""}', '{{"1","2"},{"3","4"}}');`,
      );
    });

    it("writes a document the reader typed as they typed it", () => {
      const block = {
        columns: [column("doc", "JSONB"), column("n", "INT4")],
        rows: [['{"a":1}', "7"]],
        typed: [[true, true]],
      };
      expect(toInsert(target, block)).toContain(`  ('{"a":1}', '7');`);
    });

    it("quotes a value read as text, whatever its type", () => {
      const block = {
        columns: [column("n", "INT8"), column("place", "address")],
        rows: [["9007199254740993", "(Tokyo,100)"]],
      };
      expect(toInsert(target, block)).toContain(`  ('9007199254740993', '(Tokyo,100)');`);
    });
  });
}
