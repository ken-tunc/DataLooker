import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AppError } from "../bindings/AppError";

/** Tauri rejects with the serialized `AppError`, which is not an `Error`. */
export class IpcError extends Error {
  readonly kind: AppError["kind"];

  constructor(error: AppError) {
    super(error.message);
    this.name = "IpcError";
    this.kind = error.kind;
  }
}

const ERROR_KINDS: ReadonlySet<string> = new Set<AppError["kind"]>([
  "NotFound",
  "Validation",
  "Internal",
]);

function asAppError(value: unknown): AppError | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, message } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !ERROR_KINDS.has(kind)) return null;
  if (typeof message !== "string") return null;
  return { kind, message } as AppError;
}

export function toIpcError(value: unknown): Error {
  const appError = asAppError(value);
  if (appError) return new IpcError(appError);
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw toIpcError(error);
  }
}

export function describeError(
  error: unknown,
  overrides?: Partial<Record<AppError["kind"], string>>,
): string {
  if (error instanceof IpcError) {
    return overrides?.[error.kind] ?? error.message ?? error.kind;
  }
  return error instanceof Error ? error.message : String(error);
}
