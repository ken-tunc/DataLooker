import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { stepFor } from "../lib/keys";

type Props<T> = {
  /** Names the dialog. */
  label: string;
  /** Names the query field, and stands in it while it is empty. */
  placeholder: string;
  /** What the field starts with, for a palette opened about something. */
  initial?: string;
  search: (query: string) => readonly T[];
  keyOf: (item: T) => string;
  /** Draws one option. */
  children: (item: T) => ReactNode;
  onChoose: (item: T) => void;
  onClose: () => void;
  /** What to say instead of a list: what is still arriving, or what failed. */
  status?: ReactNode;
  /** What to say when the search comes back with nothing. */
  empty: string;
  footer?: (items: readonly T[]) => ReactNode;
};

/** Where the items come from and how an option looks belong to the caller. */
export function Palette<T>({
  label,
  placeholder,
  initial,
  search,
  keyOf,
  children,
  onChoose,
  onClose,
  status,
  empty,
  footer,
}: Props<T>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState(initial ?? "");
  const [active, setActive] = useState(0);
  const base = useId();
  const optionId = (index: number) => `${base}-option-${index}`;
  const listId = `${base}-options`;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const items = search(query);
  // Items can arrive after the query was typed.
  const selected = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function choose(index: number) {
    const item = items[index];
    if (!item) return;
    onChoose(item);
    dialog.current?.close();
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = stepFor(event);
    if (step !== 0) {
      event.preventDefault();
      // Wraps around.
      setActive((items.length + selected + step) % Math.max(items.length, 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(selected);
      return;
    }
    // Chromium drops the focus on the body for a Tab with nowhere to go.
    if (event.key === "Tab") event.preventDefault();
  }

  return (
    <dialog
      ref={dialog}
      className="modal items-start backdrop-blur-sm"
      aria-label={label}
      onClose={onClose}
    >
      <div className="modal-box mt-24 flex max-h-96 w-full max-w-xl flex-col gap-2 p-2">
        <input
          // Always focused (`showModal` puts it there), so the ring is faint.
          className="input input-ghost focus-within:outline-base-content/20 w-full text-base"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={items.length > 0 ? optionId(selected) : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />

        {status}

        {!status && items.length === 0 && <p className="text-faint p-2 text-sm">{empty}</p>}

        <ul
          ref={list}
          id={listId}
          className="menu min-h-0 w-full flex-nowrap overflow-y-auto p-0"
          role="listbox"
          aria-label={label}
        >
          {items.map((item, index) => (
            <li key={keyOf(item)} role="presentation" className="w-full">
              <button
                type="button"
                id={optionId(index)}
                role="option"
                // The input owns the keyboard.
                tabIndex={-1}
                aria-selected={index === selected}
                className={`flex w-full items-baseline gap-2 ${index === selected ? "menu-active" : ""}`}
                // Keep the focus in the input.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                {children(item)}
              </button>
            </li>
          ))}
        </ul>

        {footer?.(items)}

        <p className="text-muted hairline flex items-center gap-3 border-t px-2 pt-2 text-xs">
          <span>
            <kbd className="kbd kbd-xs">↑</kbd> <kbd className="kbd kbd-xs">↓</kbd> move
          </span>
          <span>
            <kbd className="kbd kbd-xs">↵</kbd> open
          </span>
          <span>
            <kbd className="kbd kbd-xs">esc</kbd> close
          </span>
        </p>
      </div>
      <form method="dialog" className="modal-backdrop">
        {/* The backdrop is there to be clicked. Tabbing to it would move the
            keyboard off the query and onto a button nothing is drawn for. */}
        <button type="submit" tabIndex={-1}>
          Close
        </button>
      </form>
    </dialog>
  );
}
