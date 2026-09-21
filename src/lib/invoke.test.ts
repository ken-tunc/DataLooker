import { describe, expect, it } from "vite-plus/test";
import { describeError, IpcError, toIpcError } from "./invoke";

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

describe("toIpcError fallbacks", () => {
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
