import type { PreviewRequest } from "../bindings/PreviewRequest";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";
import type { TableEdits } from "../bindings/TableEdits";
import { invoke } from "./invoke";

// What each command answers with is the Rust declaration's to say, so none of
// these names a return type: `invoke` reads it from the generated bindings.

export function listConnections() {
  return invoke("list_connections");
}

export function saveConnection(input: SaveConnectionInput) {
  return invoke("save_connection", input);
}

export function deleteConnection(connectionId: string) {
  return invoke("delete_connection", { connection_id: connectionId });
}

/** Resolves to how long reaching the server took, in milliseconds. */
export function testConnection(connectionId: string) {
  return invoke("test_connection", { connection_id: connectionId });
}

/** `queryId` is the caller's handle on the running query — `cancelQuery` takes the same one. */
export function executeQuery(connectionId: string, sql: string, queryId: string) {
  return invoke("execute_query", { connection_id: connectionId, sql, query_id: queryId });
}

export function cancelQuery(queryId: string) {
  return invoke("cancel_query", { query_id: queryId });
}

/** What PostgreSQL would refuse to parse. Needs no connection: the grammar is built in. */
export function checkSyntax(sql: string) {
  return invoke("check_syntax", { sql });
}

/** The statements run against this connection, newest first. */
export function queryHistory(connectionId: string) {
  return invoke("query_history", { connection_id: connectionId });
}

/** What a connection holds: its schemas and their tables, but not their columns. */
export function schemaTree(connectionId: string) {
  return invoke("schema_tree", { connection_id: connectionId });
}

/** What one table holds, asked for when the table is opened. */
export function tableColumns(connectionId: string, schema: string, table: string) {
  return invoke("table_columns", { connection_id: connectionId, schema, table });
}

/** The `CREATE` statement PostgreSQL's catalogs describe, and what stands beside it. */
export function tableDefinition(connectionId: string, schema: string, table: string) {
  return invoke("table_definition", { connection_id: connectionId, schema, table });
}

/**
 * Start the connection's command — a port forward, a tunnel — and leave it
 * running. It ends when it is stopped, when it fails, or when the app quits.
 */
export function runConnectionCommand(connectionId: string) {
  return invoke("run_connection_command", { connection_id: connectionId });
}

export function stopConnectionCommand(connectionId: string) {
  return invoke("stop_connection_command", { connection_id: connectionId });
}

/** The connections whose command is running right now. */
export function runningConnectionCommands() {
  return invoke("running_connection_commands");
}

/**
 * Start the connection's language server, answering with what it says it can
 * do — which nothing here reads yet, beyond it having answered at all.
 */
export function startLanguageServer(connectionId: string) {
  return invoke("start_language_server", { connection_id: connectionId });
}

/** One JSON-RPC message, as the text the server is handed. */
export function sendToLanguageServer(connectionId: string, message: string) {
  return invoke("send_to_language_server", { connection_id: connectionId, message });
}

export function stopLanguageServer(connectionId: string) {
  return invoke("stop_language_server", { connection_id: connectionId });
}

/** Whether this connection can be completed against, or could be. */
export function languageServerState(connectionId: string) {
  return invoke("language_server_state", { connection_id: connectionId });
}

/** Build the server this connection would be completed against. */
export function installLanguageServer(connectionId: string) {
  return invoke("install_language_server", { connection_id: connectionId });
}

/** Whether agents may reach this app, and what they have to present. */
export function agentAccess() {
  return invoke("agent_access");
}

/** Open or shut the door, answering with how it now stands. */
export function setAgentAccess(enabled: boolean) {
  return invoke("set_agent_access", { enabled });
}

export function previewTable(request: PreviewRequest) {
  return invoke("preview_table", request);
}

export function tableShape(connectionId: string, schema: string, table: string) {
  return invoke("table_shape", { connection_id: connectionId, schema, table });
}

/** Resolves to how many rows changed, which is every update or none. */
export function commitTableEdits(edits: TableEdits) {
  return invoke("commit_table_edits", edits);
}
