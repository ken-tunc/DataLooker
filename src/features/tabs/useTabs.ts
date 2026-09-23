import { useState } from "react";
import {
  activateTab,
  closeTab,
  openSqlTab,
  openTableTab,
  setSql,
  setTableView,
  setUnsaved,
  shiftTab,
  type TableView,
  type TabsState,
} from "./tabs";

export type TabsController = ReturnType<typeof useTabs>;

/**
 * The open tabs of every connection. They outlive the window that shows them,
 * so that switching connections and coming back finds the same queries.
 */
export function useTabs() {
  const [byConnection, setByConnection] = useState<Record<string, TabsState>>({});

  function write(connectionId: string, next: TabsState | null) {
    setByConnection((current) => {
      if (!next) {
        const { [connectionId]: _closed, ...rest } = current;
        return rest;
      }
      return { ...current, [connectionId]: next };
    });
  }

  // Read from the state being updated rather than the one this render saw:
  // two changes before the next render would otherwise each start from the
  // same tabs, and the second would undo the first.
  function change(connectionId: string, update: (state: TabsState) => TabsState | null) {
    setByConnection((current) => {
      const state = current[connectionId];
      if (!state) return current;
      const next = update(state);
      if (next === state) return current;
      if (!next) {
        const { [connectionId]: _closed, ...rest } = current;
        return rest;
      }
      return { ...current, [connectionId]: next };
    });
  }

  return {
    of: (connectionId: string): TabsState | undefined => byConnection[connectionId],
    open: (connectionId: string, sql?: string) =>
      write(connectionId, openSqlTab(byConnection[connectionId], crypto.randomUUID(), sql)),
    openTable: (connectionId: string, schema: string, table: string, shows?: TableView["shows"]) =>
      write(
        connectionId,
        openTableTab(byConnection[connectionId], crypto.randomUUID(), schema, table, shows),
      ),
    close: (connectionId: string, id: string) =>
      change(connectionId, (state) => closeTab(state, id)),
    activate: (connectionId: string, id: string) =>
      change(connectionId, (state) => activateTab(state, id)),
    shift: (connectionId: string, by: number) =>
      change(connectionId, (state) => shiftTab(state, by)),
    writeSql: (connectionId: string, id: string, sql: string) =>
      change(connectionId, (state) => setSql(state, id, sql)),
    readTable: (connectionId: string, id: string, view: Partial<TableView>) =>
      change(connectionId, (state) => setTableView(state, id, view)),
    markUnsaved: (connectionId: string, id: string, unsaved: boolean) =>
      change(connectionId, (state) => setUnsaved(state, id, unsaved)),
    /** Every connection with tabs open, whether or not it is the one in front. */
    connections: (): string[] => Object.keys(byConnection),
    forget: (connectionId: string) => write(connectionId, null),
  };
}
