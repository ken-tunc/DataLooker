import type { SqlTabsController } from "../sql-tabs/useSqlTabs";
import { SqlTabs } from "../sql-tabs/SqlTabs";
import { QueryTabPane } from "./QueryTabPane";

type Props = {
  connectionId: string;
  tabs: SqlTabsController;
};

export function QueryWorkspace({ connectionId, tabs }: Props) {
  const state = tabs.of(connectionId);
  if (!state) return null;

  return (
    <>
      <SqlTabs
        state={state}
        onActivate={(id) => tabs.activate(connectionId, id)}
        onClose={(id) => tabs.close(connectionId, id)}
        onOpen={() => tabs.open(connectionId)}
      />
      {state.tabs.map((tab) => (
        <QueryTabPane
          key={tab.id}
          connectionId={connectionId}
          sql={tab.sql}
          hidden={tab.id !== state.activeId}
          onSqlChange={(sql) => tabs.writeSql(connectionId, tab.id, sql)}
        />
      ))}
    </>
  );
}
