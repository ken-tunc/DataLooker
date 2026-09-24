import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteConnection,
  listConnections,
  reorderConnections,
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

/** Moves the rail at once rather than after the round trip, and back if the write fails. */
export function useReorderConnections() {
  const queryClient = useQueryClient();
  const key = connectionKeys.list();
  return useMutation({
    mutationFn: reorderConnections,
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<ConnectionRecord[]>(key);
      // As the backend does: one left out stays after those named.
      const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
      queryClient.setQueryData<ConnectionRecord[]>(
        key,
        (records) => records && [...records].sort((a, b) => rank(a.id) - rank(b.id)),
      );
      return { before };
    },
    onError: (_error, _ids, context) => queryClient.setQueryData(key, context?.before),
    onSettled: () => queryClient.invalidateQueries({ queryKey: connectionKeys.all }),
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
