import { useQuery, useQueryClient } from "@tanstack/react-query";
import { schemaTree } from "../../lib/commands";
import { schemaKeys } from "./keys";

/** A schema changes far less often than the rows in it. */
const STALE_TIME = 5 * 60_000;

export function useSchemaTree(connectionId: string) {
  return useQuery({
    queryKey: schemaKeys.tree(connectionId),
    queryFn: () => schemaTree(connectionId),
    staleTime: STALE_TIME,
  });
}

export function useRefreshSchemaTree(connectionId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: schemaKeys.tree(connectionId) });
}
