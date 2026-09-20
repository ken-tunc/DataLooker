import { useEffect, useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { ConnectionFormDialog } from "../connections/ConnectionFormDialog";
import { ConnectionSidebar } from "../connections/ConnectionSidebar";
import { DeleteConnectionDialog } from "../connections/DeleteConnectionDialog";
import type { FormMode } from "../connections/form";
import { useConnections, useDeleteConnection, useTestConnection } from "../connections/hooks";
import { QueryTabPane } from "../query/QueryTabPane";
import { SqlTabs } from "../sql-tabs/SqlTabs";
import { activateTab, closeTab, openTab, setSql, shiftTab, type TabsState } from "../sql-tabs/tabs";

type Editing = { mode: FormMode; source: ConnectionRecord | null };

export function AppShell() {
  const { show } = useToast();
  const connections = useConnections();
  const remove = useDeleteConnection();
  const test = useTestConnection();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<ConnectionRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Tabs belong to the connection, so switching back finds the same queries.
  const [tabsByConnection, setTabsByConnection] = useState<Record<string, TabsState>>({});

  const selected = connections.data?.find((c) => c.id === selectedId) ?? null;
  const tabs = selectedId ? tabsByConnection[selectedId] : undefined;

  function updateTabs(connectionId: string, next: TabsState | null) {
    setTabsByConnection((current) => {
      if (!next) {
        const { [connectionId]: _closed, ...rest } = current;
        return rest;
      }
      return { ...current, [connectionId]: next };
    });
  }

  function select(connection: ConnectionRecord) {
    setSelectedId(connection.id);
    if (!tabsByConnection[connection.id]) {
      updateTabs(connection.id, openTab(undefined, crypto.randomUUID()));
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!selectedId) return;
      const state = tabsByConnection[selectedId];
      // Opening a tab is what gets a connection out of having none, so it comes
      // before the shortcuts that need one.
      if (event.key === "t" && event.metaKey) {
        event.preventDefault();
        updateTabs(selectedId, openTab(state, crypto.randomUUID()));
        return;
      }
      if (!state) return;
      if (event.key === "Tab" && event.ctrlKey) {
        event.preventDefault();
        updateTabs(selectedId, shiftTab(state, event.shiftKey ? -1 : 1));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, tabsByConnection]);

  function runTest(connection: ConnectionRecord) {
    test.mutate(connection.id, {
      onSuccess: (elapsedMs) => show(`Reached ${connection.label} in ${elapsedMs} ms`, "success"),
      onError: (error) => show(describeError(error), "error"),
    });
  }

  function confirmDelete(connection: ConnectionRecord) {
    remove.mutate(connection.id, {
      onSuccess: () => {
        show(`Deleted ${connection.label}`, "success");
        setDeleting(null);
        if (selectedId === connection.id) setSelectedId(null);
        updateTabs(connection.id, null);
      },
      onError: (error) => show(describeError(error), "error"),
    });
  }

  return (
    <div className="flex h-full">
      <aside className="border-base-300 bg-base-200 flex w-64 shrink-0 flex-col border-r">
        <header className="flex items-center justify-between p-3">
          <h1 className="font-semibold">Connections</h1>
          <button
            type="button"
            className="btn btn-primary btn-xs"
            onClick={() => setEditing({ mode: "new", source: null })}
          >
            New
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {connections.isPending && <SidebarSkeleton />}

          {connections.isError && (
            <div role="alert" className="alert alert-error m-2 text-sm">
              <span>{describeError(connections.error)}</span>
              <button type="button" className="btn btn-xs" onClick={() => connections.refetch()}>
                Retry
              </button>
            </div>
          )}

          {connections.data?.length === 0 && (
            <p className="text-base-content/60 p-3 text-sm">No connections yet.</p>
          )}

          {connections.data && connections.data.length > 0 && (
            <ConnectionSidebar
              connections={connections.data}
              selectedId={selectedId}
              testingId={test.isPending ? (test.variables ?? null) : null}
              onSelect={select}
              onTest={runTest}
              onEdit={(source) => setEditing({ mode: "edit", source })}
              onDuplicate={(source) => setEditing({ mode: "duplicate", source })}
              onDelete={setDeleting}
            />
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {selected && tabs ? (
          <>
            <SqlTabs
              state={tabs}
              onActivate={(id) => updateTabs(selected.id, activateTab(tabs, id))}
              onClose={(id) => updateTabs(selected.id, closeTab(tabs, id))}
              onOpen={() => updateTabs(selected.id, openTab(tabs, crypto.randomUUID()))}
            />
            {tabs.tabs.map((tab) => (
              <QueryTabPane
                key={tab.id}
                connection={selected}
                sql={tab.sql}
                hidden={tab.id !== tabs.activeId}
                onSqlChange={(sql) => updateTabs(selected.id, setSql(tabs, tab.id, sql))}
              />
            ))}
          </>
        ) : (
          <div className="text-base-content/50 flex h-full items-center justify-center">
            Select a connection to start querying.
          </div>
        )}
      </main>

      {editing && (
        <ConnectionFormDialog
          mode={editing.mode}
          source={editing.source}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <DeleteConnectionDialog
          connection={deleting}
          pending={remove.isPending}
          onConfirm={() => confirmDelete(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {["one", "two", "three"].map((row) => (
        <div key={row} className="skeleton h-9 w-full" />
      ))}
    </div>
  );
}
