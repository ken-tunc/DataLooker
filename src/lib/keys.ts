/** ⌃N and ⌃P, as in any macOS text field, besides the arrows: how far a list's selection moves. */
export function stepFor(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}) {
  if (event.ctrlKey && (event.key === "n" || event.key === "p")) return event.key === "n" ? 1 : -1;
  if (event.ctrlKey || event.metaKey || event.altKey) return 0;
  if (event.key === "ArrowDown") return 1;
  if (event.key === "ArrowUp") return -1;
  return 0;
}
