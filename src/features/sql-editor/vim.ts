import { useSyncExternalStore } from "react";

/**
 * One answer for every tab's editor. In `localStorage` rather than meta.db:
 * it is how this window behaves, not something DataLooker knows.
 */
const KEY = "datalooker.vim";

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    // Storage the browser refuses is no preference.
    return false;
  }
}

let enabled = read();

export function useVimMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, () => enabled);
  return [on, setVimMode];
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setVimMode(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // It still holds for this run.
  }
  for (const listener of listeners) listener();
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("vim mode", () => {
    it("tells everyone who is listening", () => {
      const heard: boolean[] = [];
      const stop = subscribe(() => heard.push(enabled));

      setVimMode(true);
      setVimMode(false);
      stop();
      setVimMode(true);

      expect(heard).toEqual([true, false]);
      setVimMode(false);
    });
  });
}
