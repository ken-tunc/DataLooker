import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { QueryPlan } from "../../bindings/QueryPlan";
import type { QueryResult } from "../../bindings/QueryResult";
import { cancelQuery, executeQuery, explainQuery } from "../../lib/commands";
import { historyKeys } from "../query-history/keys";

/** What the editor asks of the database: its rows, or its plan. */
export type Request = { sql: string; explain: "plan" | "analyze" | null };

export type Outcome = { kind: "rows"; result: QueryResult } | { kind: "plan"; plan: QueryPlan };

/**
 * One runner for rows and plans, so the results pane shows whichever came
 * last. Cancelling is a second command, sent with the id minted here.
 */
export function useQueryRunner(connectionId: string) {
  const runningId = useRef<string | null>(null);
  const queryClient = useQueryClient();

  const run = useMutation({
    mutationFn: async ({ sql, explain }: Request): Promise<Outcome> => {
      const queryId = crypto.randomUUID();
      runningId.current = queryId;
      try {
        if (explain === null) {
          return { kind: "rows", result: await executeQuery(connectionId, sql, queryId) };
        }
        const analyze = explain === "analyze";
        return { kind: "plan", plan: await explainQuery(connectionId, sql, analyze, queryId) };
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
