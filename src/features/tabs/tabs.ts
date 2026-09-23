import type { Sort } from "../../bindings/Sort";

/** What a table tab keeps besides its identity: how it is being read. */
export type TableView = {
  filter: string;
  sort: Sort | null;
  page: number;
  /** Its rows, or what it is made of. */
  shows: "rows" | "structure";
};

export type Tab =
  | { kind: "sql"; id: string; title: string; sql: string }
  | ({
      kind: "table";
      id: string;
      title: string;
      schema: string;
      table: string;
      /**
       * Whether the pane holds edits it has not saved. The edits are the
       * pane's own; the strip only needs to know there are some, to mark the
       * tab and to ask before closing it.
       */
      unsaved: boolean;
    } & TableView);

export type TabsState = { tabs: Tab[]; activeId: string };

/** Query titles are `Query 1`, `Query 2`, …; a closed number is free again. */
function nextQueryTitle(tabs: Tab[]): string {
  const taken = new Set(tabs.map((tab) => tab.title));
  for (let n = 1; ; n++) {
    const title = `Query ${n}`;
    if (!taken.has(title)) return title;
  }
}

function opened(state: TabsState | undefined, tab: Tab): TabsState {
  return { tabs: [...(state?.tabs ?? []), tab], activeId: tab.id };
}

export function openSqlTab(state: TabsState | undefined, id: string, sql = ""): TabsState {
  return opened(state, {
    kind: "sql",
    id,
    title: nextQueryTitle(state?.tabs ?? []),
    sql,
  });
}

/**
 * A table opens once: asking for it again brings its tab forward rather than
 * making a second one, since a tab is the table, not a view of it. What it is
 * asked to show it shows either way — a reader who asked for a definition is
 * asking for it of the tab they already had open too.
 */
export function openTableTab(
  state: TabsState | undefined,
  id: string,
  schema: string,
  table: string,
  shows: TableView["shows"] = "rows",
): TabsState {
  const open = state?.tabs.find(
    (tab) => tab.kind === "table" && tab.schema === schema && tab.table === table,
  );
  if (state && open) return setTableView({ ...state, activeId: open.id }, open.id, { shows });

  return opened(state, {
    kind: "table",
    id,
    // Two schemas can hold a table of the same name, and a tab reading
    // `people` would not say which one.
    title: `${schema}.${table}`,
    schema,
    table,
    filter: "",
    sort: null,
    page: 0,
    shows,
    unsaved: false,
  });
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
    state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)] as Tab).id : state.activeId;
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
  const next = state.tabs[(((index + by) % count) + count) % count] as Tab;
  return { ...state, activeId: next.id };
}

export function setSql(state: TabsState, id: string, sql: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id && tab.kind === "sql" ? { ...tab, sql } : tab)),
  };
}

export function setTableView(state: TabsState, id: string, view: Partial<TableView>): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id && tab.kind === "table" ? { ...tab, ...view, page: nextPage(tab, view) } : tab,
    ),
  };
}

/** Hands back the same state when nothing changed, so that no one re-renders. */
export function setUnsaved(state: TabsState, id: string, unsaved: boolean): TabsState {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (tab?.kind !== "table" || tab.unsaved === unsaved) return state;
  return {
    ...state,
    tabs: state.tabs.map((candidate) =>
      candidate.id === id && candidate.kind === "table" ? { ...candidate, unsaved } : candidate,
    ),
  };
}

/**
 * A filter or a sort makes a different set of rows, so the table starts again
 * from its first page. Reading what the table is made of and coming back does
 * not: the rows are the ones that were there.
 */
function nextPage(tab: TableView, view: Partial<TableView>): number {
  if (view.page !== undefined) return view.page;
  const rows = view.filter !== undefined || view.sort !== undefined;
  return rows ? 0 : tab.page;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const three = (): TabsState => openSqlTab(openSqlTab(openSqlTab(undefined, "a"), "b"), "c");
  const ids = (state: TabsState) => state.tabs.map((tab) => tab.id);

  describe("openSqlTab", () => {
    it("starts a first tab and focuses it", () => {
      expect(openSqlTab(undefined, "a")).toEqual({
        tabs: [{ kind: "sql", id: "a", title: "Query 1", sql: "" }],
        activeId: "a",
      });
    });

    it("starts with the statement it was handed", () => {
      expect(openSqlTab(undefined, "a", "SELECT 1").tabs[0]).toMatchObject({ sql: "SELECT 1" });
    });

    it("numbers a new tab after the ones still open", () => {
      const state = three();
      expect(state.tabs.map((tab) => tab.title)).toEqual(["Query 1", "Query 2", "Query 3"]);
      const reopened = openSqlTab(closeTab(state, "b") as TabsState, "d");
      expect(reopened.tabs.map((tab) => tab.title)).toEqual(["Query 1", "Query 3", "Query 2"]);
    });
  });

  describe("openTableTab", () => {
    it("opens the table on its first page, unfiltered and unsorted", () => {
      const state = openTableTab(undefined, "t1", "public", "people");
      expect(state.tabs[0]).toEqual({
        kind: "table",
        id: "t1",
        title: "public.people",
        schema: "public",
        table: "people",
        filter: "",
        sort: null,
        page: 0,
        shows: "rows",
        unsaved: false,
      });
    });

    it("shows what it was asked for, in a new tab and in one already open", () => {
      const opened = openTableTab(undefined, "t1", "public", "people", "structure");
      expect(opened.tabs[0]).toMatchObject({ shows: "structure" });

      const paged = setTableView(opened, "t1", { page: 2, shows: "rows" });
      const again = openTableTab(paged, "t2", "public", "people", "structure");
      expect(again.tabs[0]).toMatchObject({ shows: "structure", page: 2 });
    });

    it("brings an open table forward instead of opening it twice", () => {
      const first = openTableTab(openSqlTab(undefined, "a"), "t1", "public", "people");
      const again = openTableTab(first, "t2", "public", "people");
      expect(ids(again)).toEqual(["a", "t1"]);
      expect(again.activeId).toBe("t1");
    });

    it("tells apart two tables of the same name in different schemas", () => {
      const first = openTableTab(undefined, "t1", "public", "people");
      const second = openTableTab(first, "t2", "analytics", "people");
      expect(ids(second)).toEqual(["t1", "t2"]);
      expect(second.tabs.map((tab) => tab.title)).toEqual(["public.people", "analytics.people"]);
    });
  });

  describe("setTableView", () => {
    const table = () => openTableTab(undefined, "t1", "public", "people");

    it("starts again from the first page when the filter changes", () => {
      const paged = setTableView(table(), "t1", { page: 3 });
      const filtered = setTableView(paged, "t1", { filter: "id > 10" });
      expect(filtered.tabs[0]).toMatchObject({ filter: "id > 10", page: 0 });
    });

    it("stays on its page while the structure is read", () => {
      const paged = setTableView(table(), "t1", { page: 3 });
      const structure = setTableView(paged, "t1", { shows: "structure" });
      expect(structure.tabs[0]).toMatchObject({ shows: "structure", page: 3 });
    });

    it("keeps the page the caller asked for", () => {
      expect(setTableView(table(), "t1", { page: 2 }).tabs[0]).toMatchObject({ page: 2 });
    });

    it("leaves a SQL tab alone", () => {
      const mixed = setTableView(openSqlTab(undefined, "a"), "a", { filter: "x" });
      expect(mixed.tabs[0]).toMatchObject({ kind: "sql", sql: "" });
    });
  });

  describe("setUnsaved", () => {
    const table = () => openTableTab(openSqlTab(undefined, "a"), "t1", "public", "people");

    it("marks a table tab and clears the mark", () => {
      const marked = setUnsaved(table(), "t1", true);
      expect(marked.tabs[1]).toMatchObject({ unsaved: true });
      expect(setUnsaved(marked, "t1", false).tabs[1]).toMatchObject({ unsaved: false });
    });

    it("hands back the same state when nothing changes", () => {
      const state = table();
      expect(setUnsaved(state, "t1", false)).toBe(state);
      expect(setUnsaved(state, "a", true)).toBe(state);
    });
  });

  describe("setSql", () => {
    it("writes to one tab only", () => {
      const state = setSql(three(), "b", "SELECT 1");
      expect(state.tabs.map((tab) => (tab.kind === "sql" ? tab.sql : null))).toEqual([
        "",
        "SELECT 1",
        "",
      ]);
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
      expect(closeTab(openSqlTab(undefined, "a"), "a")).toBeNull();
    });
  });

  describe("shiftTab", () => {
    it("wraps in both directions", () => {
      expect(shiftTab(activateTab(three(), "c"), 1).activeId).toBe("a");
      expect(shiftTab(activateTab(three(), "a"), -1).activeId).toBe("c");
    });
  });
}
