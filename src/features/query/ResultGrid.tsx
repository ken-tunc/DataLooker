import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import type { Sort } from "../../bindings/Sort";
import { formatCell, formatCellInFull } from "./cell";
import { clampColumnWidth, columnWidths } from "./columnWidths";

const ROW_HEIGHT = 28;
/** Long enough that sweeping the pointer across the grid opens nothing. */
const PEEK_DELAY_MS = 400;
/** Long enough to cross the gap from a cell to its full view. */
const PEEK_GRACE_MS = 150;

type Cell = { row: number; column: number };

/**
 * The cell shown in full and its place on the screen. The text is read from
 * the cell at each render, so an edit shows in the view; the result it was
 * opened on retires it when the rows are replaced.
 */
type Peek = { cell: Cell; anchor: DOMRect; result: QueryResult };

/** Widths the reader dragged, and the columns they were dragged for. */
type Dragged = { columns: string; widths: Record<number, number> };

/** What a grid needs to let a cell be written as well as read. */
export type GridEditing = {
  /** The text the reader has typed into a cell but not saved, if any. */
  pendingValue: (row: number, column: string) => string | null | undefined;
  onEdit: (row: number, column: string, value: string | null) => void;
  /** Classes for a row the reader has added or marked for removal. */
  rowClass?: (row: number) => string | undefined;
};

type Props = {
  result: QueryResult;
  /** Set together: a grid whose columns sort says so in its headers. */
  sort?: Sort | null;
  onSortColumn?: (column: string) => void;
  editing?: GridEditing;
  /** Told which row holds the selected cell, for whatever acts on a row. */
  onSelectRow?: (row: number | null) => void;
};

export function ResultGrid({ result, sort, onSortColumn, editing, onSelectRow }: Props) {
  // State, not a ref: React attaches a parent's ref after its children's
  // effects have run, so the virtualizer would measure nothing.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<Cell | null>(null);
  const [dragged, setDragged] = useState<Dragged>({ columns: "", widths: {} });
  const [peek, setPeek] = useState<Peek | null>(null);
  const closing = useRef<number | undefined>(undefined);
  const peekId = useId();
  const peeked = peek?.result === result ? peek : null;

  function showPeek(cell: Cell, anchor: DOMRect) {
    window.clearTimeout(closing.current);
    setPeek({ cell, anchor, result });
  }

  function valueAt({ row, column }: Cell): unknown {
    const pending = editing?.pendingValue(row, result.columns[column]?.name ?? "");
    return pending === undefined ? result.rows[row]?.[column] : pending;
  }

  // Delayed, so that the pointer can move from the cell onto the full view.
  function leavePeek() {
    window.clearTimeout(closing.current);
    closing.current = window.setTimeout(() => setPeek(null), PEEK_GRACE_MS);
  }

  function closePeek() {
    window.clearTimeout(closing.current);
    setPeek(null);
  }

  const columns = result.columns.map((column) => column.name).join("\u0000");
  // Widths dragged for other columns mean nothing here.
  const overrides = dragged.columns === columns ? dragged.widths : {};
  const widths = columnWidths(
    result.columns.map((column) => ({ name: column.name, typeName: column.type_name })),
    result.rows,
  ).map((width, index) => overrides[index] ?? width);

  function resize(event: PointerEvent<HTMLDivElement>, index: number) {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = widths[index] as number;
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: globalThis.PointerEvent) => {
      const width = clampColumnWidth(startWidth + move.clientX - startX);
      setDragged((current) => ({
        columns,
        widths: { ...(current.columns === columns ? current.widths : {}), [index]: width },
      }));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  function resetWidth(index: number) {
    setDragged((current) => {
      const { [index]: _dropped, ...rest } = current.columns === columns ? current.widths : {};
      return { columns, widths: rest };
    });
  }

  function select(cell: Cell) {
    setSelected(cell);
    onSelectRow?.(cell.row);
  }

  function move(event: KeyboardEvent<HTMLDivElement>) {
    // A cell being edited keeps its keys: spaces, the caret and copying text.
    if (!selected || event.target !== event.currentTarget) return;
    const keys: Record<string, Cell> = {
      ArrowUp: { ...selected, row: selected.row - 1 },
      ArrowDown: { ...selected, row: selected.row + 1 },
      ArrowLeft: { ...selected, column: selected.column - 1 },
      ArrowRight: { ...selected, column: selected.column + 1 },
    };
    const next = keys[event.key];
    if (next) {
      event.preventDefault();
      if (next.row < 0 || next.row >= result.rows.length) return;
      if (next.column < 0 || next.column >= result.columns.length) return;
      select(next);
      return;
    }
    // Space, as Quick Look opens a file: the full view without the pointer.
    if (event.key === " ") {
      event.preventDefault();
      const cell = scroller?.querySelector('[role="gridcell"][aria-selected="true"]');
      if (peeked?.cell.row === selected.row && peeked.cell.column === selected.column) closePeek();
      else if (cell) showPeek(selected, cell.getBoundingClientRect());
      return;
    }
    if (event.key === "c" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const cell = result.rows[selected.row]?.[selected.column];
      void navigator.clipboard.writeText(cell === undefined ? "" : formatCell(cell));
    }
  }

  const total = widths.reduce((sum, width) => sum + width, 0);

  return (
    <>
      {/* The grid takes focus so that arrows and copy reach it without a control
        inside every cell. */}
      <div
        ref={setScroller}
        className="hairline h-full overflow-auto rounded-box border font-mono text-sm outline-none"
        tabIndex={0}
        role="grid"
        onKeyDown={move}
        // The full view is placed against a cell that scrolling moves.
        onScroll={() => peeked && closePeek()}
      >
        {/* The rows are as wide as their columns; the header keeps its background
          across the rest of the pane. */}
        <div className="min-w-full" style={{ width: total }}>
          <div className="bg-base-200 sticky top-0 z-10 flex min-w-full" role="row">
            {result.columns.map((column, index) => (
              // Only the name truncates: a clipped handle would be unreachable
              // on the last column.
              <div
                key={`${index}-${column.name}`}
                role="columnheader"
                aria-sort={
                  sort?.column !== column.name
                    ? undefined
                    : sort.descending
                      ? "descending"
                      : "ascending"
                }
                className="relative shrink-0 px-3 py-1 font-sans font-medium"
                style={{ width: widths[index] }}
                title={`${column.name} · ${column.type_name}`}
              >
                <HeaderLabel
                  column={column}
                  sorted={sort?.column === column.name ? sort : null}
                  onSort={onSortColumn}
                />
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${column.name}`}
                  className="hover:bg-primary absolute top-0 -right-1 z-20 h-full w-2 cursor-col-resize"
                  onPointerDown={(event) => resize(event, index)}
                  onDoubleClick={() => resetWidth(index)}
                />
              </div>
            ))}
          </div>

          <Rows
            rows={result.rows}
            columns={result.columns}
            widths={widths}
            scroller={scroller}
            selected={selected}
            onSelect={select}
            editing={editing}
            peeked={peeked?.cell ?? null}
            peekId={peekId}
            onPeek={showPeek}
            onLeavePeek={leavePeek}
          />
        </div>
      </div>
      {peeked && (
        <CellPeek
          id={peekId}
          text={formatCellInFull(valueAt(peeked.cell))}
          anchor={peeked.anchor}
          onEnter={() => window.clearTimeout(closing.current)}
          onLeave={leavePeek}
          onClose={closePeek}
        />
      )}
    </>
  );
}

/**
 * A cell's whole value, for one the grid cuts short. A popover rather than a
 * `title`, so that a document keeps its lines and the text can be selected.
 * It sits in the top layer, above the grid's clipping and the panes' stacking.
 */
function CellPeek({
  id,
  text,
  anchor,
  onEnter,
  onLeave,
  onClose,
}: {
  id: string;
  text: string;
  anchor: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const popover = useRef<HTMLDivElement>(null);

  // Placed once its size is known: below the cell if it fits, else above,
  // and moved left rather than past the window's edge.
  useEffect(() => {
    const node = popover.current;
    if (!node) return;
    if (!node.matches(":popover-open")) node.showPopover();
    const margin = 8;
    const box = node.getBoundingClientRect();
    const below = anchor.bottom + box.height + margin <= window.innerHeight;
    node.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin))}px`;
    node.style.top = `${below ? anchor.bottom : Math.max(margin, anchor.top - box.height)}px`;
  }, [anchor, text]);

  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div
      ref={popover}
      id={id}
      popover="manual"
      role="tooltip"
      className="hairline bg-base-200 m-0 max-h-[60vh] max-w-[min(40rem,calc(100vw-1rem))] overflow-auto rounded-box border p-3 shadow-lg"
      style={{ inset: "auto", left: anchor.left, top: anchor.bottom }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <pre className="font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

function GridCell({
  value,
  column,
  width,
  selected,
  changed,
  onSelect,
  onEdit,
  describedBy,
  onPeek,
  onLeavePeek,
}: {
  value: unknown;
  column: string;
  width: number | undefined;
  selected: boolean;
  changed: boolean;
  onSelect: () => void;
  onEdit?: (value: string | null) => void;
  /** The full view's id, while it shows this cell. */
  describedBy: string | undefined;
  onPeek: (anchor: DOMRect) => void;
  onLeavePeek: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const opening = useRef<number | undefined>(undefined);
  const text = formatCell(value);

  // A cell scrolled out of the virtual window must not open a view later.
  useEffect(() => () => window.clearTimeout(opening.current), []);

  function enter(cell: HTMLDivElement) {
    opening.current = window.setTimeout(() => {
      // Only what the cell cuts short, by its width or by the lines it runs
      // together. Read off the cell as it is now, not as it was entered.
      const cut = cell.scrollWidth > cell.clientWidth || cell.textContent.includes("\n");
      if (cut) onPeek(cell.getBoundingClientRect());
    }, PEEK_DELAY_MS);
  }

  function leave() {
    window.clearTimeout(opening.current);
    onLeavePeek();
  }

  if (draft !== null && onEdit) {
    return (
      <input
        // The header is not a label for it.
        aria-label={column}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className="input input-xs shrink-0 rounded-none font-mono"
        style={{ width }}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onEdit(draft);
            setDraft(null);
          }
          if (event.key === "Escape") setDraft(null);
          // NULL, as distinct from an empty string.
          if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onEdit(null);
            setDraft(null);
          }
        }}
      />
    );
  }

  return (
    <div
      role="gridcell"
      aria-selected={selected}
      aria-describedby={describedBy}
      onClick={onSelect}
      onDoubleClick={() => onEdit && setDraft(value === null ? "" : text)}
      onPointerEnter={(event) => enter(event.currentTarget)}
      onPointerLeave={leave}
      className={[
        "shrink-0 truncate px-3 py-1",
        selected ? "bg-primary/20 ring-primary ring-1" : "",
        changed ? "bg-warning/20" : "",
        value === null ? "text-base-content/50 italic" : "",
      ].join(" ")}
      style={{ width }}
    >
      {text}
    </div>
  );
}

function HeaderLabel({
  column,
  sorted,
  onSort,
}: {
  column: QueryResult["columns"][number];
  sorted: Sort | null;
  onSort?: (column: string) => void;
}) {
  const label = (
    <>
      {column.name}
      {sorted &&
        (sorted.descending ? (
          <ArrowDown className="ml-1 inline size-3.5" />
        ) : (
          <ArrowUp className="ml-1 inline size-3.5" />
        ))}
      <span className="text-base-content/50 ml-2 font-normal lowercase">{column.type_name}</span>
    </>
  );

  if (!onSort) return <span className="block truncate">{label}</span>;
  return (
    <button
      type="button"
      className="block w-full cursor-pointer truncate text-left"
      onClick={() => onSort(column.name)}
    >
      {label}
    </button>
  );
}

/**
 * The virtualizer re-renders its component on every scroll, and the React
 * Compiler skips a component that uses it, so only the rows live here:
 * measuring the columns from this render would run on every scrolled pixel.
 */
function Rows({
  rows,
  columns,
  widths,
  scroller,
  selected,
  onSelect,
  editing,
  peeked,
  peekId,
  onPeek,
  onLeavePeek,
}: {
  rows: QueryResult["rows"];
  columns: QueryResult["columns"];
  widths: number[];
  scroller: HTMLDivElement | null;
  selected: Cell | null;
  onSelect: (cell: Cell) => void;
  editing?: GridEditing;
  peeked: Cell | null;
  peekId: string;
  onPeek: (cell: Cell, anchor: DOMRect) => void;
  onLeavePeek: () => void;
}) {
  // eslint-disable-next-line react/incompatible-library
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // The sticky header covers the top row.
    scrollPaddingStart: ROW_HEIGHT,
  });

  // Keep the row the arrows moved to in view.
  useEffect(() => {
    if (selected) virtual.scrollToIndex(selected.row);
    // eslint-disable-next-line react/exhaustive-deps
  }, [selected?.row]);

  return (
    <div className="relative" style={{ height: virtual.getTotalSize() }}>
      {virtual.getVirtualItems().map((item) => {
        const row = rows[item.index] ?? [];
        return (
          <div
            key={item.key}
            role="row"
            className={`hover:bg-base-200/60 absolute flex w-full items-center ${
              editing?.rowClass?.(item.index) ?? ""
            }`}
            style={{ height: item.size, transform: `translateY(${item.start}px)` }}
          >
            {row.map((cell, column) => {
              const name = columns[column]?.name ?? "";
              const pending = editing?.pendingValue(item.index, name);
              const value = pending === undefined ? cell : pending;
              const isSelected = selected?.row === item.index && selected.column === column;
              return (
                <GridCell
                  key={column}
                  value={value}
                  column={name}
                  width={widths[column]}
                  selected={isSelected}
                  changed={pending !== undefined}
                  onSelect={() => onSelect({ row: item.index, column })}
                  onEdit={editing ? (next) => editing.onEdit(item.index, name, next) : undefined}
                  describedBy={
                    peeked?.row === item.index && peeked.column === column ? peekId : undefined
                  }
                  onPeek={(anchor) => onPeek({ row: item.index, column }, anchor)}
                  onLeavePeek={onLeavePeek}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
