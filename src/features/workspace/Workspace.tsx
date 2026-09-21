import { QueryTabPane } from "../query/QueryTabPane";
import { TablePreviewPane } from "../table-preview/TablePreviewPane";
import { TabStrip } from "../tabs/TabStrip";
import type { TabsController } from "../tabs/useTabs";

type Props = {
  connectionId: string;
  tabs: TabsController;
  /** A name that could mean more than one table is handed to the palette. */
  onFindTable: (query: string) => void;
};

export function Workspace({ connectionId, tabs, onFindTable }: Props) {
  const state = tabs.of(connectionId);
  if (!state) return null;

  return (
    <>
      <TabStrip
        state={state}
        onActivate={(id) => tabs.activate(connectionId, id)}
        onClose={(id) => tabs.close(connectionId, id)}
        onOpen={() => tabs.open(connectionId)}
      />
      {state.tabs.map((tab) =>
        tab.kind === "sql" ? (
          <QueryTabPane
            key={tab.id}
            connectionId={connectionId}
            sql={tab.sql}
            hidden={tab.id !== state.activeId}
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
            hidden={tab.id !== state.activeId}
            onView={(view) => tabs.readTable(connectionId, tab.id, view)}
          />
        ),
      )}
    </>
  );
}
