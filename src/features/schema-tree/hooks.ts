import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { schemaTree, tableColumns } from "../../lib/commands";
import { describeError } from "../../lib/invoke";
import type { ColumnsState, NamedTable } from "./rows";
import { schemaKeys } from "./keys";
import { tableRowId } from "./rows";

/** A schema changes far less often than the rows in it. */
const STALE_TIME = 5 * 60_000;

/** The tree as a query, for whoever reads it outside a render. */
export const schemaTreeQuery = (connectionId: string) => ({
  queryKey: schemaKeys.tree(connectionId),
  queryFn: () => schemaTree(connectionId),
  staleTime: STALE_TIME,
});

export function useSchemaTree(connectionId: string) {
  return useQuery(schemaTreeQuery(connectionId));
}

/** One query per table, so the cache answers wherever else it is opened. */
export function useColumnsOf(
  connectionId: string,
  tables: readonly NamedTable[],
): Map<string, ColumnsState> {
  // Combined inside `useQueries`, which hands back the same map until a result
  // changes: the tree is laid out again whenever it gets a new one, and the
  // window re-renders it on every keystroke in the editor.
  return useQueries({
    queries: tables.map(({ schema, table }) => ({
      queryKey: schemaKeys.columns(connectionId, schema, table),
      queryFn: () => tableColumns(connectionId, schema, table),
      staleTime: STALE_TIME,
    })),
    combine: (results) =>
      new Map(
        tables.map((named, at) => {
          const result = results[at];
          const state: ColumnsState =
            !result || result.isPending
              ? { status: "reading" }
              : result.isError
                ? { status: "failed", message: describeError(result.error) }
                : { status: "read", columns: result.data };
          return [tableRowId(named.schema, named.table), state];
        }),
      ),
  });
}

export function useRefreshSchemaTree(connectionId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: schemaKeys.of(connectionId) });
}
