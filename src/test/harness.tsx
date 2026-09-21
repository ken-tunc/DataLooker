import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { render } from "vitest-browser-react";
import { ToastProvider } from "../components/Toast";

/**
 * What a command answers with. A function is handed the arguments the frontend
 * sent, and whatever it throws comes back as a rejection — which is how an
 * `AppError` arrives, since Tauri rejects with the serialized value rather
 * than an `Error`.
 */
type Reply = unknown;

export type Ipc = {
  calls: { command: string; args: Record<string, unknown> }[];
  /** What was sent the last time `command` was called, or undefined. */
  sent(command: string): Record<string, unknown> | undefined;
};

/**
 * Stands in for the Tauri side. The app reaches the backend through
 * `window.__TAURI_INTERNALS__.invoke`, and nothing between here and there
 * knows the difference — the wrappers in `lib/commands.ts`, React Query and
 * every component above them run exactly as they do in the window.
 */
export function stubIpc(replies: Record<string, Reply>): Ipc {
  const calls: Ipc["calls"] = [];

  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    const reply = replies[command];
    if (reply === undefined) {
      throw { kind: "NotFound", message: `no stub for ${command}` };
    }
    return typeof reply === "function"
      ? (reply as (args: Record<string, unknown>) => unknown)(args)
      : reply;
  };

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke },
    configurable: true,
    writable: true,
  });

  return {
    calls,
    sent: (command) => calls.filter((call) => call.command === command).at(-1)?.args,
  };
}

/**
 * The providers `main.tsx` mounts, minus the error boundary: a test wants the
 * failure, not a fallback screen. Each test gets a cache of its own so that
 * one test's rows cannot answer another test's query.
 */
export async function renderApp(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}
