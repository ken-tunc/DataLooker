import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import { formatCell } from "./cell";
import { type CellPeekState, PEEK_DELAY_MS } from "./peek";
import { type Cell, type GridSelection, holds, sameCell } from "./selection";

const ROW_HEIGHT = 28;

/** What a grid needs to let a cell be written as well as read. */
export type GridEditing = {
  /** The text the reader has typed into a cell but not saved, if any. */
  pendingValue: (row: number, column: string) => string | null | undefined;
  onEdit: (row: number, column: string, value: string | null) => void;
  /** Classes for a row the reader has added or marked for removal. */
  rowClass?: (row: number) => string | undefined;
};

/**
 * The virtualizer re-renders its component on every scroll, and the React
 * Compiler skips a component that uses it, so only the rows live here:
 * measuring the columns from this render would run on every scrolled pixel.
 */
export function GridRows({
  rows,
  columns,
  widths,
  scroller,
  selection,
  peek,
  editing,
  onMenu,
}: {
  rows: QueryResult["rows"];
  columns: QueryResult["columns"];
  widths: number[];
  scroller: HTMLDivElement | null;
  selection: GridSelection;
  peek: CellPeekState;
  editing?: GridEditing;
  onMenu: (cell: Cell, x: number, y: number) => void;
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
  const { focusRow } = selection;
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
              const at = { row: item.index, column };
              return (
                <GridCell
                  key={column}
                  value={pending === undefined ? cell : pending}
                  column={name}
                  width={widths[column]}
                  selected={holds(selection.bounds, at)}
                  active={sameCell(selection.anchor, at)}
                  changed={pending !== undefined}
                  onPress={(stretch) => selection.press(at, stretch)}
                  onDrag={() => selection.dragOver(at)}
                  onMenu={(x, y) => onMenu(at, x, y)}
                  onEdit={editing ? (next) => editing.onEdit(item.index, name, next) : undefined}
                  describedBy={sameCell(peek.shown?.cell ?? null, at) ? peek.id : undefined}
                  onPeek={(anchor) => peek.open(at, anchor)}
                  onLeavePeek={peek.leave}
                />
              );
            })}
          </div>
        );
      })}
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
