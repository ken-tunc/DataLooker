import type { StatementSpan } from "../../bindings/StatementSpan";

/**
 * The statement ⌘Enter means when nothing is selected: the one the cursor is
 * in, or the one it was just typed after on the same line. Otherwise, on a
 * blank line or a comment between two, the one that follows, since that is
 * what a reader puts a note or a gap before; after the last, the last.
 */
export function statementAt(
  text: string,
  spans: readonly StatementSpan[],
  cursor: number,
): StatementSpan | undefined {
  const holding = spans.find((span) => span.start <= cursor && cursor <= span.end);
  if (holding) return holding;
  const before = spans.filter((span) => span.end < cursor).at(-1);
  const after = spans.find((span) => span.start > cursor);
  if (before && !text.slice(before.end, cursor).includes("\n")) return before;
  return after ?? before;
}

/** `span` of `text` without the whitespace at either end; null when that is all it holds. */
export function trimmed(text: string, span: StatementSpan): StatementSpan | null {
  const part = text.slice(span.start, span.end);
  const start = span.start + (part.length - part.trimStart().length);
  const end = span.end - (part.length - part.trimEnd().length);
  return start < end ? { start, end } : null;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  /** The cursor is written as `|`; each statement is what lies between `;`s. */
  function pick(marked: string) {
    const cursor = marked.indexOf("|");
    const text = marked.replace("|", "");
    const spans: StatementSpan[] = [];
    let from = 0;
    for (const piece of text.split(";")) {
      const span = trimmed(text, { start: from, end: from + piece.length });
      if (span) spans.push(span);
      from += piece.length + 1;
    }
    const found = statementAt(text, spans, cursor);
    return found && text.slice(found.start, found.end);
  }

  describe("statementAt", () => {
    it("takes the statement the cursor is in, either end included", () => {
      expect(pick("SELECT 1;\nSELECT |2;\nSELECT 3")).toBe("SELECT 2");
      expect(pick("SELECT 1;\n|SELECT 2")).toBe("SELECT 2");
      expect(pick("SELECT 1;\nSELECT 2|")).toBe("SELECT 2");
    });

    it("takes the statement just finished on the cursor's line", () => {
      expect(pick("SELECT 1;|\nSELECT 2")).toBe("SELECT 1");
      expect(pick("SELECT 1;  |  SELECT 2")).toBe("SELECT 1");
    });

    it("takes the next statement from a line of its own between two", () => {
      expect(pick("SELECT 1;\n|\nSELECT 2")).toBe("SELECT 2");
      expect(pick("|\n\nSELECT 1")).toBe("SELECT 1");
    });

    it("takes the last statement from below it", () => {
      expect(pick("SELECT 1;\nSELECT 2;\n\n|")).toBe("SELECT 2");
    });

    it("finds nothing where there is nothing", () => {
      expect(pick("  |  ")).toBeUndefined();
    });
  });

  describe("trimmed", () => {
    it("drops the whitespace at either end", () => {
      expect(trimmed("  SELECT 1 \n", { start: 0, end: 12 })).toEqual({ start: 2, end: 10 });
      expect(trimmed("   ", { start: 0, end: 3 })).toBeNull();
    });
  });
}
