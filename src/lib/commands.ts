import type { Pong } from "../bindings/Pong";
import { invoke } from "./invoke";

export function appVersion(): Promise<string> {
  return invoke<string>("app_version");
}

export function ping(message: string): Promise<Pong> {
  return invoke<Pong>("ping", { message });
}
