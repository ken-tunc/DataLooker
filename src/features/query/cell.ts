/** A cell is JSON, so it can be anything. */
export function formatCell(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Whatever is left is a document or an array, the only other JSON shapes.
  return JSON.stringify(value) ?? "";
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
}
