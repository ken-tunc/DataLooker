import { ArrowDown, ArrowUp } from "lucide-react";
import type { PointerEvent } from "react";
import type { QueryResult } from "../../bindings/QueryResult";
import type { Sort } from "../../bindings/Sort";

type Column = QueryResult["columns"][number];

/** The column names, with a sort button and a resize handle on each. */
export function GridHeader({
  columns,
  widths,
  sort,
  onSort,
  onResizeStart,
  onResizeReset,
}: {
  columns: QueryResult["columns"];
  widths: number[];
  sort: Sort | null | undefined;
  onSort?: (column: string) => void;
  onResizeStart: (event: PointerEvent<HTMLElement>, index: number) => void;
  onResizeReset: (index: number) => void;
}) {
  return (
    <div className="bg-base-200 sticky top-0 z-10 flex min-w-full" role="row">
      {columns.map((column, index) => (
        // Only the name truncates: a clipped handle would be unreachable
        // on the last column.
        <div
          key={`${index}-${column.name}`}
          role="columnheader"
          aria-sort={
            sort?.column !== column.name ? undefined : sort.descending ? "descending" : "ascending"
          }
          className="relative shrink-0 px-3 py-1 font-sans font-medium"
          style={{ width: widths[index] }}
          title={`${column.name} · ${column.type_name}`}
        >
          <HeaderLabel
            column={column}
            sorted={sort?.column === column.name ? sort : null}
            onSort={onSort}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${column.name}`}
            className="hover:bg-primary absolute top-0 -right-1 z-20 h-full w-2 cursor-col-resize"
            onPointerDown={(event) => onResizeStart(event, index)}
            onDoubleClick={() => onResizeReset(index)}
          />
        </div>
      ))}
    </div>
  );
}

function HeaderLabel({
  column,
  sorted,
  onSort,
}: {
  column: Column;
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
