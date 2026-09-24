import { listen } from "@tauri-apps/api/event";
import type { Events } from "../bindings/Events";

/**
 * The only module that names an event. Listens until the returned function is
 * called. Subscribing is asynchronous and unsubscribing is not, so a caller
 * that gave up before the listener was in place (an effect run twice in
 * development) has it torn down as soon as it arrives.
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
