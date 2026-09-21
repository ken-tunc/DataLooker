import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

/**
 * How far a key moves through the list, or 0 if it does not move at all. ⌃N and
 * ⌃P are here beside the arrows because macOS reads them as down and up in any
 * text field, and they keep a reader's hands where the query is.
 */
function stepFor(event: KeyboardEvent): number {
  if (event.ctrlKey && (event.key === "n" || event.key === "p")) return event.key === "n" ? 1 : -1;
  if (event.ctrlKey || event.metaKey || event.altKey) return 0;
  if (event.key === "ArrowDown") return 1;
  if (event.key === "ArrowUp") return -1;
  return 0;
}

type Props<T> = {
  /** Names the dialog. */
  label: string;
  /** Names the query field, and stands in it while it is empty. */
  placeholder: string;
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

/**
 * A modal list driven from its query field: what is typed narrows it, the
 * arrows walk it, Enter takes what is under them. Everything else — where the
 * items come from and what an option looks like — belongs to the caller.
 */
export function Palette<T>({
  label,
  placeholder,
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
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const base = useId();
  const optionId = (index: number) => `${base}-option-${index}`;
  const listId = `${base}-options`;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const items = search(query);
  // The items can arrive after a query has been typed, so the selection is
  // clamped on the way out rather than trusted to have been kept in range.
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
      // Wraps, because a list this short is faster to reach from either end.
      setActive((items.length + selected + step) % Math.max(items.length, 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(selected);
      return;
    }
    // Nothing else in the palette takes the keyboard, and Chromium answers a
    // Tab it cannot place by dropping the focus on the body, where the query
    // would stop hearing what is typed.
    if (event.key === "Tab") event.preventDefault();
  }

  return (
    <dialog ref={dialog} className="modal items-start" aria-label={label} onClose={onClose}>
      <div className="modal-box mt-24 flex max-h-96 w-full max-w-xl flex-col gap-2 p-2">
        <input
          // `showModal` moves the focus here on its own: this is the first
          // focusable element in the dialog.
          className="input input-sm w-full"
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

        {!status && items.length === 0 && (
          <p className="text-base-content/60 p-2 text-sm">{empty}</p>
        )}

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
                // Out of the Tab order: the input owns the keyboard, and a
                // focused option would take the arrows and Enter away from it.
                tabIndex={-1}
                aria-selected={index === selected}
                className={`flex w-full items-baseline gap-2 ${index === selected ? "menu-active" : ""}`}
                // The input keeps the focus, so the list stays keyboard-driven
                // whether the reader is typing or pointing.
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
