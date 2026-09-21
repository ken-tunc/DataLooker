import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TableEdits } from "../../bindings/TableEdits";
import { commitTableEdits, previewTable, tableShape } from "../../lib/commands";
import type { Tab } from "../tabs/tabs";
import { previewKeys } from "./keys";

export type TableTab = Extract<Tab, { kind: "table" }>;

/** A table's shape changes far less often than the rows in it. */
const SHAPE_STALE_TIME = 5 * 60_000;

export function useTableShape(connectionId: string, schema: string, table: string) {
  return useQuery({
    queryKey: previewKeys.shape(connectionId, schema, table),
    queryFn: () => tableShape(connectionId, schema, table),
    staleTime: SHAPE_STALE_TIME,
  });
}

export function useTablePreview(connectionId: string, tab: TableTab, editable: boolean) {
  return useQuery({
    queryKey: previewKeys.page(
      connectionId,
      tab.schema,
      tab.table,
      tab.filter,
      tab.sort,
      tab.page,
      editable,
    ),
    // Filtering, sorting and paging keep the rows on screen until the next
    // ones arrive, rather than blanking the grid between them.
    placeholderData: keepPreviousData,
    queryFn: () =>
      previewTable({
        connection_id: connectionId,
        schema: tab.schema,
        table: tab.table,
        filter: tab.filter,
        sort: tab.sort,
        page: tab.page,
        // Row versions are what an edit is checked against, and only a table
        // that can name its rows has anything to edit.
        versioned: editable,
        // The id registers the statement so that a cancel can reach it. Nothing
        // cancels a preview yet: React Query aborts a query whenever its key
        // changes or its component remounts, and turning those into a backend
        // cancel made the reader's own request fail.
        query_id: crypto.randomUUID(),
      }),
  });
}

export function useCommitEdits(connectionId: string, schema: string, table: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edits: TableEdits) => commitTableEdits(edits),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: previewKeys.table(connectionId, schema, table),
      }),
  });
}
