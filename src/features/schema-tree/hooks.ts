import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { schemaTree, tableColumns } from "../../lib/commands";
import { describeError } from "../../lib/invoke";
import type { ColumnsState, NamedTable } from "./rows";
import { schemaKeys } from "./keys";
import { tableRowId } from "./rows";

/** A schema changes far less often than the rows in it. */
const STALE_TIME = 5 * 60_000;

export function useSchemaTree(connectionId: string) {
  return useQuery({
    queryKey: schemaKeys.tree(connectionId),
    queryFn: () => schemaTree(connectionId),
    staleTime: STALE_TIME,
  });
}

/**
 * The columns of every table that is open, by the row that opened it. One
 * query each rather than one for all of them: a table's columns are the same
 * answer wherever they are asked for, and the cache is what keeps a table
 * opened twice from being read twice.
 */
export function useColumnsOf(
  connectionId: string,
  tables: readonly NamedTable[],
): Map<string, ColumnsState> {
  const results = useQueries({
    queries: tables.map(({ schema, table }) => ({
      queryKey: schemaKeys.columns(connectionId, schema, table),
      queryFn: () => tableColumns(connectionId, schema, table),
      staleTime: STALE_TIME,
    })),
  });

  return new Map(
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
  );
}

export function useRefreshSchemaTree(connectionId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: schemaKeys.of(connectionId) });
}
