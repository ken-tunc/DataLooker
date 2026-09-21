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
  /** Announce what the backend would have announced, to whoever is listening. */
  emit(event: string, payload: unknown): void;
};

/**
 * Stands in for the Tauri side. The app reaches the backend through
 * `window.__TAURI_INTERNALS__.invoke`, and nothing between here and there
 * knows the difference — the wrappers in `lib/commands.ts`, React Query and
 * every component above them run exactly as they do in the window.
 */
export function stubIpc(replies: Record<string, Reply>): Ipc {
  const calls: Ipc["calls"] = [];
  // What `listen` handed over, by the number it was given. Tauri passes a
  // callback to the backend as a number and calls it back by that number; the
  // frontend never sees either, so neither does a test.
  const listeners = new Map<number, { event: string; handler: (message: unknown) => void }>();
  let nextHandler = 0;

  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "plugin:event|listen") {
      const handler = listeners.get(args.handler as number);
      if (handler) handler.event = args.event as string;
      return args.handler;
    }
    if (command === "plugin:event|unlisten") {
      listeners.delete(args.eventId as number);
      return null;
    }
    const reply = replies[command];
    if (reply === undefined) {
      throw { kind: "NotFound", message: `no stub for ${command}` };
    }
    return typeof reply === "function"
      ? (reply as (args: Record<string, unknown>) => unknown)(args)
      : reply;
  };

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {
      invoke,
      transformCallback: (handler: (message: unknown) => void) => {
        nextHandler += 1;
        listeners.set(nextHandler, { event: "", handler });
        return nextHandler;
      },
    },
    configurable: true,
    writable: true,
  });
  // `listen` tells the event plugin's own bookkeeping that a listener is going
  // away. Nothing here keeps that book, but unlistening must not throw.
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: { unregisterListener: () => {} },
    configurable: true,
    writable: true,
  });

  return {
    calls,
    sent: (command) => calls.filter((call) => call.command === command).at(-1)?.args,
    emit: (event, payload) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event) listener.handler({ event, id, payload });
      }
    },
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
