export const transactionKeys = {
  all: ["transaction"] as const,
  of: (connectionId: string) => [...transactionKeys.all, connectionId] as const,
};
