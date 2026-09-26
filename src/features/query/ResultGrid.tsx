import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import type { Sort } from "../../bindings/Sort";
import { useToast } from "../../components/useToast";
import { saveTextFile } from "../../lib/files";
import { describeError } from "../../lib/invoke";
import { useDriver, useTimeZone } from "../connections/hooks";
import { formatCell, formatCellInFull, inTimeZone } from "./cell";
import { clampColumnWidth, columnWidths } from "./columnWidths";
import {
  type Block,
  type InsertTarget,
  toCsv,
  toInsert,
  toJson,
  toMarkdown,
  toTsv,
} from "./export";

const ROW_HEIGHT = 28;
/** Long enough that sweeping the pointer across the grid opens nothing. */
const PEEK_DELAY_MS = 400;
/** Long enough to cross the gap from a cell to its full view. */
const PEEK_GRACE_MS = 150;

type Cell = { row: number; column: number };

/**
 * A rectangle of cells, from the cell the reader started at, which the
 * keys that act on one cell act on, to the corner the range was stretched to.
 */
type Selection = { anchor: Cell; focus: Cell };

type Bounds = { top: number; bottom: number; left: number; right: number };

function boundsOf({ anchor, focus }: Selection): Bounds {
  return {
    top: Math.min(anchor.row, focus.row),
    bottom: Math.max(anchor.row, focus.row),
    left: Math.min(anchor.column, focus.column),
    right: Math.max(anchor.column, focus.column),
  };
}

function holds(bounds: Bounds | null, { row, column }: Cell): boolean {
  return (
    bounds !== null &&
    row >= bounds.top &&
    row <= bounds.bottom &&
    column >= bounds.left &&
    column <= bounds.right
  );
}

type CopyFormat = "tsv" | "headers" | "markdown" | "json" | "insert";

type MenuItem = { label: string; keys?: string; run: () => void } | "divider";

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
  /** Whose zone points in time are shown in. */
  connectionId: string;
  /** The table the rows are, if they are one table's. */
  table?: InsertTarget;
  /** What a saved file is called unless the reader says otherwise. */
  fileName?: string;
};

export function ResultGrid({
  result,
  sort,
  onSortColumn,
  editing,
  onSelectRow,
  connectionId,
  table,
  fileName = "result",
}: Props) {
  // State, not a ref: React attaches a parent's ref after its children's
  // effects have run, so the virtualizer would measure nothing.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const { show } = useToast();
  const [dragged, setDragged] = useState<Dragged>({ columns: "", widths: {} });
  const [peek, setPeek] = useState<Peek | null>(null);
  const closing = useRef<number | undefined>(undefined);
  const peekId = useId();
  const timeZone = useTimeZone(connectionId);
  // Only PostgreSQL's INSERT is written.
  const insertInto = useDriver(connectionId) === "postgres" ? table : undefined;
  const peeked = peek?.result === result ? peek : null;
  const selected = selection?.anchor ?? null;
  const bounds = selection && boundsOf(selection);
  // Everything the grid shows, measures and copies is the rows as the zone
  // reads them. A pending edit is shown as it was typed.
  const rows = result.rows.map((row) =>
    row.map((cell, column) =>
      result.columns[column]?.instant ? inTimeZone(cell, timeZone) : cell,
    ),
  );

  function showPeek(cell: Cell, anchor: DOMRect) {
    window.clearTimeout(closing.current);
    setPeek({ cell, anchor, result });
  }

  function valueAt({ row, column }: Cell): unknown {
    const pending = editing?.pendingValue(row, result.columns[column]?.name ?? "");
    return pending === undefined ? rows[row]?.[column] : pending;
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
    rows,
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
    setSelection({ anchor: cell, focus: cell });
    onSelectRow?.(cell.row);
  }

  function extend(focus: Cell) {
    setSelection((current) => (current ? { ...current, focus } : { anchor: focus, focus }));
  }

  function press(cell: Cell, stretch: boolean) {
    if (stretch && selection) extend(cell);
    else select(cell);
    // Pressed and dragged, the range follows the pointer until it is let go.
    dragging.current = true;
    window.addEventListener("pointerup", () => (dragging.current = false), { once: true });
  }

  function openMenu(cell: Cell, x: number, y: number) {
    // As a spreadsheet does: the menu acts on the range it was opened in.
    if (!holds(bounds, cell)) select(cell);
    setMenu({ x, y });
  }

  /** The cells a range holds as the grid shows them, or all of them. */
  function blockOf(range: Bounds | null): Block {
    const { top, bottom, left, right } = range ?? {
      top: 0,
      bottom: rows.length - 1,
      left: 0,
      right: result.columns.length - 1,
    };
    const columnIndexes = result.columns.map((_, index) => index).slice(left, right + 1);
    const cells = rows.slice(top, bottom + 1).map((_, offset) => top + offset);
    return {
      columns: result.columns.slice(left, right + 1),
      rows: cells.map((row) => columnIndexes.map((column) => valueAt({ row, column }))),
      typed: cells.map((row) =>
        columnIndexes.map(
          (column) => editing?.pendingValue(row, result.columns[column]?.name ?? "") !== undefined,
        ),
      ),
    };
  }

  function copy(format: CopyFormat) {
    if (!bounds) return;
    const part = blockOf(bounds);
    const only = part.rows.length === 1 && part.columns.length === 1;
    const text = {
      // One cell as the grid writes it, NULL included.
      tsv: () => (only ? formatCell(part.rows[0]?.[0] ?? null) : toTsv(part, false)),
      headers: () => toTsv(part, true),
      markdown: () => toMarkdown(part),
      json: () => toJson(part),
      insert: () => (insertInto ? toInsert(insertInto, part) : ""),
    }[format]();
    void navigator.clipboard.writeText(text);
  }

  async function save(extension: "csv" | "json") {
    const all = blockOf(null);
    try {
      const file = await saveTextFile(
        fileName,
        extension,
        extension === "csv" ? toCsv(all) : toJson(all),
      );
      if (file === null) return;
      const count = `${all.rows.length} ${all.rows.length === 1 ? "row" : "rows"}`;
      if (result.truncated) {
        show(`Saved ${count} to ${file} — only the rows shown, not all there are.`, "info");
      } else {
        show(`Saved ${count} to ${file}.`, "success");
      }
    } catch (error) {
      show(`${fileName}.${extension} was not saved: ${describeError(error)}`, "error");
    }
  }

  const menuItems: MenuItem[] = [
    { label: "Copy", keys: "⌘C", run: () => copy("tsv") },
    { label: "Copy with headers", run: () => copy("headers") },
    { label: "Copy as Markdown", run: () => copy("markdown") },
    { label: "Copy as JSON", run: () => copy("json") },
    ...(insertInto ? [{ label: "Copy as INSERT", run: () => copy("insert") }] : []),
    "divider",
    { label: "Save all as CSV…", run: () => void save("csv") },
    { label: "Save all as JSON…", run: () => void save("json") },
  ];

  function move(event: KeyboardEvent<HTMLDivElement>) {
    // A cell being edited keeps its keys: spaces, the caret and copying text.
    if (event.target !== event.currentTarget) return;
    const last = { row: rows.length - 1, column: result.columns.length - 1 };
    if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (last.row < 0) return;
      setSelection({ anchor: { row: 0, column: 0 }, focus: last });
      onSelectRow?.(0);
      return;
    }
    if (!selection || !selected) return;
    const steps: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      // Shift stretches the range from its far corner; ⌘ goes to the edge.
      const from = event.shiftKey ? selection.focus : selected;
      const [down, across] = step;
      const toward = (at: number, by: number, end: number) =>
        !event.metaKey ? at + by : by < 0 ? 0 : by > 0 ? end : at;
      const next = {
        row: toward(from.row, down, last.row),
        column: toward(from.column, across, last.column),
      };
      if (next.row < 0 || next.row > last.row) return;
      if (next.column < 0 || next.column > last.column) return;
      if (event.shiftKey) extend(next);
      else select(next);
      return;
    }
    // Space, as Quick Look opens a file: the full view without the pointer.
    if (event.key === " ") {
      event.preventDefault();
      const cell = scroller?.querySelector('[role="gridcell"][data-active]');
      if (peeked?.cell.row === selected.row && peeked.cell.column === selected.column) closePeek();
      else if (cell) showPeek(selected, cell.getBoundingClientRect());
      return;
    }
    if (event.key === "c" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      copy("tsv");
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
        aria-multiselectable
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
            rows={rows}
            columns={result.columns}
            widths={widths}
            scroller={scroller}
            bounds={bounds}
            anchor={selected}
            focusRow={selection?.focus.row ?? null}
            onPress={press}
            onDrag={(cell) => dragging.current && extend(cell)}
            onMenu={openMenu}
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
      {menu && (
        <GridMenu
          at={menu}
          items={menuItems}
          onClose={() => {
            setMenu(null);
            scroller?.focus();
          }}
        />
      )}
    </>
  );
}

/**
 * What can be done with the selected cells. A manual popover: an automatic
 * one would be dismissed by the very right-click that opened it, whose
 * pointer is let go outside it.
 */
function GridMenu({
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
              {item.keys && <kbd className="kbd kbd-xs">{item.keys}</kbd>}
            </button>
          </li>
        ),
      )}
    </ul>
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
  active,
  changed,
  onPress,
  onDrag,
  onMenu,
  onEdit,
  describedBy,
  onPeek,
  onLeavePeek,
}: {
  value: unknown;
  column: string;
  width: number | undefined;
  /** In the selected range. */
  selected: boolean;
  /** The one cell the range started at. */
  active: boolean;
  changed: boolean;
  onPress: (stretch: boolean) => void;
  onDrag: () => void;
  onMenu: (x: number, y: number) => void;
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
      data-active={active || undefined}
      aria-describedby={describedBy}
      onPointerDown={(event) => event.button === 0 && onPress(event.shiftKey)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      onDoubleClick={() => onEdit && setDraft(value === null ? "" : text)}
      onPointerEnter={(event) => {
        // The button, not only the drag having begun: one let go outside the
        // window sends no pointerup here.
        if (event.buttons & 1) onDrag();
        enter(event.currentTarget);
      }}
      onPointerLeave={leave}
      className={[
        "shrink-0 truncate px-3 py-1 select-none",
        selected ? "bg-primary/20" : "",
        active ? "ring-primary ring-1" : "",
        changed ? "bg-warning/20" : "",
        value === null ? "text-faint italic" : "",
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
      <span className="text-faint ml-2 font-normal lowercase">{column.type_name}</span>
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
  bounds,
  anchor,
  focusRow,
  onPress,
  onDrag,
  onMenu,
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
  bounds: Bounds | null;
  anchor: Cell | null;
  /** The row the range was last stretched to, which is kept in view. */
  focusRow: number | null;
  onPress: (cell: Cell, stretch: boolean) => void;
  onDrag: (cell: Cell) => void;
  onMenu: (cell: Cell, x: number, y: number) => void;
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
    if (focusRow !== null) virtual.scrollToIndex(focusRow);
    // eslint-disable-next-line react/exhaustive-deps
  }, [focusRow]);

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
              const at = { row: item.index, column };
              return (
                <GridCell
                  key={column}
                  value={value}
                  column={name}
                  width={widths[column]}
                  selected={holds(bounds, at)}
                  active={anchor?.row === item.index && anchor.column === column}
                  changed={pending !== undefined}
                  onPress={(stretch) => onPress(at, stretch)}
                  onDrag={() => onDrag(at)}
                  onMenu={(x, y) => onMenu(at, x, y)}
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
