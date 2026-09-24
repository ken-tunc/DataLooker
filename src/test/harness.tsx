import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { render } from "vitest-browser-react";
import type { Commands } from "../bindings/Commands";
import type { Events } from "../bindings/Events";
import { ToastProvider } from "../components/Toast";
import type { Command } from "../lib/invoke";

/**
 * A function's throw becomes a rejection with the thrown value, which is how
 * Tauri delivers an `AppError`.
 */
type Reply<C extends Command> =
  | Commands[C]["returns"]
  | ((args: Received<C>) => Commands[C]["returns"] | Promise<Commands[C]["returns"]>);

/** A command that takes nothing is sent no payload, so its stub gets `undefined`. */
type Received<C extends Command> = Commands[C]["args"] extends null
  ? undefined
  : Commands[C]["args"];

export type Replies = { [C in Command]?: Reply<C> };

export type Ipc = {
  calls: { command: string; args: unknown }[];
  /** What was sent the last time `command` was called, or undefined. */
  sent<C extends Command>(command: C): Received<C> | undefined;
  /** Announce what the backend would have announced, to whoever is listening. */
  emit<E extends keyof Events>(event: E, payload: Events[E]): void;
};

/**
 * Replaces `window.__TAURI_INTERNALS__.invoke`, so everything from
 * `lib/commands.ts` upwards runs as it does in the window.
 */
export function stubIpc(replies: Replies): Ipc {
  const calls: Ipc["calls"] = [];
  // Tauri passes a callback to the backend as a number and calls it back by it.
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
    // Arguments travel under `args`.
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
  // Unlistening reaches into this, and must not throw.
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: { unregisterListener: () => {} },
    configurable: true,
    writable: true,
  });

  return {
    calls,
    sent: <C extends Command>(command: C) =>
      calls.filter((call) => call.command === command).at(-1)?.args as Received<C> | undefined,
    emit: (event, payload) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event) listener.handler({ event, id, payload });
      }
    },
  };
}

/**
 * `main.tsx`'s providers without the error boundary, so a test sees the
 * failure. A fresh cache per test.
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
