import { useState } from "react";
import { QueryTabPane } from "../query/QueryTabPane";
import { TablePreviewPane } from "../table-preview/TablePreviewPane";
import { DiscardChangesDialog } from "../tabs/DiscardChangesDialog";
import type { Tab } from "../tabs/tabs";
import { TabStrip } from "../tabs/TabStrip";
import type { TabsController } from "../tabs/useTabs";

type Props = {
  connectionId: string;
  tabs: TabsController;
  /**
   * A connection that is not in front keeps its workspace, hidden: what its
   * tabs hold — a result, an edit not yet saved — lives in the panes, and a
   * pane that unmounted would take it with it.
   */
  hidden: boolean;
  /** A name that could mean more than one table is handed to the palette. */
  onFindTable: (query: string) => void;
};

export function Workspace({ connectionId, tabs, hidden, onFindTable }: Props) {
  const [closing, setClosing] = useState<Tab | null>(null);
  const state = tabs.of(connectionId);
  if (!state) return null;

  function close(id: string) {
    const tab = state?.tabs.find((candidate) => candidate.id === id);
    if (tab?.kind === "table" && tab.unsaved) {
      setClosing(tab);
      return;
    }
    tabs.close(connectionId, id);
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${hidden ? "hidden" : ""}`}>
      <div data-tauri-drag-region="deep" className="hairline flex h-12 shrink-0 border-b">
        <TabStrip
          state={state}
          onActivate={(id) => tabs.activate(connectionId, id)}
          onClose={close}
          onOpen={() => tabs.open(connectionId)}
        />
      </div>
      {state.tabs.map((tab) =>
        tab.kind === "sql" ? (
          <QueryTabPane
            key={tab.id}
            connectionId={connectionId}
            tabId={tab.id}
            sql={tab.sql}
            hidden={hidden || tab.id !== state.activeId}
            onSqlChange={(sql) => tabs.writeSql(connectionId, tab.id, sql)}
            onOpenStructure={(schema, table) =>
              tabs.openTable(connectionId, schema, table, "structure")
            }
            onFindTable={onFindTable}
          />
        ) : (
          <TablePreviewPane
            key={tab.id}
            connectionId={connectionId}
            tab={tab}
            hidden={hidden || tab.id !== state.activeId}
            onView={(view) => tabs.readTable(connectionId, tab.id, view)}
            onUnsaved={(unsaved) => tabs.markUnsaved(connectionId, tab.id, unsaved)}
          />
        ),
      )}
      {closing && (
        <DiscardChangesDialog
          title={closing.title}
          onDiscard={() => {
            tabs.close(connectionId, closing.id);
            setClosing(null);
          }}
          onClose={() => setClosing(null)}
        />
      )}
    </div>
  );
}
