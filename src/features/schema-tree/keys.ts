export const schemaKeys = {
  all: ["schema"] as const,
  tree: (connectionId: string) => [...schemaKeys.all, "tree", connectionId] as const,
  columns: (connectionId: string, schema: string, table: string) =>
    [...schemaKeys.all, "columns", connectionId, schema, table] as const,
};
