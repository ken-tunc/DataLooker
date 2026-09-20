import { useSyncExternalStore } from "react";

const PREFERS_DARK = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(PREFERS_DARK);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * Monaco paints itself rather than reading the daisyUI theme, so it needs the
 * same OS preference daisyUI follows through `--prefersdark`.
 */
export function useEditorTheme(): "vs" | "vs-dark" {
  return useSyncExternalStore(
    subscribe,
    () => (window.matchMedia(PREFERS_DARK).matches ? "vs-dark" : "vs"),
    () => "vs",
  );
}
