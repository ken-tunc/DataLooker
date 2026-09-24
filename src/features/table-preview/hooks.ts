import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TableEdits } from "../../bindings/TableEdits";
import { commitTableEdits, previewTable, tableDefinition, tableShape } from "../../lib/commands";
import type { Tab } from "../tabs/tabs";
import { previewKeys } from "./keys";

export type TableTab = Extract<Tab, { kind: "table" }>;

/** A table's shape changes far less often than the rows in it. */
const SHAPE_STALE_TIME = 5 * 60_000;

export function useTableShape(connectionId: string, schema: string, table: string, ready: boolean) {
  return useQuery({
    enabled: ready,
    queryKey: previewKeys.shape(connectionId, schema, table),
    queryFn: () => tableShape(connectionId, schema, table),
    staleTime: SHAPE_STALE_TIME,
  });
}

export function useTableDefinition(
  connectionId: string,
  schema: string,
  table: string,
  ready: boolean,
) {
  return useQuery({
    enabled: ready,
    queryKey: previewKeys.definition(connectionId, schema, table),
    queryFn: () => tableDefinition(connectionId, schema, table),
    staleTime: SHAPE_STALE_TIME,
  });
}

/**
 * `ready` waits for the shape, which decides whether rows are read with their
 * versions; otherwise the page would be read twice.
 */
export function useTablePreview(
  connectionId: string,
  tab: TableTab,
  editable: boolean,
  ready: boolean,
) {
  return useQuery({
    enabled: ready,
    queryKey: previewKeys.page(
      connectionId,
      tab.schema,
      tab.table,
      tab.filter,
      tab.sort,
      tab.page,
      editable,
    ),
    // Keep the rows on screen until the next ones arrive.
    placeholderData: keepPreviousData,
    queryFn: () =>
      previewTable({
        connection_id: connectionId,
        schema: tab.schema,
        table: tab.table,
        filter: tab.filter,
        sort: tab.sort,
        page: tab.page,
        versioned: editable,
        // React Query's abort signal is not wired to a backend cancel: it fires
        // on every key change and remount, which would cancel the reader's own
        // request.
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
