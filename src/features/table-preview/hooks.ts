import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { previewTable } from "../../lib/commands";
import type { Tab } from "../tabs/tabs";
import { previewKeys } from "./keys";

type TableTab = Extract<Tab, { kind: "table" }>;

export function useTablePreview(connectionId: string, tab: TableTab) {
  return useQuery({
    queryKey: previewKeys.page(connectionId, tab.schema, tab.table, tab.filter, tab.sort, tab.page),
    // Filtering, sorting and paging keep the rows on screen until the next
    // ones arrive, rather than blanking the grid between them.
    placeholderData: keepPreviousData,
    queryFn: () => {
      // The id registers the statement so that a cancel can reach it. Nothing
      // cancels a preview yet: React Query aborts a query whenever its key
      // changes or its component remounts, and turning those into a backend
      // cancel made the reader's own request fail.
      const queryId = crypto.randomUUID();
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
