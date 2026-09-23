import { DriverIcon } from "../connections/DriverIcon";
import { useConnections } from "../connections/hooks";
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
      <div className="hairline flex border-b">
        <ConnectionName connectionId={connectionId} />
        <TabStrip
          state={state}
          onActivate={(id) => tabs.activate(connectionId, id)}
          onClose={(id) => tabs.close(connectionId, id)}
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

/** Every tab in the strip is this connection's, so it is named once, ahead of them. */
function ConnectionName({ connectionId }: { connectionId: string }) {
  const connection = useConnections().data?.find(({ id }) => id === connectionId);
  if (!connection) return null;

  return (
    <div className="flex max-w-48 shrink-0 items-center gap-2 pr-2 pl-3 text-sm">
      <DriverIcon kind={connection.config.kind} />
      <span className="truncate">{connection.label}</span>
    </div>
  );
}
