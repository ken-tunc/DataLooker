import type { Sort } from "../../bindings/Sort";

export const previewKeys = {
  all: ["preview"] as const,
  table: (connectionId: string, schema: string, table: string) =>
    [...previewKeys.all, connectionId, schema, table] as const,
  shape: (connectionId: string, schema: string, table: string) =>
    [...previewKeys.table(connectionId, schema, table), "shape"] as const,
  definition: (connectionId: string, schema: string, table: string) =>
    [...previewKeys.table(connectionId, schema, table), "definition"] as const,
  page: (
    connectionId: string,
    schema: string,
    table: string,
    filter: string,
    sort: Sort | null,
    page: number,
    versioned: boolean,
    asOf: string | null,
  ) =>
    [
      ...previewKeys.table(connectionId, schema, table),
      "page",
      filter,
      sort,
      page,
      versioned,
      asOf,
    ] as const,
  cost: (
    connectionId: string,
    schema: string,
    table: string,
    filter: string,
    sort: Sort | null,
    asOf: string,
  ) => [...previewKeys.table(connectionId, schema, table), "cost", filter, sort, asOf] as const,
};
