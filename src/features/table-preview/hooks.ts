import { useQuery } from "@tanstack/react-query";
import { cancelQuery, previewTable } from "../../lib/commands";
import type { Tab } from "../tabs/tabs";
import { previewKeys } from "./keys";

type TableTab = Extract<Tab, { kind: "table" }>;

export function useTablePreview(connectionId: string, tab: TableTab) {
  return useQuery({
    queryKey: previewKeys.page(connectionId, tab.schema, tab.table, tab.filter, tab.sort, tab.page),
    queryFn: ({ signal }) => {
      const queryId = crypto.randomUUID();
      // React Query aborts a query the reader has navigated away from; the
      // backend knows the running statement by the id minted here.
      signal.addEventListener("abort", () => void cancelQuery(queryId));
      return previewTable({
        connection_id: connectionId,
        schema: tab.schema,
        table: tab.table,
        filter: tab.filter,
        sort: tab.sort,
        page: tab.page,
        query_id: queryId,
      });
    },
  });
}
