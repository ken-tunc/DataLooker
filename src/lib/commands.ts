import type { PreviewRequest } from "../bindings/PreviewRequest";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";
import type { SavedTabs } from "../bindings/SavedTabs";
import type { SaveTemplateInput } from "../bindings/SaveTemplateInput";
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

/** `connectionIds` is every connection, in the order the rail is to show them. */
export function reorderConnections(connectionIds: string[]) {
  return invoke("reorder_connections", { connection_ids: connectionIds });
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

/** Asks for the plan; `analyze` carries the statement out, where it can change nothing. */
export function explainQuery(connectionId: string, sql: string, analyze: boolean, queryId: string) {
  return invoke("explain_query", {
    connection_id: connectionId,
    sql,
    analyze,
    query_id: queryId,
  });
}

/** Of the reader's session, as the last statement on it left it. */
export function transactionState(connectionId: string) {
  return invoke("transaction_state", { connection_id: connectionId });
}

export function cancelQuery(queryId: string) {
  return invoke("cancel_query", { query_id: queryId });
}

/** What a BigQuery statement would scan, from a dry run that bills nothing. */
export function estimateQuery(connectionId: string, sql: string) {
  return invoke("estimate_query", { connection_id: connectionId, sql });
}

/** Needs no connection: the grammar is built in. */
export function checkSyntax(sql: string) {
  return invoke("check_syntax", { sql });
}

/** What to ask the reader about before `sql` runs; empty when nothing is. */
export function statementRisks(connectionId: string, sql: string) {
  return invoke("statement_risks", { connection_id: connectionId, sql });
}

export function queryHistory(connectionId: string) {
  return invoke("query_history", { connection_id: connectionId });
}

/** The tabs the connection had open when it was last saved; none if never. */
export function savedTabs(connectionId: string) {
  return invoke("saved_tabs", { connection_id: connectionId });
}

/** Replaces what was kept, so a tab closed since stays closed. */
export function saveTabs(connectionId: string, tabs: SavedTabs) {
  return invoke("save_tabs", { connection_id: connectionId, tabs });
}

export function listTemplates() {
  return invoke("list_templates");
}

/** Resolves to the template's id. */
export function saveTemplate(input: SaveTemplateInput) {
  return invoke("save_template", input);
}

export function deleteTemplate(templateId: string) {
  return invoke("delete_template", { template_id: templateId });
}

/** Schemas and their tables, without columns. */
export function schemaTree(connectionId: string) {
  return invoke("schema_tree", { connection_id: connectionId });
}

export function tableColumns(connectionId: string, schema: string, table: string) {
  return invoke("table_columns", { connection_id: connectionId, schema, table });
}

export function tableDefinition(connectionId: string, schema: string, table: string) {
  return invoke("table_definition", { connection_id: connectionId, schema, table });
}

/** It runs until it is stopped, it fails, or the app quits. */
export function runConnectionCommand(connectionId: string) {
  return invoke("run_connection_command", { connection_id: connectionId });
}

export function stopConnectionCommand(connectionId: string) {
  return invoke("stop_connection_command", { connection_id: connectionId });
}

export function runningConnectionCommands() {
  return invoke("running_connection_commands");
}

/** Resolves to the server's capabilities. */
export function startLanguageServer(connectionId: string) {
  return invoke("start_language_server", { connection_id: connectionId });
}

export function sendToLanguageServer(connectionId: string, message: string) {
  return invoke("send_to_language_server", { connection_id: connectionId, message });
}

export function stopLanguageServer(connectionId: string) {
  return invoke("stop_language_server", { connection_id: connectionId });
}

/** `cursor` is a UTF-16 offset. BigQuery only; PostgreSQL has a language server. */
export function complete(connectionId: string, text: string, cursor: number) {
  return invoke("complete", { connection_id: connectionId, text, cursor });
}

export function languageServerState(connectionId: string) {
  return invoke("language_server_state", { connection_id: connectionId });
}

export function installLanguageServer(connectionId: string) {
  return invoke("install_language_server", { connection_id: connectionId });
}

export function agentAccess() {
  return invoke("agent_access");
}

export function setAgentAccess(enabled: boolean) {
  return invoke("set_agent_access", { enabled });
}

export function previewTable(request: PreviewRequest) {
  return invoke("preview_table", request);
}

export function previewCost(request: PreviewRequest) {
  return invoke("preview_cost", request);
}

export function tableShape(connectionId: string, schema: string, table: string) {
  return invoke("table_shape", { connection_id: connectionId, schema, table });
}

/** Resolves to how many rows changed, which is every update or none. */
export function commitTableEdits(edits: TableEdits) {
  return invoke("commit_table_edits", edits);
}
