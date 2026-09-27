import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { Handoff } from "../../bindings/Handoff";
import type { QueryTemplate } from "../../bindings/QueryTemplate";
import { Splitter } from "../../components/Splitter";
import { subscribe } from "../../lib/events";
import { type Pane, usePaneSize } from "../../lib/paneSize";
import { useCommandsFollowSelection } from "../connection-command/hooks";
import { ConnectionHeader } from "../connections/ConnectionHeader";
import { ConnectionRail } from "../connections/ConnectionRail";
import { useConnections } from "../connections/hooks";
import { QueryHistoryPalette } from "../query-history/QueryHistoryPalette";
import { FillTemplateDialog } from "../query-templates/FillTemplateDialog";
import { TemplatePalette } from "../query-templates/TemplatePalette";
import { TemplatesDialog } from "../query-templates/TemplatesDialog";
import { Workspace } from "../workspace/Workspace";
import { SchemaTree } from "../schema-tree/SchemaTree";
import { isHelpKey } from "../shortcuts/shortcuts";
import { ShortcutsDialog } from "../shortcuts/ShortcutsDialog";
import { TableSearchPalette } from "../table-search/TableSearchPalette";
import { useTabs } from "../tabs/useTabs";

const SIDEBAR: Pane = { key: "datalooker.sidebar-width", initial: 288, min: 200, max: 640 };

/** Which modal is in front, if any. Only one can be. */
type Modal =
  | { kind: "tables"; query?: string }
  | { kind: "history" }
  | { kind: "templates" }
  | { kind: "fill"; template: QueryTemplate }
  | { kind: "manage-templates" }
  | { kind: "shortcuts" }
  | null;

/** Holds only what the rail and the workspace share. */
export function AppShell() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const tabs = useTabs();
  const [sidebarWidth] = usePaneSize(SIDEBAR);
  const followSelection = useCommandsFollowSelection();

  // Two handoffs can arrive before the next render, and the second must not
  // start from the selection the first replaced.
  const front = useRef<string | null>(null);
  function bringForward(id: string) {
    followSelection(front.current, id);
    front.current = id;
    setSelectedId(id);
  }

  function select(id: string) {
    bringForward(id);
    tabs.restore(id);
  }

  // The connection comes to the front with it: the backend has brought the
  // window forward for this statement, not for whatever was in front.
  const receive = useEffectEvent((handoff: Handoff) => {
    bringForward(handoff.connection_id);
    tabs.openFromAgent(handoff.connection_id, handoff.sql, handoff.title ?? undefined);
  });
  useEffect(() => subscribe("agent:handoff", receive), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A tab opened under a modal would go unnoticed.
      if (modal) return;
      if (isHelpKey(event)) {
        event.preventDefault();
        setModal({ kind: "shortcuts" });
        return;
      }
      if (!selectedId) return;
      // Before the shortcuts that need a connection: this is how one gets a tab.
      if (event.key === "t" && event.metaKey) {
        event.preventDefault();
        tabs.open(selectedId);
        return;
      }
      if (event.key === "o" && event.metaKey) {
        event.preventDefault();
        setModal({ kind: "tables" });
        return;
      }
      if (event.key === "y" && event.metaKey) {
        event.preventDefault();
        setModal({ kind: "history" });
        return;
      }
      if (event.key === "j" && event.metaKey) {
        event.preventDefault();
        setModal({ kind: "templates" });
        return;
      }
      if (event.key === "Tab" && event.ctrlKey) {
        event.preventDefault();
        tabs.shift(selectedId, event.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modal, selectedId, tabs]);

  return (
    <div className="flex h-full">
      <ConnectionRail
        selectedId={selectedId}
        onSelect={select}
        onShowShortcuts={() => setModal({ kind: "shortcuts" })}
      />

      {selectedId && (
        <section
          className="hairline bg-base-100 flex shrink-0 flex-col border-r"
          style={{ width: sidebarWidth }}
        >
          <ConnectionHeader
            connectionId={selectedId}
            onRemoved={(id) => {
              front.current = null;
              setSelectedId(null);
              tabs.forget(id);
            }}
          />
          <SchemaTree
            key={selectedId}
            connectionId={selectedId}
            onOpenTable={(schema, table) => tabs.openTable(selectedId, schema, table)}
            onOpenRoutine={(schema, name, args) => tabs.openRoutine(selectedId, schema, name, args)}
          />
        </section>
      )}
      {selectedId && <Splitter pane={SIDEBAR} axis="x" label="Resize the sidebar" />}

      {selectedId && modal?.kind === "tables" && (
        <TableSearchPalette
          connectionId={selectedId}
          initial={modal.query}
          onOpenTable={(schema, table) => tabs.openTable(selectedId, schema, table)}
          onClose={() => setModal(null)}
        />
      )}

      {selectedId && modal?.kind === "history" && (
        <QueryHistoryPalette
          connectionId={selectedId}
          onOpenQuery={(sql) => tabs.open(selectedId, sql)}
          onClose={() => setModal(null)}
        />
      )}

      {selectedId && modal?.kind === "templates" && (
        <TemplatePalette
          connectionId={selectedId}
          onOpenQuery={(title, sql) => tabs.open(selectedId, sql, title)}
          onFill={(template) => setModal({ kind: "fill", template })}
          onManage={() => setModal({ kind: "manage-templates" })}
          onClose={() => setModal(null)}
        />
      )}

      {selectedId && modal?.kind === "fill" && (
        <FillTemplateDialog
          connectionId={selectedId}
          template={modal.template}
          onFill={(sql) => tabs.open(selectedId, sql, modal.template.name)}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === "manage-templates" && <TemplatesDialog onClose={() => setModal(null)} />}

      {modal?.kind === "shortcuts" && <ShortcutsDialog onClose={() => setModal(null)} />}

      <main className="bg-base-100 flex min-w-0 flex-1 flex-col">
        {tabs.connections().map((connectionId) => (
          <Workspace
            key={connectionId}
            connectionId={connectionId}
            tabs={tabs}
            hidden={connectionId !== selectedId}
            onFindTable={(query) => setModal({ kind: "tables", query })}
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
    <div className="text-faint flex h-full items-center justify-center">
      {connections.data?.length === 0
        ? "Add a connection with + to start querying."
        : "Select a connection to start querying."}
    </div>
  );
}
