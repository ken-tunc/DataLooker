import { useState } from "react";
import { activateTab, closeTab, openTab, setSql, shiftTab, type TabsState } from "./tabs";

export type SqlTabsController = ReturnType<typeof useSqlTabs>;

/**
 * The open tabs of every connection. They outlive the window that shows them,
 * so that switching connections and coming back finds the same queries.
 */
export function useSqlTabs() {
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

  function change(connectionId: string, update: (state: TabsState) => TabsState | null) {
    const state = byConnection[connectionId];
    if (state) write(connectionId, update(state));
  }

  return {
    of: (connectionId: string): TabsState | undefined => byConnection[connectionId],
    open: (connectionId: string) =>
      write(connectionId, openTab(byConnection[connectionId], crypto.randomUUID())),
    close: (connectionId: string, id: string) =>
      change(connectionId, (state) => closeTab(state, id)),
    activate: (connectionId: string, id: string) =>
      change(connectionId, (state) => activateTab(state, id)),
    shift: (connectionId: string, by: number) =>
      change(connectionId, (state) => shiftTab(state, by)),
    writeSql: (connectionId: string, id: string, sql: string) =>
      change(connectionId, (state) => setSql(state, id, sql)),
    forget: (connectionId: string) => write(connectionId, null),
  };
}
