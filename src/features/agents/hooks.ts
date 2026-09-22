import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentAccess, setAgentAccess } from "../../lib/commands";
import { agentKeys } from "./keys";

export function useAgentAccess() {
  return useQuery({ queryKey: agentKeys.access(), queryFn: agentAccess });
}

export function useSetAgentAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setAgentAccess,
    // What comes back is how it now stands, including the port the system
    // gave — which is what the reader hands to an agent.
    onSuccess: (access) => queryClient.setQueryData(agentKeys.access(), access),
  });
}
