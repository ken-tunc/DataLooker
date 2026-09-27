/**
 * A key combination such as `⇧⌘D`, one keycap. Each symbol is set apart from
 * the next and drawn in the UI face: in a small monospace one the modifiers
 * shrink and run into the key they modify.
 */
export function Keys({ keys, size }: { keys: string; size: "xs" | "sm" }) {
  return (
    <kbd className={`kbd ${size === "xs" ? "kbd-xs" : "kbd-sm"} gap-[0.25em] font-sans`}>
      {parts(keys).map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </kbd>
  );
}

/** A named key (`Tab`, `click`) stays one word; the gap stands in for a `-`. */
function parts(keys: string): string[] {
  return keys.match(/[A-Za-z]+|[^\s-]/gu) ?? [];
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("parts", () => {
    it("sets each symbol apart and keeps a named key whole", () => {
      expect(parts("⇧⌘D")).toEqual(["⇧", "⌘", "D"]);
      expect(parts("⌃⇧Tab")).toEqual(["⌃", "⇧", "Tab"]);
      expect(parts("⇧↑↓←→")).toEqual(["⇧", "↑", "↓", "←", "→"]);
      expect(parts("⌘-click")).toEqual(["⌘", "click"]);
      expect(parts("Backspace")).toEqual(["Backspace"]);
    });
  });
}
