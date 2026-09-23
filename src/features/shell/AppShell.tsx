import { useEffect, useState } from "react";
import { Splitter } from "../../components/Splitter";
import { type Pane, usePaneSize } from "../../lib/paneSize";
import { ConnectionHeader } from "../connections/ConnectionHeader";
import { ConnectionRail } from "../connections/ConnectionRail";
import { useConnections } from "../connections/hooks";
import { QueryHistoryPalette } from "../query-history/QueryHistoryPalette";
import { Workspace } from "../workspace/Workspace";
import { SchemaTree } from "../schema-tree/SchemaTree";
import { TableSearchPalette } from "../table-search/TableSearchPalette";
import { useTabs } from "../tabs/useTabs";

const SIDEBAR: Pane = { key: "datalooker.sidebar-width", initial: 288, min: 200, max: 640 };

/** Which palette is in front, if any. Only one can be: each is modal. */
type Palette = { kind: "tables"; query?: string } | { kind: "history" } | null;

/**
 * Holds what the rail and the workspace both need — which connection is in
 * front, and the tabs each one has open — and leaves the rest to them.
 */
export function AppShell() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [palette, setPalette] = useState<Palette>(null);
  const tabs = useTabs();
  const [sidebarWidth] = usePaneSize(SIDEBAR);

  function select(id: string) {
    setSelectedId(id);
    if (!tabs.of(id)) tabs.open(id);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!selectedId) return;
      // A palette is modal on screen, so the shortcuts behind it stay quiet
      // until it closes — a tab opened under it would go unnoticed.
      if (palette) return;
      // Opening a tab is what gets a connection out of having none, so it comes
      // before the shortcuts that need one.
      if (event.key === "t" && event.metaKey) {
        event.preventDefault();
        tabs.open(selectedId);
        return;
      }
      if (event.key === "o" && event.metaKey) {
        event.preventDefault();
        setPalette({ kind: "tables" });
        return;
      }
      if (event.key === "y" && event.metaKey) {
        event.preventDefault();
        setPalette({ kind: "history" });
        return;
      }
      if (event.key === "Tab" && event.ctrlKey) {
        event.preventDefault();
        tabs.shift(selectedId, event.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [palette, selectedId, tabs]);

  return (
    <div className="flex h-full">
      <ConnectionRail selectedId={selectedId} onSelect={select} />

      {selectedId && (
        <section
          className="hairline bg-base-100 flex shrink-0 flex-col border-r"
          style={{ width: sidebarWidth }}
        >
          <ConnectionHeader
            connectionId={selectedId}
            onRemoved={(id) => {
              setSelectedId(null);
              tabs.forget(id);
            }}
          />
          <SchemaTree
            key={selectedId}
            connectionId={selectedId}
            onOpenTable={(schema, table) => tabs.openTable(selectedId, schema, table)}
          />
        </section>
      )}
      {selectedId && <Splitter pane={SIDEBAR} axis="x" label="Resize the sidebar" />}

      {selectedId && palette?.kind === "tables" && (
        <TableSearchPalette
          connectionId={selectedId}
          initial={palette.query}
          onOpenTable={(schema, table) => tabs.openTable(selectedId, schema, table)}
          onClose={() => setPalette(null)}
        />
      )}

      {selectedId && palette?.kind === "history" && (
        <QueryHistoryPalette
          connectionId={selectedId}
          onOpenQuery={(sql) => tabs.open(selectedId, sql)}
          onClose={() => setPalette(null)}
        />
      )}

      <main className="bg-base-100 flex min-w-0 flex-1 flex-col">
        {tabs.connections().map((connectionId) => (
          <Workspace
            key={connectionId}
            connectionId={connectionId}
            tabs={tabs}
            hidden={connectionId !== selectedId}
            onFindTable={(query) => setPalette({ kind: "tables", query })}
          />
        ))}
        {!selectedId && <NothingInFront />}
      </main>
    </div>
  );
}

function NothingInFront() {
  const connections = useConnections();
  return (
    <div className="text-base-content/50 flex h-full items-center justify-center">
      {connections.data?.length === 0
        ? "Add a connection with + to start querying."
        : "Select a connection to start querying."}
    </div>
  );
}
