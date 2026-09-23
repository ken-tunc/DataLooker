import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteConnection,
  listConnections,
  saveConnection,
  testConnection,
} from "../../lib/commands";
import { schemaKeys } from "../schema-tree/keys";
import { connectionKeys } from "./keys";

export function useConnections() {
  return useQuery({ queryKey: connectionKeys.list(), queryFn: listConnections });
}

export function useSaveConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveConnection,
    // What a connection holds is read as the connection was, and a save can
    // point it at another database or give it other credentials.
    onSuccess: (id) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: connectionKeys.all }),
        queryClient.invalidateQueries({ queryKey: schemaKeys.of(id) }),
      ]),
  });
}

export function useDeleteConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectionKeys.all }),
  });
}

export function useTestConnection() {
  return useMutation({ mutationFn: testConnection });
}
