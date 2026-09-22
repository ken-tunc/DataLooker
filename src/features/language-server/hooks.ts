import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { installLanguageServer, languageServerState } from "../../lib/commands";
import { startServerAgain } from "../../lib/lsp/client";
import { serverKeys } from "./keys";

/** A server is installed or it is not; what changes that is asking for one. */
const STALE_TIME = 5 * 60_000;

export function useLanguageServerState(connectionId: string) {
  return useQuery({
    queryKey: serverKeys.state(connectionId),
    queryFn: () => languageServerState(connectionId),
    staleTime: STALE_TIME,
  });
}

export function useInstallLanguageServer(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => installLanguageServer(connectionId),
    // The editors of this connection asked for a server once and were told
    // there was none. There is one now.
    onSuccess: () => startServerAgain(connectionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: serverKeys.of(connectionId) }),
  });
}
