import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { render } from "vitest-browser-react";
import type { Commands } from "../bindings/Commands";
import type { Events } from "../bindings/Events";
import { ToastProvider } from "../components/Toast";
import type { Command } from "../lib/invoke";

/**
 * What a command answers with, as the Rust declaration says it does. A
 * function is handed what the frontend sent, and whatever it throws comes back
 * as a rejection — which is how an `AppError` arrives, since Tauri rejects
 * with the serialized value rather than an `Error`.
 */
type Reply<C extends Command> =
  | Commands[C]["returns"]
  | ((args: Commands[C]["args"]) => Commands[C]["returns"] | Promise<Commands[C]["returns"]>);

export type Replies = { [C in Command]?: Reply<C> };

export type Ipc = {
  calls: { command: string; args: unknown }[];
  /** What was sent the last time `command` was called, or undefined. */
  sent<C extends Command>(command: C): Commands[C]["args"] | undefined;
  /** Announce what the backend would have announced, to whoever is listening. */
  emit<E extends keyof Events>(event: E, payload: Events[E]): void;
};

/**
 * Stands in for the Tauri side. The app reaches the backend through
 * `window.__TAURI_INTERNALS__.invoke`, and nothing between here and there
 * knows the difference — the wrappers in `lib/commands.ts`, React Query and
 * every component above them run exactly as they do in the window.
 */
export function stubIpc(replies: Replies): Ipc {
  const calls: Ipc["calls"] = [];
  // What `listen` handed over, by the number it was given. Tauri passes a
  // callback to the backend as a number and calls it back by that number; the
  // frontend never sees either, so neither does a test.
  const listeners = new Map<number, { event: string; handler: (message: unknown) => void }>();
  let nextHandler = 0;

  const invoke = async (command: string, payload: Record<string, unknown> = {}) => {
    if (command === "plugin:event|listen") {
      const handler = listeners.get(payload.handler as number);
      if (handler) handler.event = payload.event as string;
      return payload.handler;
    }
    if (command === "plugin:event|unlisten") {
      listeners.delete(payload.eventId as number);
      return null;
    }
    // A command's arguments travel under `args`, which is the part a test
    // wrote and the part it reads back.
    const args = payload.args;
    calls.push({ command, args });
    const reply = (replies as Record<string, unknown>)[command];
    if (reply === undefined) {
      throw { kind: "NotFound", message: `no stub for ${command}` };
    }
    return typeof reply === "function" ? (reply as (args: unknown) => unknown)(args) : reply;
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
    sent: <C extends Command>(command: C) =>
      calls.filter((call) => call.command === command).at(-1)?.args as
        | Commands[C]["args"]
        | undefined,
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
