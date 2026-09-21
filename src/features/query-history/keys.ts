export const historyKeys = {
  all: ["history"] as const,
  of: (connectionId: string) => [...historyKeys.all, connectionId] as const,
};
