import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { cancelQuery, executeQuery } from "../../lib/commands";
import { historyKeys } from "../query-history/keys";

/**
 * The id minted here is what the backend registers the running query under, so
 * cancelling is a second command rather than a property of this promise.
 */
export function useQueryRunner(connectionId: string) {
  const runningId = useRef<string | null>(null);
  const queryClient = useQueryClient();

  const run = useMutation({
    mutationFn: async (sql: string) => {
      const queryId = crypto.randomUUID();
      runningId.current = queryId;
      try {
        return await executeQuery(connectionId, sql, queryId);
      } finally {
        runningId.current = null;
      }
    },
    // The backend logs a run whatever became of it, so the history the palette
    // shows is stale either way. Returning the promise would hold the mutation
    // open until the refetch came back, and the editor would still be saying
    // the query is running.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: historyKeys.of(connectionId) });
    },
  });

  function cancel() {
    if (runningId.current) void cancelQuery(runningId.current);
  }

  return { run, cancel };
}
