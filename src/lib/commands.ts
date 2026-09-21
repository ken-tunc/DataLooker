import type { ConnectionRecord } from "../bindings/ConnectionRecord";
import type { QueryResult } from "../bindings/QueryResult";
import type { PreviewRequest } from "../bindings/PreviewRequest";
import type { SchemaTree } from "../bindings/SchemaTree";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";
import { invoke } from "./invoke";

export function appVersion(): Promise<string> {
  return invoke<string>("app_version");
}

export function listConnections(): Promise<ConnectionRecord[]> {
  return invoke<ConnectionRecord[]>("list_connections");
}

export function saveConnection(input: SaveConnectionInput): Promise<string> {
  return invoke<string>("save_connection", { input });
}

export function deleteConnection(id: string): Promise<void> {
  return invoke<void>("delete_connection", { id });
}

/** Resolves to how long reaching the server took, in milliseconds. */
export function testConnection(id: string): Promise<number> {
  return invoke<number>("test_connection", { id });
}

/** `queryId` is the caller's handle on the running query — `cancelQuery` takes the same one. */
export function executeQuery(
  connectionId: string,
  sql: string,
  queryId: string,
): Promise<QueryResult> {
  return invoke<QueryResult>("execute_query", { connectionId, sql, queryId });
}

export function cancelQuery(queryId: string): Promise<void> {
  return invoke<void>("cancel_query", { queryId });
}

export function schemaTree(connectionId: string): Promise<SchemaTree> {
  return invoke<SchemaTree>("schema_tree", { connectionId });
}

export function previewTable(request: PreviewRequest): Promise<QueryResult> {
  return invoke<QueryResult>("preview_table", { request });
}
