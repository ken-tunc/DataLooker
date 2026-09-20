import { describe, expect, it } from "vite-plus/test";
import { describeError, IpcError, toIpcError } from "./invoke";

describe("toIpcError", () => {
  it("wraps a serialized AppError, keeping its kind", () => {
    const error = toIpcError({ kind: "Validation", message: "message must not be empty" });
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).kind).toBe("Validation");
    expect(error.message).toBe("message must not be empty");
  });

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
    const error = toIpcError({ kind: "NotFound", message: "connection 7" });
    expect(describeError(error, { NotFound: "That connection is gone." })).toBe(
      "That connection is gone.",
    );
  });

  it("uses the backend message when there is no override", () => {
    expect(describeError(toIpcError({ kind: "Internal", message: "disk full" }))).toBe("disk full");
  });
});
