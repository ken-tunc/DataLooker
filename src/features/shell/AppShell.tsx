import { useEffect, useState } from "react";
import { ConnectionSidebar } from "../connections/ConnectionSidebar";
import { Workspace } from "../workspace/Workspace";
import { SchemaTree } from "../schema-tree/SchemaTree";
import { useTabs } from "../tabs/useTabs";

/**
 * Holds what the sidebar and the workspace both need — which connection is in
 * front, and the tabs each one has open — and leaves the rest to them.
 */
export function AppShell() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tabs = useTabs();

  function select(id: string) {
    setSelectedId(id);
    if (!tabs.of(id)) tabs.open(id);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!selectedId) return;
      // Opening a tab is what gets a connection out of having none, so it comes
      // before the shortcuts that need one.
      if (event.key === "t" && event.metaKey) {
        event.preventDefault();
        tabs.open(selectedId);
        return;
      }
      if (event.key === "Tab" && event.ctrlKey) {
        event.preventDefault();
        tabs.shift(selectedId, event.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, tabs]);

  return (
    <div className="flex h-full">
      <ConnectionSidebar
        selectedId={selectedId}
        onSelect={select}
        onRemoved={(id) => {
          if (selectedId === id) setSelectedId(null);
          tabs.forget(id);
        }}
      />

      {selectedId && (
        <SchemaTree
          key={selectedId}
          connectionId={selectedId}
          onOpenTable={(schema, table) => tabs.openTable(selectedId, schema, table)}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {selectedId ? (
          <Workspace connectionId={selectedId} tabs={tabs} />
        ) : (
          <div className="text-base-content/50 flex h-full items-center justify-center">
            Select a connection to start querying.
          </div>
        )}
      </main>
    </div>
  );
}
