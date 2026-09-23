import { useSyncExternalStore } from "react";

/**
 * A pane the reader can resize, and the bounds a size is held to. The bounds
 * are what keep a size stored on a bigger screen from hiding everything beside
 * the pane on a smaller one.
 */
export type Pane = { key: string; initial: number; min: number; max: number };

/**
 * How big each pane was dragged to. Every tab has an editor and there is one
 * sidebar, and the reader who drags one editor taller means the next one too,
 * so a size belongs to the window rather than to a tab. It is kept in
 * `localStorage` for the reason the vim toggle is: it is how this window is
 * laid out, not something DataLooker knows.
 */
const sizes = new Map<string, number>();
const listeners = new Set<() => void>();

function stored(key: string): number | undefined {
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 ? value : undefined;
  } catch {
    // Storage the browser refuses is no preference, as is never having set one.
    return undefined;
  }
}

function clamp(pane: Pane, size: number): number {
  return Math.round(Math.min(pane.max, Math.max(pane.min, size)));
}

function sizeOf(pane: Pane): number {
  if (!sizes.has(pane.key)) sizes.set(pane.key, clamp(pane, stored(pane.key) ?? pane.initial));
  return sizes.get(pane.key) as number;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Null puts the pane back to the size it starts at. */
function resize(pane: Pane, size: number | null) {
  const next = clamp(pane, size ?? pane.initial);
  sizes.set(pane.key, next);
  try {
    if (size === null) localStorage.removeItem(pane.key);
    else localStorage.setItem(pane.key, String(next));
  } catch {
    // The size still holds for this run; it just will not outlive it.
  }
  for (const listener of listeners) listener();
}

export function usePaneSize(pane: Pane): [number, (size: number | null) => void] {
  const size = useSyncExternalStore(subscribe, () => sizeOf(pane));
  return [size, (next) => resize(pane, next)];
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const pane: Pane = { key: "datalooker.test-pane", initial: 200, min: 100, max: 400 };

  describe("pane sizes", () => {
    it("holds a size to the pane's bounds, and forgets it when put back", () => {
      resize(pane, 1000);
      expect(sizeOf(pane)).toBe(400);
      resize(pane, 10);
      expect(sizeOf(pane)).toBe(100);
      resize(pane, null);
      expect(sizeOf(pane)).toBe(200);
    });

    it("tells everyone who is listening", () => {
      const heard: number[] = [];
      const stop = subscribe(() => heard.push(sizeOf(pane)));

      resize(pane, 150);
      stop();
      resize(pane, 250);

      expect(heard).toEqual([150]);
      resize(pane, null);
    });
  });
}
