import { useSyncExternalStore } from "react";

/**
 * Whether the editors use vim keybindings. Every tab holds an editor of its
 * own, so the answer lives outside them all rather than in one of them — a
 * reader who turns vim on is not turning it on for this tab.
 *
 * It is kept in `localStorage` rather than meta.db: it is how this window
 * behaves, not something DataLooker knows, and nothing else that drives the app
 * — the MCP server planned for later included — has an editor to apply it to.
 */
const KEY = "datalooker.vim";

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    // Storage a browser refuses (a private window, blocked site data) means no
    // preference, which is the same answer as never having set one.
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
    // The preference still holds for this run; it just will not outlive it.
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
