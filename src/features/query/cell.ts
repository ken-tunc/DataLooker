/** A cell is JSON, so it can be anything. */
export function formatCell(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/**
 * A cell as its full view shows it: a document or an array indented, since
 * that is where one runs long. A string is left alone even if it reads as
 * JSON, because parsing it would round the numbers it spells out.
 */
export function formatCellInFull(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2);
  return formatCell(value);
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("formatCell", () => {
    it("shows NULL for a missing value", () => {
      expect(formatCell(null)).toBe("NULL");
    });

    it("leaves a string as it is, so a quoted one is not quoted twice", () => {
      expect(formatCell('say "hi"')).toBe('say "hi"');
      expect(formatCell("")).toBe("");
    });

    it("writes documents and arrays back as JSON", () => {
      expect(formatCell({ a: 1 })).toBe('{"a":1}');
      expect(formatCell([1, null, 3])).toBe("[1,null,3]");
    });

    it("prints numbers and booleans as they read in SQL", () => {
      expect(formatCell(42)).toBe("42");
      expect(formatCell(1.5)).toBe("1.5");
      expect(formatCell(true)).toBe("true");
    });
  });

  describe("formatCellInFull", () => {
    it("indents a document so that its nesting shows", () => {
      expect(formatCellInFull({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
    });

    it("leaves a string that reads as JSON as it came", () => {
      expect(formatCellInFull('{"id": 12345678901234567890}')).toBe('{"id": 12345678901234567890}');
    });
  });
}
