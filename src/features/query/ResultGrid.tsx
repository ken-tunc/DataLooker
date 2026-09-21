import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, type PointerEvent, useEffect, useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import type { Sort } from "../../bindings/Sort";
import { formatCell } from "./cell";
import { clampColumnWidth, columnWidths } from "./columnWidths";

const ROW_HEIGHT = 28;

type Cell = { row: number; column: number };

/** Widths the reader dragged, and the columns they were dragged for. */
type Dragged = { columns: string; widths: Record<number, number> };

/** What a grid needs to let a cell be written as well as read. */
export type GridEditing = {
  /** The text the reader has typed into a cell but not saved, if any. */
  pendingValue: (row: number, column: string) => string | null | undefined;
  onEdit: (row: number, column: string, value: string | null) => void;
};

type Props = {
  result: QueryResult;
  /** Set together: a grid whose columns sort says so in its headers. */
  sort?: Sort | null;
  onSortColumn?: (column: string) => void;
  editing?: GridEditing;
};

export function ResultGrid({ result, sort, onSortColumn, editing }: Props) {
  // A ref would still be empty when the rows below measure it, because React
  // attaches a parent's ref after its children have already run their effects.
  // Holding the element in state renders them again with it in hand.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<Cell | null>(null);
  const [dragged, setDragged] = useState<Dragged>({ columns: "", widths: {} });

  const columns = result.columns.map((column) => column.name).join("\u0000");
  // A result with other columns is another table; the widths dragged for the
  // last one mean nothing to it.
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

  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (!selected) return;
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
      setSelected(next);
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
    // The grid takes focus so that arrows and copy reach it without a control
    // inside every cell.
    <div
      ref={setScroller}
      className="border-base-300 h-full overflow-auto rounded-box border font-mono text-sm outline-none"
      tabIndex={0}
      role="grid"
      onKeyDown={move}
    >
      {/* The rows are as wide as their columns; the header keeps its background
          across the rest of the pane. */}
      <div className="min-w-full" style={{ width: total }}>
        <div className="bg-base-200 sticky top-0 z-10 flex min-w-full" role="row">
          {result.columns.map((column, index) => (
            // The name truncates, the cell does not: a handle clipped by the
            // cell it sits in would be unreachable on the last column, where
            // there is no neighbour to grab instead.
            <div
              key={`${index}-${column.name}`}
              role="columnheader"
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
          onSelect={setSelected}
          editing={editing}
        />
      </div>
    </div>
  );
}

function GridCell({
  value,
  width,
  selected,
  changed,
  onSelect,
  onEdit,
}: {
  value: unknown;
  width: number | undefined;
  selected: boolean;
  changed: boolean;
  onSelect: () => void;
  onEdit?: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = formatCell(value);

  if (draft !== null && onEdit) {
    return (
      <input
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
          // A cell has to be able to hold nothing as well as an empty string.
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
      onClick={onSelect}
      onDoubleClick={() => onEdit && setDraft(value === null ? "" : text)}
      className={[
        "shrink-0 truncate px-3 py-1",
        selected ? "bg-primary/20 ring-primary ring-1" : "",
        changed ? "bg-warning/20" : "",
        value === null ? "text-base-content/40 italic" : "",
      ].join(" ")}
      style={{ width }}
      title={text}
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
      {sorted && <span className="ml-1">{sorted.descending ? "▾" : "▴"}</span>}
      <span className="text-base-content/40 ml-2 font-normal lowercase">{column.type_name}</span>
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
}: {
  rows: QueryResult["rows"];
  columns: QueryResult["columns"];
  widths: number[];
  scroller: HTMLDivElement | null;
  selected: Cell | null;
  onSelect: (cell: Cell) => void;
  editing?: GridEditing;
}) {
  // eslint-disable-next-line react/incompatible-library
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // The header sticks over the top of the scroll area, so a row scrolled to
    // the top would end up underneath it.
    scrollPaddingStart: ROW_HEIGHT,
  });

  // The selected row is the one the arrows just moved to, and the virtualizer
  // is what knows where it sits.
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
            className="hover:bg-base-200/60 absolute flex w-full items-center"
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
                  width={widths[column]}
                  selected={isSelected}
                  changed={pending !== undefined}
                  onSelect={() => onSelect({ row: item.index, column })}
                  onEdit={editing ? (next) => editing.onEdit(item.index, name, next) : undefined}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
