import type { ConnectionRecord } from "../bindings/ConnectionRecord";
import type { QueryResult } from "../bindings/QueryResult";
import type { PreviewRequest } from "../bindings/PreviewRequest";
import type { TableEdits } from "../bindings/TableEdits";
import type { TablePage } from "../bindings/TablePage";
import type { TableShape } from "../bindings/TableShape";
import type { Column } from "../bindings/Column";
import type { Completion } from "../bindings/Completion";
import type { SchemaTree } from "../bindings/SchemaTree";
import type { TableDefinition } from "../bindings/TableDefinition";
import type { SyntaxError } from "../bindings/SyntaxError";
import type { AgentAccess } from "../bindings/AgentAccess";
import type { HistoryEntry } from "../bindings/HistoryEntry";
import type { LanguageServerState } from "../bindings/LanguageServerState";
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

/** What PostgreSQL would refuse to parse. Needs no connection: the grammar is built in. */
export function checkSyntax(sql: string): Promise<SyntaxError[]> {
  return invoke<SyntaxError[]>("check_syntax", { sql });
}

/** The statements run against this connection, newest first. */
export function queryHistory(connectionId: string): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("query_history", { connectionId });
}

/** What a connection holds: its schemas and their tables, but not their columns. */
export function schemaTree(connectionId: string): Promise<SchemaTree> {
  return invoke<SchemaTree>("schema_tree", { connectionId });
}

/** What one table holds, asked for when the table is opened. */
export function tableColumns(
  connectionId: string,
  schema: string,
  table: string,
): Promise<Column[]> {
  return invoke<Column[]>("table_columns", { connectionId, schema, table });
}

/** The `CREATE` statement PostgreSQL's catalogs describe, and what stands beside it. */
export function tableDefinition(
  connectionId: string,
  schema: string,
  table: string,
): Promise<TableDefinition> {
  return invoke<TableDefinition>("table_definition", { connectionId, schema, table });
}

/**
 * Start the connection's command — a port forward, a tunnel — and leave it
 * running. It ends when it is stopped, when it fails, or when the app quits.
 */
export function runConnectionCommand(connectionId: string): Promise<void> {
  return invoke<void>("run_connection_command", { connectionId });
}

export function stopConnectionCommand(connectionId: string): Promise<void> {
  return invoke<void>("stop_connection_command", { connectionId });
}

/** The connections whose command is running right now. */
/**
 * Start the connection's language server, answering with what it says it can
 * do — which nothing here reads yet, beyond it having answered at all.
 */
export function startLanguageServer(connectionId: string): Promise<unknown> {
  return invoke<unknown>("start_language_server", { connectionId });
}

/** One JSON-RPC message, as the text the server is handed. */
export function sendToLanguageServer(connectionId: string, message: string): Promise<void> {
  return invoke<void>("send_to_language_server", { connectionId, message });
}

/**
 * What could go at `cursor`, a UTF-16 offset into the whole of `text`. Only a
 * BigQuery connection answers; a PostgreSQL one is completed by its language
 * server.
 */
export function complete(connectionId: string, text: string, cursor: number): Promise<Completion> {
  return invoke<Completion>("complete", { connectionId, text, cursor });
}

/** Whether agents may reach this app, and what they have to present. */
export function agentAccess(): Promise<AgentAccess> {
  return invoke<AgentAccess>("agent_access");
}

/** Open or shut the door, answering with how it now stands. */
export function setAgentAccess(enabled: boolean): Promise<AgentAccess> {
  return invoke<AgentAccess>("set_agent_access", { enabled });
}

/** Whether this connection can be completed against, or could be. */
export function languageServerState(connectionId: string): Promise<LanguageServerState> {
  return invoke<LanguageServerState>("language_server_state", { connectionId });
}

/** Build the server this connection would be completed against. */
export function installLanguageServer(connectionId: string): Promise<void> {
  return invoke<void>("install_language_server", { connectionId });
}

export function stopLanguageServer(connectionId: string): Promise<void> {
  return invoke<void>("stop_language_server", { connectionId });
}

export function runningConnectionCommands(): Promise<string[]> {
  return invoke<string[]>("running_connection_commands");
}

export function previewTable(request: PreviewRequest): Promise<TablePage> {
  return invoke<TablePage>("preview_table", { request });
}

export function tableShape(
  connectionId: string,
  schema: string,
  table: string,
): Promise<TableShape> {
  return invoke<TableShape>("table_shape", { connectionId, schema, table });
}

/** Resolves to how many rows changed, which is every update or none. */
export function commitTableEdits(edits: TableEdits): Promise<number> {
  return invoke<number>("commit_table_edits", { edits });
}
