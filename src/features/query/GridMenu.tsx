import { useEffect, useRef } from "react";
import { Keys } from "../../components/Keys";

export type MenuItem = { label: string; keys?: string; run: () => void } | "divider";

/**
 * What can be done with the selected cells. A manual popover: an automatic
 * one would be dismissed by the very right-click that opened it, whose
 * pointer is let go outside it.
 */
export function GridMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  items: MenuItem[];
  onClose: () => void;
}) {
  const popover = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const node = popover.current;
    if (!node) return;
    if (!node.matches(":popover-open")) node.showPopover();
    const margin = 8;
    const box = node.getBoundingClientRect();
    node.style.left = `${Math.max(margin, Math.min(at.x, window.innerWidth - box.width - margin))}px`;
    node.style.top = `${Math.max(margin, Math.min(at.y, window.innerHeight - box.height - margin))}px`;
    node.querySelector("button")?.focus();
  }, [at]);

  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      if (!popover.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  return (
    <ul
      ref={popover}
      popover="manual"
      role="menu"
      aria-label="Selected cells"
      className="menu menu-sm hairline bg-base-200 m-0 w-56 rounded-box border p-1 shadow-lg"
      style={{ inset: "auto", left: at.x, top: at.y }}
    >
      {items.map((item, index) =>
        item === "divider" ? (
          <li key={index} role="separator" className="border-base-content/10 my-1 border-t" />
        ) : (
          <li key={item.label} role="none">
            <button
              type="button"
              role="menuitem"
              className="flex justify-between"
              onClick={() => {
                item.run();
                onClose();
              }}
            >
              {item.label}
              {item.keys && <Keys keys={item.keys} size="xs" />}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
