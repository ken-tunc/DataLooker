import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteTemplate, listTemplates, saveTemplate } from "../../lib/commands";
import { templateKeys } from "./keys";

export function useTemplates() {
  return useQuery({ queryKey: templateKeys.all, queryFn: listTemplates });
}

export function useSaveTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveTemplate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: templateKeys.all }),
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: templateKeys.all }),
  });
}
