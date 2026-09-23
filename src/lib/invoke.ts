import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AppError } from "../bindings/AppError";
import type { Commands } from "../bindings/Commands";

/** Tauri rejects with the serialized `AppError`, which is not an `Error`. */
export class IpcError extends Error {
  readonly kind: AppError["kind"];

  constructor(error: AppError) {
    super("message" in error ? error.message : error.kind);
    this.name = "IpcError";
    this.kind = error.kind;
  }
}

/**
 * Every kind, and whether the Rust variant carries a message — the ones that
 * do not arrive as `kind` alone. A `Record` of the whole union rather than a
 * list, so that a variant added to `AppError` fails the type check here
 * instead of quietly falling through as an error nothing can branch on.
 */
const CARRIES_MESSAGE: Record<AppError["kind"], boolean> = {
  Validation: true,
  NotFound: true,
  Database: true,
  Secret: true,
  Conflict: true,
  Shell: true,
  Unsupported: true,
  Cancelled: false,
  Timeout: false,
};

function asAppError(value: unknown): AppError | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, message } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !Object.hasOwn(CARRIES_MESSAGE, kind)) return null;
  if (!CARRIES_MESSAGE[kind as AppError["kind"]]) return { kind } as AppError;
  if (typeof message !== "string") return null;
  return { kind, message } as AppError;
}

export function toIpcError(value: unknown): Error {
  const appError = asAppError(value);
  if (appError) return new IpcError(appError);
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  // JSON.stringify returns undefined for undefined and throws on bigint or a cycle.
  try {
    return new Error(JSON.stringify(value) ?? String(value));
  } catch {
    return new Error("Unknown IPC error");
  }
}

export type Command = keyof Commands;

/**
 * What a command is sent: its arguments, or nothing for a command that takes
 * none. Both come from the Rust declaration, so a call that no longer matches
 * it fails the type check here.
 */
export type Sent<C extends Command> = Commands[C]["args"] extends null
  ? []
  : [args: Commands[C]["args"]];

export async function invoke<C extends Command>(
  command: C,
  ...sent: Sent<C>
): Promise<Commands[C]["returns"]> {
  // A command takes its arguments as one value under `args`, which is what
  // lets ts-rs write down its shape.
  const payload = sent.length === 0 ? undefined : { args: sent[0] };
  try {
    return await tauriInvoke<Commands[C]["returns"]>(command, payload);
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

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("asAppError", () => {
    it("accepts a known kind with a string message", () => {
      expect(asAppError({ kind: "Validation", message: "message must not be empty" })).toEqual({
        kind: "Validation",
        message: "message must not be empty",
      });
    });

    it("rejects a kind the bindings do not declare", () => {
      expect(asAppError({ kind: "Exploded", message: "boom" })).toBeNull();
    });

    it("rejects a payload whose message is missing or not a string", () => {
      expect(asAppError({ kind: "Validation" })).toBeNull();
      expect(asAppError({ kind: "Validation", message: 42 })).toBeNull();
    });

    it("accepts a kind that carries no message", () => {
      expect(asAppError({ kind: "Cancelled" })).toEqual({ kind: "Cancelled" });
    });

    it("rejects values that are not objects", () => {
      expect(asAppError("Validation")).toBeNull();
      expect(asAppError(null)).toBeNull();
    });
  });

  describe("toIpcError", () => {
    it("wraps a serialized AppError, keeping its kind", () => {
      const error = toIpcError({ kind: "Validation", message: "message must not be empty" });
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).kind).toBe("Validation");
      expect(error.message).toBe("message must not be empty");
    });

    it.each(["Validation", "NotFound", "Database", "Secret", "Conflict"] as const)(
      "wraps a %s, which the frontend branches on",
      (kind) => {
        expect(toIpcError({ kind, message: "gone" })).toBeInstanceOf(IpcError);
      },
    );

    it("passes an Error through untouched", () => {
      const original = new Error("boom");
      expect(toIpcError(original)).toBe(original);
    });

    it("falls back to a plain Error for anything else", () => {
      // Tauri rejects with a string when the command itself cannot be reached.
      expect(toIpcError("command not found").message).toBe("command not found");
      expect(toIpcError({ kind: "Unknown" })).not.toBeInstanceOf(IpcError);
    });

    it("keeps a message for values JSON.stringify cannot render", () => {
      // JSON.stringify returns undefined here, and `new Error(undefined)` has no message.
      expect(toIpcError(undefined).message).toBe("undefined");
    });

    it("survives values JSON.stringify throws on", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(toIpcError(circular).message).toBe("Unknown IPC error");
      expect(toIpcError(1n).message).toBe("Unknown IPC error");
    });
  });

  describe("describeError", () => {
    it("lets the caller reword a specific kind", () => {
      const error = toIpcError({ kind: "Validation", message: "message must not be empty" });
      expect(describeError(error, { Validation: "Type something first." })).toBe(
        "Type something first.",
      );
    });

    it("uses the backend message when there is no override", () => {
      expect(describeError(toIpcError({ kind: "Validation", message: "empty" }))).toBe("empty");
    });
  });
}
