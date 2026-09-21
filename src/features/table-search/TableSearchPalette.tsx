import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { describeError } from "../../lib/invoke";
import { useSchemaTree } from "../schema-tree/hooks";
import { KIND_LABELS } from "../schema-tree/rows";
import { highlight, MATCH_LIMIT, searchTables } from "./search";

type Props = {
  connectionId: string;
  onOpenTable: (schema: string, table: string) => void;
  onClose: () => void;
};

const optionId = (index: number) => `table-search-option-${index}`;

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

/**
 * Finds a table by name rather than by where it sits. The tree it searches is
 * the one the sidebar already asked for, so opening the palette costs no
 * request of its own.
 */
export function TableSearchPalette({ connectionId, onOpenTable, onClose }: Props) {
  const tree = useSchemaTree(connectionId);
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const matches = tree.data ? searchTables(tree.data, query) : [];
  // The tree can arrive after a query has been typed, so the selection is
  // clamped on the way out rather than trusted to have been kept in range.
  const selected = Math.min(active, Math.max(matches.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function open(index: number) {
    const match = matches[index];
    if (!match) return;
    onOpenTable(match.schema, match.table);
    dialog.current?.close();
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = stepFor(event);
    if (step !== 0) {
      event.preventDefault();
      // Wraps, because a list this short is faster to reach from either end.
      setActive((matches.length + selected + step) % Math.max(matches.length, 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open(selected);
    }
  }

  return (
    <dialog ref={dialog} className="modal items-start" aria-label="Open a table" onClose={onClose}>
      <div className="modal-box mt-24 flex max-h-96 w-full max-w-xl flex-col gap-2 p-2">
        <input
          // `showModal` moves the focus here on its own: this is the first
          // focusable element in the dialog.
          className="input input-sm w-full"
          role="combobox"
          aria-expanded
          aria-controls="table-search-results"
          aria-activedescendant={matches.length > 0 ? optionId(selected) : undefined}
          aria-label="Find a table"
          placeholder="Find a table"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />

        {tree.isPending && <p className="text-base-content/60 p-2 text-sm">Reading the schema…</p>}

        {tree.isError && (
          <div role="alert" className="alert alert-error text-sm">
            <span className="truncate">{describeError(tree.error)}</span>
          </div>
        )}

        {tree.data && matches.length === 0 && (
          <p className="text-base-content/60 p-2 text-sm">No table matches.</p>
        )}

        <ul
          ref={list}
          id="table-search-results"
          className="menu min-h-0 w-full flex-nowrap overflow-y-auto p-0"
          role="listbox"
          aria-label="Tables"
        >
          {matches.map((match, index) => (
            <li key={`${match.schema}.${match.table}`} className="w-full">
              <button
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === selected}
                className={`flex w-full items-baseline gap-2 ${index === selected ? "menu-active" : ""}`}
                // The input keeps the focus, so the list stays keyboard-driven
                // whether the reader is typing or pointing.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => open(index)}
              >
                <span className="truncate">
                  {highlight(`${match.schema}.${match.table}`, match.hits).map((part, at) =>
                    part.matched ? (
                      <mark key={at} className="text-primary bg-transparent font-semibold">
                        {part.text}
                      </mark>
                    ) : (
                      <span key={at}>{part.text}</span>
                    ),
                  )}
                </span>
                <span className="text-base-content/50 shrink-0 text-xs">
                  {KIND_LABELS[match.kind]}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {matches.length === MATCH_LIMIT && (
          <p className="text-base-content/50 px-2 text-xs">
            The first {MATCH_LIMIT} matches. Type more to narrow them.
          </p>
        )}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">Close</button>
      </form>
    </dialog>
  );
}
