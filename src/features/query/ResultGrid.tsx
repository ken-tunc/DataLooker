import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, useRef, useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import { formatCell } from "./cell";
import { columnWidths } from "./columnWidths";

const ROW_HEIGHT = 28;

type Cell = { row: number; column: number };

export function ResultGrid({ result }: { result: QueryResult }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Cell | null>(null);
  const widths = columnWidths(
    result.columns.map((column) => ({ name: column.name, typeName: column.type_name })),
    result.rows,
  );

  // The compiler skips this component because it cannot memoize the
  // virtualizer's callbacks. That is the right call: the grid re-renders as it
  // scrolls, and nothing memoized is handed anything from here.
  // eslint-disable-next-line react/incompatible-library
  const rows = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

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
      rows.scrollToIndex(next.row);
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
      ref={scroller}
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
            <div
              key={`${index}-${column.name}`}
              role="columnheader"
              className="shrink-0 truncate px-3 py-1 font-sans font-medium"
              style={{ width: widths[index] }}
              title={`${column.name} · ${column.type_name}`}
            >
              {column.name}
              <span className="text-base-content/40 ml-2 font-normal lowercase">
                {column.type_name}
              </span>
            </div>
          ))}
        </div>

        <div className="relative" style={{ height: rows.getTotalSize() }}>
          {rows.getVirtualItems().map((virtual) => {
            const row = result.rows[virtual.index] ?? [];
            return (
              <div
                key={virtual.key}
                role="row"
                className="hover:bg-base-200/60 absolute flex w-full items-center"
                style={{ height: virtual.size, transform: `translateY(${virtual.start}px)` }}
              >
                {row.map((cell, column) => {
                  const isSelected = selected?.row === virtual.index && selected.column === column;
                  return (
                    <div
                      key={column}
                      role="gridcell"
                      aria-selected={isSelected}
                      onClick={() => setSelected({ row: virtual.index, column })}
                      className={[
                        "shrink-0 truncate px-3 py-1",
                        isSelected ? "bg-primary/20 ring-primary ring-1" : "",
                        cell === null ? "text-base-content/40 italic" : "",
                      ].join(" ")}
                      style={{ width: widths[column] }}
                      title={formatCell(cell)}
                    >
                      {formatCell(cell)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
