export const schemaKeys = {
  all: ["schema"] as const,
  tree: (connectionId: string) => [...schemaKeys.all, "tree", connectionId] as const,
};
