export const serverKeys = {
  all: ["language-server"] as const,
  of: (connectionId: string) => [...serverKeys.all, connectionId] as const,
  state: (connectionId: string) => [...serverKeys.of(connectionId), "state"] as const,
};
