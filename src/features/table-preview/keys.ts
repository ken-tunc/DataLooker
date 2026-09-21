import type { Sort } from "../../bindings/Sort";

export const previewKeys = {
  all: ["preview"] as const,
  page: (
    connectionId: string,
    schema: string,
    table: string,
    filter: string,
    sort: Sort | null,
    page: number,
  ) => [...previewKeys.all, connectionId, schema, table, filter, sort, page] as const,
};
