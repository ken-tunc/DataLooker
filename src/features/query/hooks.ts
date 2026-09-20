import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { cancelQuery, executeQuery } from "../../lib/commands";

/**
 * The id minted here is what the backend registers the running query under, so
 * cancelling is a second command rather than a property of this promise.
 */
export function useQueryRunner(connectionId: string) {
  const runningId = useRef<string | null>(null);

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
  });

  function cancel() {
    if (runningId.current) void cancelQuery(runningId.current);
  }

  return { run, cancel };
}
