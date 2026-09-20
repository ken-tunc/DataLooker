import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A failing query is usually a database or connection error; retrying it
      // silently just delays the message the user needs to see.
      retry: false,
      staleTime: 30_000,
    },
  },
});
