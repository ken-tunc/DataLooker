import type { ConnectionRecord } from "../bindings/ConnectionRecord";
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
