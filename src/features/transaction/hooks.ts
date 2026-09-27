import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { executeQuery, transactionState } from "../../lib/commands";
import { historyKeys } from "../query-history/keys";
import { transactionKeys } from "./keys";

/**
 * Asked again whenever a statement on the reader's session settles, which is
 * the only thing that moves it, so it never goes stale on its own.
 */
export function useTransactionState(connectionId: string) {
  return useQuery({
    queryKey: transactionKeys.of(connectionId),
    queryFn: () => transactionState(connectionId),
    staleTime: Infinity,
  });
}

/**
 * Runs as any statement the reader writes: on their session, and logged. Not
 * through the editor's runner, so the results on screen stay.
 */
export function useEndTransaction(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (statement: "COMMIT" | "ROLLBACK") =>
      executeQuery(connectionId, statement, crypto.randomUUID()),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: transactionKeys.of(connectionId) }),
        queryClient.invalidateQueries({ queryKey: historyKeys.of(connectionId) }),
      ]),
  });
}
