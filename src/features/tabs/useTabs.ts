import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useToast } from "../../components/useToast";
import { savedTabs, saveTabs } from "../../lib/commands";
import { IpcError } from "../../lib/invoke";
import {
  activateTab,
  adoptSql,
  closeTab,
  openSqlTab,
  openTableTab,
  restoreTabs,
  setSql,
  setTableView,
  setUnsaved,
  shiftTab,
  toSaved,
  type TableView,
  type TabsState,
} from "./tabs";

/** Long enough that typing is one save, short enough that quitting loses little. */
const SAVE_DELAY_MS = 300;

export type TabsController = ReturnType<typeof useTabs>;

/** Every connection's tabs, kept while another connection is in front. */
export function useTabs() {
  const [byConnection, setByConnection] = useState<Record<string, TabsState>>({});
  const { show } = useToast();
  // A connection is saved only once what it had was read back: saving first
  // would replace the reader's drafts with whatever happened to be open.
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set());
  const loading = useRef(new Map<string, Promise<boolean>>());
  // What was last sent per connection, so that a render that changed nothing
  // kept sends nothing.
  const sent = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // One save per connection at a time: two in flight could commit in either
  // order, and the older one would be what a restart finds.
  const writing = useRef(new Map<string, Promise<unknown>>());

  function send(connectionId: string, json: string) {
    timers.current.delete(connectionId);
    const previous = writing.current.get(connectionId) ?? Promise.resolve();
    const next = previous
      .then(() => saveTabs(connectionId, JSON.parse(json)))
      .catch((error: unknown) => {
        // Deleted while the save was on its way.
        if (error instanceof IpcError && error.kind === "NotFound") return;
        sent.current.delete(connectionId);
        show(`Your tabs could not be saved: ${String(error)}`, "error");
      });
    writing.current.set(connectionId, next);
  }

  useEffect(() => {
    for (const connectionId of restored) {
      const json = JSON.stringify(toSaved(byConnection[connectionId]));
      if (sent.current.get(connectionId) === json) continue;
      sent.current.set(connectionId, json);
      clearTimeout(timers.current.get(connectionId));
      timers.current.set(
        connectionId,
        setTimeout(() => send(connectionId, json), SAVE_DELAY_MS),
      );
    }
  });

  // Quitting may not wait for the delay.
  const flush = useEffectEvent(() => {
    for (const [connectionId, timer] of timers.current) {
      clearTimeout(timer);
      const json = sent.current.get(connectionId);
      if (json !== undefined) send(connectionId, json);
    }
  });
  useEffect(() => {
    const onPageHide = () => flush();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  /**
   * Reads back what the connection had open, once. Resolves to whether the
   * connection is still wanted: it can be removed while its tabs are read.
   */
  function load(connectionId: string): Promise<boolean> {
    const pending = loading.current.get(connectionId);
    if (pending) return pending.then(() => loading.current.has(connectionId));
    const read: Promise<boolean> = savedTabs(connectionId).then(
      (saved) => {
        if (loading.current.get(connectionId) !== read) return false;
        const ids = saved.tabs.map(() => crypto.randomUUID());
        setByConnection((current) => {
          const next = restoreTabs(current[connectionId], saved, ids);
          return next ? { ...current, [connectionId]: next } : current;
        });
        sent.current.set(connectionId, JSON.stringify(saved));
        setRestored((current) => new Set(current).add(connectionId));
        return true;
      },
      (error: unknown) => {
        // Left out of `restored`, so what was kept is not overwritten.
        show(`Your tabs could not be restored: ${String(error)}`, "error");
        return loading.current.get(connectionId) === read;
      },
    );
    loading.current.set(connectionId, read);
    return read;
  }

  function write(connectionId: string, next: TabsState | null) {
    setByConnection((current) => {
      if (!next) {
        const { [connectionId]: _closed, ...rest } = current;
        return rest;
      }
      return { ...current, [connectionId]: next };
    });
  }

  // From the state being updated: an agent can hand over two statements before
  // the next render.
  function add(connectionId: string, update: (state: TabsState | undefined) => TabsState) {
    setByConnection((current) => ({ ...current, [connectionId]: update(current[connectionId]) }));
  }

  // From the state being updated, not this render's: otherwise two changes
  // before the next render would each start from the same tabs.
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
    /**
     * Brings back the connection's tabs from the last run, or opens a blank one
     * when there were none.
     */
    restore: (connectionId: string) => {
      // `load` settles either way.
      void load(connectionId).then((wanted) => {
        const id = crypto.randomUUID();
        if (wanted) add(connectionId, (state) => state ?? openSqlTab(undefined, id));
      });
    },
    open: (connectionId: string, sql?: string, title?: string) =>
      write(connectionId, openSqlTab(byConnection[connectionId], crypto.randomUUID(), sql, title)),
    /** A statement an agent handed over, marked as the agent's until adopted. */
    openFromAgent: (connectionId: string, sql: string, title?: string) => {
      // After what was saved, which goes first.
      void load(connectionId).then((wanted) => {
        const id = crypto.randomUUID();
        if (wanted) add(connectionId, (state) => openSqlTab(state, id, sql, title, true));
      });
    },
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
    adopt: (connectionId: string, id: string) =>
      change(connectionId, (state) => adoptSql(state, id)),
    readTable: (connectionId: string, id: string, view: Partial<TableView>) =>
      change(connectionId, (state) => setTableView(state, id, view)),
    markUnsaved: (connectionId: string, id: string, unsaved: boolean) =>
      change(connectionId, (state) => setUnsaved(state, id, unsaved)),
    /** Every connection with tabs open, whether or not it is the one in front. */
    connections: (): string[] => Object.keys(byConnection),
    /** The connection is gone, and what was kept went with it. */
    forget: (connectionId: string) => {
      clearTimeout(timers.current.get(connectionId));
      timers.current.delete(connectionId);
      sent.current.delete(connectionId);
      loading.current.delete(connectionId);
      setRestored((current) => {
        const next = new Set(current);
        next.delete(connectionId);
        return next;
      });
      write(connectionId, null);
    },
  };
}
