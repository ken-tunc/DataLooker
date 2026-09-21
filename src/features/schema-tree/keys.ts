/**
 * Everything read out of one connection's schema sits under its id, so that
 * reading it again drops the columns of its tables as well as its tree — a
 * schema that changed changes both.
 */
export const schemaKeys = {
  all: ["schema"] as const,
  of: (connectionId: string) => [...schemaKeys.all, connectionId] as const,
  tree: (connectionId: string) => [...schemaKeys.of(connectionId), "tree"] as const,
  columns: (connectionId: string, schema: string, table: string) =>
    [...schemaKeys.of(connectionId), "columns", schema, table] as const,
};
