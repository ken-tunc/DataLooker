import { listen } from "@tauri-apps/api/event";
import type { ShellExit } from "../bindings/ShellExit";

/**
 * What the backend announces, and what each announcement carries. A command is
 * asked a question and answers it; an event is the other direction — something
 * the app learned without being asked. As with `commands.ts`, this is the only
 * module that names one.
 */
type Events = {
  "shell:exit": ShellExit;
};

/**
 * Listen until the returned function is called. Subscribing is asynchronous
 * and unsubscribing is not, so a caller that has already given up by the time
 * the listener is in place is remembered and torn down at once — which is what
 * an effect that runs twice in development looks like.
 */
export function subscribe<E extends keyof Events>(
  event: E,
  handler: (payload: Events[E]) => void,
): () => void {
  let stop: (() => void) | undefined;
  let done = false;

  void listen<Events[E]>(event, ({ payload }) => handler(payload)).then((unlisten) => {
    if (done) unlisten();
    else stop = unlisten;
  });

  return () => {
    done = true;
    stop?.();
  };
}
