import { type KeyboardEvent, useState } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import type { Sort } from "../../bindings/Sort";
import { useToast } from "../../components/useToast";
import { saveTextFile } from "../../lib/commands";
import { describeError } from "../../lib/invoke";
import { useDriver, useTimeZone } from "../connections/hooks";
import { CellPeek } from "./CellPeek";
import { formatCell, formatCellInFull, inTimeZone } from "./cell";
import { useColumnWidths } from "./columnWidths";
import {
  type Block,
  type InsertTarget,
  toCsv,
  toInsert,
  toJson,
  toMarkdown,
  toTsv,
} from "./export";
import { GridHeader } from "./GridHeader";
import { GridMenu, type MenuItem } from "./GridMenu";
import { type GridEditing, GridRows } from "./GridRows";
import { useCellPeek } from "./peek";
import { type Bounds, type Cell, sameCell, useGridSelection } from "./selection";

type CopyFormat = "tsv" | "headers" | "markdown" | "json" | "insert";

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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { show } = useToast();
  const timeZone = useTimeZone(connectionId);
  // Only PostgreSQL's INSERT is written.
  const insertInto = useDriver(connectionId) === "postgres" ? table : undefined;

  // Everything the grid shows, measures and copies is the rows as the zone
  // reads them. A pending edit is shown as it was typed.
  const rows = result.rows.map((row) =>
    row.map((cell, column) =>
      result.columns[column]?.instant ? inTimeZone(cell, timeZone) : cell,
    ),
  );
  const last = { row: rows.length - 1, column: result.columns.length - 1 };

  const selection = useGridSelection(onSelectRow);
  const peek = useCellPeek(result);
  const { widths, startResize, reset } = useColumnWidths(result.columns, rows);

  function valueAt({ row, column }: Cell): unknown {
    const pending = editing?.pendingValue(row, result.columns[column]?.name ?? "");
    return pending === undefined ? rows[row]?.[column] : pending;
  }

  /** The cells a range holds as the grid shows them, or all of them. */
  function blockOf(range: Bounds | null): Block {
    const { top, bottom, left, right } = range ?? {
      top: 0,
      bottom: last.row,
      left: 0,
      right: last.column,
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
    if (!selection.bounds) return;
    const part = blockOf(selection.bounds);
    const only = part.rows.length === 1 && part.columns.length === 1;
    const text = {
      // One cell as the grid writes it, NULL included.
      tsv: () => (only ? formatCell(part.rows[0]?.[0] ?? null) : toTsv(part, false)),
      headers: () => toTsv(part, true),
      markdown: () => toMarkdown(part),
      json: () => toJson(part),
      insert: () => (insertInto ? toInsert(insertInto, part) : ""),
    }[format]();
    navigator.clipboard
      .writeText(text)
      .catch((error: unknown) => show(`Not copied: ${describeError(error)}`, "error"));
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

  function openMenu(cell: Cell, x: number, y: number) {
    selection.selectForMenu(cell);
    setMenu({ x, y });
  }

  /** Space shows the selected cell in full, as Quick Look opens a file. */
  function togglePeek(anchor: Cell) {
    const cell = scroller?.querySelector('[role="gridcell"][data-active]');
    if (sameCell(peek.shown?.cell ?? null, anchor)) peek.close();
    else if (cell) peek.open(anchor, cell.getBoundingClientRect());
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // A cell being edited keeps its keys: spaces, the caret and copying text.
    if (event.target !== event.currentTarget) return;
    if (selection.navigate(event, last)) {
      event.preventDefault();
      return;
    }
    if (!selection.anchor) return;
    if (event.key === " ") {
      event.preventDefault();
      togglePeek(selection.anchor);
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
        onKeyDown={handleGridKeyDown}
        // The full view is placed against a cell that scrolling moves.
        onScroll={() => peek.shown && peek.close()}
      >
        {/* The rows are as wide as their columns; the header keeps its background
          across the rest of the pane. */}
        <div className="min-w-full" style={{ width: total }}>
          <GridHeader
            columns={result.columns}
            widths={widths}
            sort={sort}
            onSort={onSortColumn}
            onResizeStart={startResize}
            onResizeReset={reset}
          />
          <GridRows
            rows={rows}
            columns={result.columns}
            widths={widths}
            scroller={scroller}
            selection={selection}
            peek={peek}
            editing={editing}
            onMenu={openMenu}
          />
        </div>
      </div>
      {peek.shown && (
        <CellPeek
          peek={peek}
          anchor={peek.shown.anchor}
          text={formatCellInFull(valueAt(peek.shown.cell))}
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
