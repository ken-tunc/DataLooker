import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useRef, useState } from "react";
import { describeError } from "../../lib/invoke";
import { useRefreshSchemaTree, useSchemaTree } from "./hooks";
import type { TableKind } from "../../bindings/TableKind";
import { type TreeRow, treeRows } from "./rows";

const KIND_LABELS: Record<TableKind, string> = {
  table: "",
  view: "view",
  materialized_view: "materialized view",
  foreign_table: "foreign table",
};

const ROW_HEIGHT = 26;

type Props = {
  connectionId: string;
  onOpenTable: (schema: string, table: string) => void;
};

export function SchemaTree({ connectionId, onOpenTable }: Props) {
  const tree = useSchemaTree(connectionId);
  const refresh = useRefreshSchemaTree(connectionId);
  const scroller = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const rows = tree.data ? treeRows(tree.data, expanded, filter) : [];

  return (
    <section className="border-base-300 flex w-72 shrink-0 flex-col border-r">
      <div className="flex items-center gap-1 p-2">
        <input
          className="input input-sm grow"
          placeholder="Filter tables"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Reload the schema"
          disabled={tree.isFetching}
          onClick={() => void refresh()}
        >
          {tree.isFetching ? <span className="loading loading-spinner loading-xs" /> : "↻"}
        </button>
      </div>

      {tree.isPending && <Skeleton />}

      {tree.isError && (
        <div role="alert" className="alert alert-error m-2 text-sm">
          <span className="truncate">{describeError(tree.error)}</span>
          <button type="button" className="btn btn-xs" onClick={() => tree.refetch()}>
            Retry
          </button>
        </div>
      )}

      {tree.data && rows.length === 0 && (
        <p className="text-base-content/60 p-3 text-sm">
          {filter.trim() === "" ? "This database has no tables." : "No table matches the filter."}
        </p>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <Rows rows={rows} scroller={scroller} onToggle={toggle} onOpenTable={onOpenTable} />
      </div>
    </section>
  );
}

function Rows({
  rows,
  scroller,
  onToggle,
  onOpenTable,
}: {
  rows: TreeRow[];
  scroller: RefObject<HTMLDivElement | null>;
  onToggle: (id: string) => void;
  onOpenTable: (schema: string, table: string) => void;
}) {
  // eslint-disable-next-line react/incompatible-library
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
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
  if (row.kind === "column") {
    return (
      <span className="flex w-full items-baseline gap-2 truncate py-0.5 pr-2 pl-10 text-sm">
        <span className="truncate">{row.name}</span>
        <span className="text-base-content/50 truncate text-xs">
          {row.dataType}
          {row.nullable ? "" : " not null"}
        </span>
      </span>
    );
  }

  // A schema's row is one control — it only expands — while a table's row is
  // two: the chevron shows its columns, and the name (with the space after it)
  // opens the table.
  if (row.kind === "schema") {
    return (
      <button
        type="button"
        aria-expanded={row.expanded}
        className="hover:bg-base-200 flex w-full cursor-pointer items-baseline gap-1 py-0.5 pr-2 pl-2 text-left text-sm font-medium"
        onClick={() => onToggle(row.id)}
      >
        <Chevron expanded={row.expanded} />
        <span className="truncate">{row.name}</span>
        <span className="text-base-content/50 shrink-0 text-xs">{row.tables}</span>
      </button>
    );
  }

  return (
    <span className="hover:bg-base-200 flex w-full items-baseline gap-1 py-0.5 pr-2 pl-6 text-sm">
      <button
        type="button"
        aria-expanded={row.expanded}
        aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.name}`}
        className="cursor-pointer"
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
        <span className="text-base-content/50 shrink-0 text-xs">
          {KIND_LABELS[row.tableKind] || row.columns}
        </span>
      </button>
    </span>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return <span className="text-base-content/40 w-3 shrink-0 text-xs">{expanded ? "▾" : "▸"}</span>;
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
