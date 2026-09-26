import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, RotateCw } from "lucide-react";
import { useState } from "react";
import { describeError } from "../../lib/invoke";
import { useColumnsOf, useRefreshSchemaTree, useSchemaTree } from "./hooks";
import {
  type ColumnsState,
  KIND_LABELS,
  openTables,
  tableRowId,
  type TreeRow,
  treeRows,
} from "./rows";

const ROW_HEIGHT = 26;

/** Indent per depth: a flat list has no nesting of its own. */
const INDENTS = ["pl-2", "pl-6", "pl-10", "pl-14"];

type Props = {
  connectionId: string;
  onOpenTable: (schema: string, table: string) => void;
};

export function SchemaTree({ connectionId, onOpenTable }: Props) {
  const tree = useSchemaTree(connectionId);
  const refresh = useRefreshSchemaTree(connectionId);
  // State, not a ref: see ResultGrid.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // Only open tables are read, and the cache answers a second opening.
  const columns = useColumnsOf(connectionId, openTables(expanded));
  const columnsOf = (schema: string, table: string): ColumnsState =>
    columns.get(tableRowId(schema, table)) ?? { status: "reading" };
  const rows = tree.data ? treeRows(tree.data, expanded, filter, columnsOf) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 p-2">
        <input
          className="input input-sm grow"
          placeholder="Filter tables"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          aria-label="Reload the schema"
          disabled={tree.isFetching}
          onClick={() => void refresh()}
        >
          {tree.isFetching ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <RotateCw className="size-4" />
          )}
        </button>
      </div>

      {tree.isPending && <Skeleton />}

      {tree.isError && (
        <div
          role="alert"
          className="alert alert-soft alert-error alert-vertical m-2 justify-items-start text-start text-sm"
        >
          <span className="wrap-anywhere">{describeError(tree.error)}</span>
          <button type="button" className="btn btn-xs" onClick={() => tree.refetch()}>
            Retry
          </button>
        </div>
      )}

      {tree.data && rows.length === 0 && (
        <p className="text-faint p-3 text-sm">
          {filter.trim() === "" ? "This database has no tables." : "No table matches the filter."}
        </p>
      )}

      <div ref={setScroller} className="min-h-0 flex-1 overflow-auto">
        <Rows rows={rows} scroller={scroller} onToggle={toggle} onOpenTable={onOpenTable} />
      </div>
    </div>
  );
}

function Rows({
  rows,
  scroller,
  onToggle,
  onOpenTable,
}: {
  rows: TreeRow[];
  scroller: HTMLDivElement | null;
  onToggle: (id: string) => void;
  onOpenTable: (schema: string, table: string) => void;
}) {
  // eslint-disable-next-line react/incompatible-library
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  return (
    <ul className="relative m-0 list-none p-0" style={{ height: virtual.getTotalSize() }}>
      {virtual.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        return (
          <li
            key={row.id}
            className="absolute flex w-full items-center"
            style={{ height: item.size, transform: `translateY(${item.start}px)` }}
          >
            <Row row={row} onToggle={onToggle} onOpenTable={onOpenTable} />
          </li>
        );
      })}
    </ul>
  );
}

function Row({
  row,
  onToggle,
  onOpenTable,
}: {
  row: TreeRow;
  onToggle: (id: string) => void;
  onOpenTable: (schema: string, table: string) => void;
}) {
  const indent = INDENTS[row.indent] ?? "pl-14";

  if (row.kind === "note") {
    return <span className={`text-faint truncate py-0.5 pr-2 text-xs ${indent}`}>{row.text}</span>;
  }

  if (row.kind === "column") {
    return (
      <span className={`flex w-full items-baseline gap-2 truncate py-0.5 pr-2 text-sm ${indent}`}>
        <span className="truncate">{row.name}</span>
        <span className="text-faint truncate text-xs">
          {row.dataType}
          {row.nullable ? "" : " not null"}
        </span>
      </span>
    );
  }

  // A schema or a shard group only expands. A table's row is two controls: the
  // chevron shows its columns, and the name opens the table.
  if (row.kind === "schema" || row.kind === "shards") {
    const [name, beside] =
      row.kind === "schema"
        ? [row.name, String(row.tables)]
        : [`${row.prefix}_*`, `${row.shards} shard${row.shards === 1 ? "" : "s"}`];
    return (
      <button
        type="button"
        aria-expanded={row.expanded}
        className={`hover:bg-base-200 flex w-full cursor-pointer items-baseline gap-1 py-0.5 pr-2 text-left text-sm ${row.kind === "schema" ? "font-medium" : ""} ${indent}`}
        onClick={() => onToggle(row.id)}
      >
        <Chevron expanded={row.expanded} />
        <span className="truncate">{name}</span>
        <span className="text-faint shrink-0 text-xs">{beside}</span>
      </button>
    );
  }

  return (
    <span
      className={`hover:bg-base-200 flex w-full items-baseline gap-1 py-0.5 pr-2 text-sm ${indent}`}
    >
      <button
        type="button"
        aria-expanded={row.expanded}
        aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.name}`}
        className="flex cursor-pointer self-center"
        onClick={() => onToggle(row.id)}
      >
        <Chevron expanded={row.expanded} />
      </button>
      <button
        type="button"
        className="flex min-w-0 grow cursor-pointer items-baseline gap-2 text-left"
        title={`Open ${row.schema}.${row.name}`}
        onClick={() => onOpenTable(row.schema, row.name)}
      >
        <span className="truncate">{row.name}</span>
        <span className="text-faint shrink-0 text-xs">{KIND_LABELS[row.tableKind]}</span>
      </button>
    </span>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      className={`text-faint size-3.5 shrink-0 self-center transition-transform ${expanded ? "rotate-90" : ""}`}
    />
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2 p-2">
      {["one", "two", "three", "four"].map((row) => (
        <div key={row} className="skeleton h-5 w-full" />
      ))}
    </div>
  );
}
