export type SqlTab = { id: string; title: string; sql: string };

export type TabsState = { tabs: SqlTab[]; activeId: string };

/** Titles are `Query 1`, `Query 2`, …; a closed number is free again. */
function nextTitle(tabs: SqlTab[]): string {
  const taken = new Set(tabs.map((tab) => tab.title));
  for (let n = 1; ; n++) {
    const title = `Query ${n}`;
    if (!taken.has(title)) return title;
  }
}

export function openTab(state: TabsState | undefined, id: string): TabsState {
  const tabs = state?.tabs ?? [];
  return {
    tabs: [...tabs, { id, title: nextTitle(tabs), sql: "" }],
    activeId: id,
  };
}

/**
 * Closing the active tab moves to its neighbour on the right, which is where
 * the eye already is, and falls back to the left when there is none.
 */
export function closeTab(state: TabsState, id: string): TabsState | null {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) return null;
  const activeId =
    state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)] as SqlTab).id : state.activeId;
  return { tabs, activeId };
}

export function activateTab(state: TabsState, id: string): TabsState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

/** Wraps around, so holding the shortcut cycles the tabs. */
export function shiftTab(state: TabsState, by: number): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  if (index === -1) return state;
  const count = state.tabs.length;
  const next = state.tabs[(((index + by) % count) + count) % count] as SqlTab;
  return { ...state, activeId: next.id };
}

export function setSql(state: TabsState, id: string, sql: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, sql } : tab)),
  };
}

export function activeTab(state: TabsState): SqlTab {
  return (state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]) as SqlTab;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const three = (): TabsState => openTab(openTab(openTab(undefined, "a"), "b"), "c");

  describe("openTab", () => {
    it("starts a first tab and focuses it", () => {
      expect(openTab(undefined, "a")).toEqual({
        tabs: [{ id: "a", title: "Query 1", sql: "" }],
        activeId: "a",
      });
    });

    it("numbers a new tab after the ones still open", () => {
      const state = three();
      expect(state.tabs.map((tab) => tab.title)).toEqual(["Query 1", "Query 2", "Query 3"]);
      const reopened = openTab(closeTab(state, "b") as TabsState, "d");
      expect(reopened.tabs.map((tab) => tab.title)).toEqual(["Query 1", "Query 3", "Query 2"]);
    });
  });

  describe("closeTab", () => {
    it("moves to the tab on the right, then to the left at the end", () => {
      expect(closeTab(activateTab(three(), "b"), "b")?.activeId).toBe("c");
      expect(closeTab(activateTab(three(), "c"), "c")?.activeId).toBe("b");
    });

    it("leaves the active tab alone when another one closes", () => {
      expect(closeTab(activateTab(three(), "c"), "a")?.activeId).toBe("c");
    });

    it("reports the last tab closing, so the caller can decide what shows", () => {
      expect(closeTab(openTab(undefined, "a"), "a")).toBeNull();
    });
  });

  describe("shiftTab", () => {
    it("wraps in both directions", () => {
      expect(shiftTab(activateTab(three(), "c"), 1).activeId).toBe("a");
      expect(shiftTab(activateTab(three(), "a"), -1).activeId).toBe("c");
    });
  });

  describe("setSql", () => {
    it("writes to one tab only", () => {
      const state = setSql(three(), "b", "SELECT 1");
      expect(state.tabs.map((tab) => tab.sql)).toEqual(["", "SELECT 1", ""]);
    });
  });
}
