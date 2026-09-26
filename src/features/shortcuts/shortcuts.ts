export type Shortcut = {
  /** Alternatives: any one of them does it. */
  keys: readonly string[];
  what: string;
};

export type ShortcutGroup = { title: string; shortcuts: readonly Shortcut[] };

/**
 * What the help dialog lists, and README's table. The handlers stay where the
 * keys are heard; the test below keeps the README in step with this list.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Anywhere",
    shortcuts: [{ keys: ["⌘?"], what: "Show these shortcuts" }],
  },
  {
    title: "With a connection",
    shortcuts: [
      { keys: ["⌘O"], what: "Find a table by name and open it" },
      { keys: ["⌘Y"], what: "Reopen a query that was run before" },
      { keys: ["⌘J"], what: "Open a query template" },
      { keys: ["⌘T"], what: "New SQL tab" },
    ],
  },
  {
    title: "Tabs",
    shortcuts: [
      { keys: ["⌃Tab", "⌃⇧Tab"], what: "Next / previous tab" },
      { keys: ["Delete", "Backspace"], what: "Close the focused tab" },
    ],
  },
  {
    title: "Editor",
    shortcuts: [
      { keys: ["⌘Enter"], what: "Run the editor's query" },
      { keys: ["⌘E"], what: "Show how PostgreSQL would run it" },
      { keys: ["⌘⇧E"], what: "Run it read-only and time each step" },
      { keys: ["⌘⇧D", "⌘-click"], what: "Open the table named under the cursor" },
      { keys: ["⇧⌥F"], what: "Format the statement, or the selection" },
    ],
  },
  {
    title: "Results",
    shortcuts: [
      { keys: ["⇧-click", "⇧↑↓←→"], what: "Stretch the selection over a range" },
      { keys: ["⌘↑↓←→"], what: "Go to the first / last row or column" },
      { keys: ["⌘A"], what: "Select every cell" },
      { keys: ["⌘C"], what: "Copy the selected cells" },
      { keys: ["Space"], what: "Show the selected cell in full" },
      { keys: ["⌘Backspace"], what: "Set the cell being edited to NULL" },
      { keys: ["↑", "↓", "⌃N", "⌃P"], what: "Next / previous node in a plan" },
    ],
  },
  {
    title: "Palettes",
    shortcuts: [{ keys: ["⌃N", "⌃P"], what: "Next / previous item in a palette" }],
  },
  {
    title: "Connections",
    shortcuts: [{ keys: ["⌥↑", "⌥↓"], what: "Move the focused connection up / down" }],
  },
];

/** ⌘?, as macOS opens Help: `?` is ⇧/ on every layout the app is used with. */
export function isHelpKey(event: KeyboardEvent): boolean {
  return event.metaKey && (event.key === "?" || (event.shiftKey && event.code === "Slash"));
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("shortcuts", () => {
    it("are the ones README's table lists, in the same order", async () => {
      const { default: readme } = await import("../../../README.md?raw");
      const section = readme.split("## Keyboard")[1]?.split("\n## ")[0] ?? "";
      const rows = section
        .split("\n")
        .filter((line) => line.startsWith("|"))
        // The header and the line under it.
        .slice(2)
        .map((line) =>
          line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim()),
        );

      const listed = SHORTCUT_GROUPS.flatMap((group) =>
        group.shortcuts.map((shortcut) => [shortcut.keys.join(", "), shortcut.what]),
      );
      expect(rows).toEqual(listed);
    });
  });
}
