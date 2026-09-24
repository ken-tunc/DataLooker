import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { cancelQuery, executeQuery } from "../../lib/commands";
import { historyKeys } from "../query-history/keys";

/** Cancelling is a second command, sent with the id minted here. */
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
    // Every run is logged, whatever became of it. Not returned, or the
    // mutation would stay pending until the refetch came back.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: historyKeys.of(connectionId) });
    },
  });

  function cancel() {
    if (runningId.current) void cancelQuery(runningId.current);
  }

  return { run, cancel };
}
