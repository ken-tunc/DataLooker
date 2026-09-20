import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteConnection, listConnections, saveConnection } from "../../lib/commands";
import { connectionKeys } from "./keys";

export function useConnections() {
  return useQuery({ queryKey: connectionKeys.list(), queryFn: listConnections });
}

export function useSaveConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveConnection,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectionKeys.all }),
  });
}

export function useDeleteConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectionKeys.all }),
  });
}
