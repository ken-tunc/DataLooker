import type { SavedTab } from "../../bindings/SavedTab";
import type { SavedTabs } from "../../bindings/SavedTabs";
import type { Sort } from "../../bindings/Sort";

/** What a table tab keeps besides its identity: how it is being read. */
export type TableView = {
  filter: string;
  sort: Sort | null;
  page: number;
  /** An ISO 8601 point in UTC to read the rows as they were then, or null for now. */
  asOf: string | null;
  /** Its rows, or what it is made of. */
  shows: "rows" | "structure";
};

export type Tab =
  | {
      kind: "sql";
      id: string;
      title: string;
      sql: string;
      /** Written by an agent and not yet edited or run by the reader. */
      fromAgent: boolean;
    }
  | ({
      kind: "table";
      id: string;
      title: string;
      schema: string;
      table: string;
      /** The edits are the pane's; the strip only marks the tab and asks before closing. */
      unsaved: boolean;
    } & TableView)
  | {
      kind: "routine";
      id: string;
      title: string;
      schema: string;
      name: string;
      /** Which of PostgreSQL's overloads of the name, as the tree lists it. */
      arguments: string;
    };

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

/** `title` names what the statement came from, such as a template. */
export function openSqlTab(
  state: TabsState | undefined,
  id: string,
  sql = "",
  title?: string,
  fromAgent = false,
): TabsState {
  return opened(state, {
    kind: "sql",
    id,
    title: title ?? nextQueryTitle(state?.tabs ?? []),
    sql,
    fromAgent,
  });
}

/**
 * A table opens once: asking again brings its tab forward, switched to what
 * was asked for.
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

  return opened(state, tableTab(id, schema, table, shows));
}

function tableTab(id: string, schema: string, table: string, shows: TableView["shows"]): Tab {
  return {
    kind: "table",
    id,
    // Two schemas can hold a table of the same name.
    title: `${schema}.${table}`,
    schema,
    table,
    filter: "",
    sort: null,
    page: 0,
    asOf: null,
    shows,
    unsaved: false,
  };
}

const sameTable = (tab: Tab, saved: SavedTab) =>
  tab.kind === "table" &&
  saved.kind === "table" &&
  tab.schema === saved.schema &&
  tab.table === saved.table;

/**
 * What is kept across a restart. A statement an agent handed over and nobody
 * took up is left out: it was handed over to be run now, not kept.
 */
export function toSaved(state: TabsState | undefined): SavedTabs {
  const kept = (state?.tabs ?? []).filter((tab) => !(tab.kind === "sql" && tab.fromAgent));
  return {
    tabs: kept.map((tab): SavedTab =>
      tab.kind === "sql"
        ? { kind: "sql", title: tab.title, sql: tab.sql }
        : { kind: "table", schema: tab.schema, table: tab.table },
    ),
    active: Math.max(
      kept.findIndex((tab) => tab.id === state?.activeId),
      0,
    ),
  };
}

/**
 * Puts the saved tabs before any opened while they were being read, which keep
 * the front. `ids` holds one fresh id per saved tab.
 */
export function restoreTabs(
  state: TabsState | undefined,
  saved: SavedTabs,
  ids: string[],
): TabsState | undefined {
  const restored = saved.tabs.flatMap((tab, index): Tab[] => {
    const id = ids[index] ?? crypto.randomUUID();
    if (tab.kind === "sql") return [{ ...tab, id, fromAgent: false }];
    // A table opens once.
    if (state?.tabs.some((open) => sameTable(open, tab))) return [];
    return [tableTab(id, tab.schema, tab.table, "rows")];
  });
  const first = restored[0];
  if (!first) return state;
  const active = ids[saved.active];
  const activeId =
    state?.activeId ?? (restored.some((tab) => tab.id === active) ? active : first.id);
  return { tabs: [...restored, ...(state?.tabs ?? [])], activeId: activeId ?? first.id };
}

/** A routine's definition opens once, as a table does. */
export function openRoutineTab(
  state: TabsState | undefined,
  id: string,
  schema: string,
  name: string,
  args: string,
): TabsState {
  const open = state?.tabs.find(
    (tab) =>
      tab.kind === "routine" &&
      tab.schema === schema &&
      tab.name === name &&
      tab.arguments === args,
  );
  if (state && open) return { ...state, activeId: open.id };

  return opened(state, {
    kind: "routine",
    id,
    title: `${schema}.${name}`,
    schema,
    name,
    arguments: args,
  });
}

/** Closing the active tab moves to its right neighbour, else its left. */
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

/** An edit makes the statement the reader's, whoever wrote it first. */
export function setSql(state: TabsState, id: string, sql: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id && tab.kind === "sql" && tab.sql !== sql
        ? { ...tab, sql, fromAgent: false }
        : tab,
    ),
  };
}

/**
 * Running an agent's statement makes it the reader's too. Hands back the same
 * state when nothing changed, as this is called on every run.
 */
export function adoptSql(state: TabsState, id: string): TabsState {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (tab?.kind !== "sql" || !tab.fromAgent) return state;
  return {
    ...state,
    tabs: state.tabs.map((candidate) =>
      candidate.id === id && candidate.kind === "sql"
        ? { ...candidate, fromAgent: false }
        : candidate,
    ),
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

/** Only a filter, a sort or a point in time starts again from the first page. */
function nextPage(tab: TableView, view: Partial<TableView>): number {
  if (view.page !== undefined) return view.page;
  const rows = view.filter !== undefined || view.sort !== undefined || view.asOf !== undefined;
  return rows ? 0 : tab.page;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const three = (): TabsState => openSqlTab(openSqlTab(openSqlTab(undefined, "a"), "b"), "c");
  const ids = (state: TabsState) => state.tabs.map((tab) => tab.id);

  describe("openRoutineTab", () => {
    it("opens an overload once, and another overload beside it", () => {
      const first = openRoutineTab(openSqlTab(undefined, "a"), "r1", "public", "add", "a integer");
      expect(first.tabs[1]).toMatchObject({ kind: "routine", title: "public.add" });

      const again = openRoutineTab(activateTab(first, "a"), "r2", "public", "add", "a integer");
      expect(again.tabs).toHaveLength(2);
      expect(again.activeId).toBe("r1");

      const other = openRoutineTab(first, "r3", "public", "add", "a text");
      expect(other.tabs).toHaveLength(3);
      expect(other.activeId).toBe("r3");
    });
  });

  describe("openSqlTab", () => {
    it("starts a first tab and focuses it", () => {
      expect(openSqlTab(undefined, "a")).toEqual({
        tabs: [{ kind: "sql", id: "a", title: "Query 1", sql: "", fromAgent: false }],
        activeId: "a",
      });
    });

    it("starts with the statement it was handed", () => {
      expect(openSqlTab(undefined, "a", "SELECT 1").tabs[0]).toMatchObject({ sql: "SELECT 1" });
    });

    it("takes the title it was handed, and leaves the numbering to the others", () => {
      const named = openSqlTab(undefined, "a", "SELECT 1", "Orders");
      expect(named.tabs[0]).toMatchObject({ title: "Orders" });
      expect(openSqlTab(named, "b").tabs[1]).toMatchObject({ title: "Query 1" });
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
        asOf: null,
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

    it("starts again from the first page when another point in time is read", () => {
      const paged = setTableView(table(), "t1", { page: 3 });
      const past = setTableView(paged, "t1", { asOf: "2025-01-02T01:00:00.000Z" });
      expect(past.tabs[0]).toMatchObject({ asOf: "2025-01-02T01:00:00.000Z", page: 0 });
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

  describe("an agent's tab", () => {
    const handed = () => openSqlTab(undefined, "a", "DELETE FROM orders", "Clean up", true);

    it("is marked until the reader edits it", () => {
      expect(handed().tabs[0]).toMatchObject({ title: "Clean up", fromAgent: true });
      expect(setSql(handed(), "a", "DELETE FROM orders WHERE id = 1").tabs[0]).toMatchObject({
        fromAgent: false,
      });
    });

    it("stays marked when the editor hands back what it already holds", () => {
      expect(setSql(handed(), "a", "DELETE FROM orders").tabs[0]).toMatchObject({
        fromAgent: true,
      });
    });

    it("is marked until the reader runs it", () => {
      expect(adoptSql(handed(), "a").tabs[0]).toMatchObject({ fromAgent: false });
    });

    it("hands back the same state when there is nothing to adopt", () => {
      const own = openSqlTab(undefined, "a");
      expect(adoptSql(own, "a")).toBe(own);
      const adopted = adoptSql(handed(), "a");
      expect(adoptSql(adopted, "a")).toBe(adopted);
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

  describe("toSaved", () => {
    it("keeps each tab's statement or table, in order, and which is in front", () => {
      const state = activateTab(
        openTableTab(openSqlTab(undefined, "a", "SELECT 1"), "t1", "public", "people"),
        "a",
      );
      expect(toSaved(state)).toEqual({
        tabs: [
          { kind: "sql", title: "Query 1", sql: "SELECT 1" },
          { kind: "table", schema: "public", table: "people" },
        ],
        active: 0,
      });
    });

    it("leaves out what an agent handed over and nobody took up", () => {
      const handed = openSqlTab(openSqlTab(undefined, "a"), "b", "DELETE FROM orders", "x", true);
      expect(toSaved(handed)).toEqual({
        tabs: [{ kind: "sql", title: "Query 1", sql: "" }],
        active: 0,
      });
      expect(toSaved(adoptSql(handed, "b")).tabs).toHaveLength(2);
    });

    it("keeps nothing when nothing is open", () => {
      expect(toSaved(undefined)).toEqual({ tabs: [], active: 0 });
    });
  });

  describe("restoreTabs", () => {
    const saved: SavedTabs = {
      tabs: [
        { kind: "sql", title: "Orders", sql: "SELECT 1" },
        { kind: "table", schema: "public", table: "people" },
      ],
      active: 1,
    };

    it("reopens what was saved, with the saved tab in front", () => {
      const state = restoreTabs(undefined, saved, ["x", "y"]) as TabsState;
      expect(state.tabs).toEqual([
        { kind: "sql", id: "x", title: "Orders", sql: "SELECT 1", fromAgent: false },
        openTableTab(undefined, "y", "public", "people").tabs[0],
      ]);
      expect(state.activeId).toBe("y");
      expect(toSaved(state)).toEqual(saved);
    });

    it("goes before a tab opened while it was read, which stays in front", () => {
      const handed = openSqlTab(undefined, "a", "SELECT 2", "Handed", true);
      const state = restoreTabs(handed, saved, ["x", "y"]) as TabsState;
      expect(ids(state)).toEqual(["x", "y", "a"]);
      expect(state.activeId).toBe("a");
    });

    it("does not open a table twice", () => {
      const open = openTableTab(undefined, "t1", "public", "people");
      expect(ids(restoreTabs(open, saved, ["x", "y"]) as TabsState)).toEqual(["x", "t1"]);
    });

    it("leaves the state alone when nothing was saved", () => {
      expect(restoreTabs(undefined, { tabs: [], active: 0 }, [])).toBeUndefined();
      const open = openSqlTab(undefined, "a");
      expect(restoreTabs(open, { tabs: [], active: 0 }, [])).toBe(open);
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
