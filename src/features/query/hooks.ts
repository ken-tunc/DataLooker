import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { QueryPlan } from "../../bindings/QueryPlan";
import type { QueryResult } from "../../bindings/QueryResult";
import { cancelQuery, executeQuery, explainQuery } from "../../lib/commands";
import { IpcError } from "../../lib/invoke";
import { historyKeys } from "../query-history/keys";
import { transactionKeys } from "../transaction/keys";

/** What the editor asks of the database: its statements' rows, or one's plan. */
export type Request =
  | { kind: "rows"; statements: string[] }
  | { kind: "plan"; sql: string; analyze: boolean };

/**
 * `results` holds one per statement that ran, in order. When the run stopped
 * short, `error` is why — what the server said, or a cancel — and it stopped
 * at the statement after the last result.
 */
export type Ran = {
  kind: "rows";
  statements: string[];
  results: QueryResult[];
  error: unknown;
};

export type Outcome = Ran | { kind: "plan"; plan: QueryPlan };

/**
 * One runner for rows and plans, so the results pane shows whichever came
 * last. Cancelling is a second command, sent with the id minted here.
 */
export function useQueryRunner(connectionId: string) {
  const runningId = useRef<string | null>(null);
  // Cancelling between two statements has nothing to cancel, so the next one
  // is told not to start.
  const stopped = useRef(false);
  const queryClient = useQueryClient();

  async function execute(sql: string) {
    const queryId = crypto.randomUUID();
    runningId.current = queryId;
    try {
      return await executeQuery(connectionId, sql, queryId);
    } finally {
      runningId.current = null;
    }
  }

  const run = useMutation({
    mutationFn: async (request: Request): Promise<Outcome> => {
      stopped.current = false;
      if (request.kind === "plan") {
        const queryId = crypto.randomUUID();
        runningId.current = queryId;
        try {
          const plan = await explainQuery(connectionId, request.sql, request.analyze, queryId);
          return { kind: "plan", plan };
        } finally {
          runningId.current = null;
        }
      }

      // One at a time on the reader's session, as a script would run: a
      // statement may need what the one before it did.
      const ran: Ran = { kind: "rows", statements: request.statements, results: [], error: null };
      for (const sql of request.statements) {
        if (stopped.current) {
          ran.error = new IpcError({ kind: "Cancelled" });
          break;
        }
        try {
          ran.results.push(await execute(sql));
        } catch (error) {
          ran.error = error;
          break;
        }
      }
      return ran;
    },
    // Every run is logged, and may have begun or ended a transaction,
    // whatever became of it. Not returned, or the mutation would stay pending
    // until the refetch came back.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: historyKeys.of(connectionId) });
      void queryClient.invalidateQueries({ queryKey: transactionKeys.of(connectionId) });
    },
  });

  function cancel() {
    stopped.current = true;
    if (runningId.current) void cancelQuery(runningId.current);
  }

  return { run, cancel };
}
