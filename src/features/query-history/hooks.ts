import { useQuery } from "@tanstack/react-query";
import { queryHistory } from "../../lib/commands";
import { historyKeys } from "./keys";

export function useQueryHistory(connectionId: string) {
  return useQuery({
    queryKey: historyKeys.of(connectionId),
    queryFn: () => queryHistory(connectionId),
  });
}
