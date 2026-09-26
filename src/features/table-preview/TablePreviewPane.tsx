import { RotateCw } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { SqlInput } from "../../components/SqlInput";
import { ViewSwitch } from "../../components/ViewSwitch";
import type { QueryResult } from "../../bindings/QueryResult";
import { describeError, IpcError } from "../../lib/invoke";
import { formatCell } from "../query/cell";
import { ResultGrid } from "../query/ResultGrid";
import type { TableView } from "../tabs/tabs";
import {
  editCount,
  isDeleted,
  NO_EDITS,
  type PendingEdits,
  rowKeyOf,
  tableEdits,
  withDeleted,
  withEdit,
  withNewRow,
  withNewValue,
  withoutNewRow,
} from "./edits";
import {
  type TableTab,
  useCommitEdits,
  useRefreshTable,
  useTablePreview,
  useTableShape,
} from "./hooks";
import { TableStructure } from "./TableStructure";

const SHOWS = [
  { value: "rows", label: "Rows" },
  { value: "structure", label: "Structure" },
] as const satisfies readonly { value: TableView["shows"]; label: string }[];

/** The row "Remove row" acts on: a draft by its id, a stored row by its key. */
type DeleteTarget =
  | { draft: string }
  | { id: string; key: Record<string, string | null>; version: string };

type Props = {
  connectionId: string;
  tab: TableTab;
  hidden: boolean;
  onView: (view: Partial<TableView>) => void;
  /** Told whenever the pane comes to hold unsaved edits, or stops holding any. */
  onUnsaved: (unsaved: boolean) => void;
};

export function TablePreviewPane({ connectionId, tab, hidden, onView, onUnsaved }: Props) {
  // The rows keep their state while the structure is shown, but are not
  // fetched: the session runs one query at a time, and a page nobody is
  // looking at would hold up the definition that is on screen.
  const structure = tab.shows === "structure";
  // Nor while the tab is hidden: a hidden pane stays mounted, and its queries
  // would otherwise be read again whenever the window regains focus — queued
  // on the reader's session, and on BigQuery billed. Disabled rather than
  // unsubscribed: a query nobody observes is dropped from the cache after a
  // while, and the tab would come back empty.
  const rowsShown = !structure && !hidden;
  const shape = useTableShape(connectionId, tab.schema, tab.table, rowsShown);
  // A row can only be written when a primary key can name it.
  const primaryKey = shape.data?.primary_key ?? [];
  const editable = primaryKey.length > 0;
  // A fact about the table, not a failure to read its shape.
  const unwritable =
    shape.error instanceof IpcError && shape.error.kind === "Unsupported"
      ? shape.error.message
      : null;

  const preview = useTablePreview(connectionId, tab, editable, rowsShown && !shape.isPending);
  const commit = useCommitEdits(connectionId, tab.schema, tab.table);
  const { refresh, refreshing } = useRefreshTable(connectionId, tab.schema, tab.table);
  const [edits, setEdits] = useState<PendingEdits>(NO_EDITS);
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  // Applied on submit: half a predicate is a syntax error.
  const [draft, setDraft] = useState(tab.filter);

  const page = preview.data;
  const columns = page?.result.columns ?? [];
  const editingPage =
    editable && page !== undefined && page.versions.length === page.result.rows.length;
  const pending = editCount(edits);
  const unsaved = pending > 0;
  // Only a change is worth telling, and the callback is new every render.
  // eslint-disable-next-line react/exhaustive-deps
  useEffect(() => onUnsaved(unsaved), [unsaved]);

  // Drafts sit above the page's rows and shift their indexes.
  const drafts = edits.inserts;
  const shown: QueryResult | undefined = page && {
    ...page.result,
    rows: [
      ...drafts.map((row) => columns.map((column) => row.values[column.name])),
      ...page.result.rows,
    ],
  };
  const dataRow = (row: number) => row - drafts.length;

  function keyOfRow(row: number): Record<string, string | null> | null {
    const values = page?.result.rows[row];
    if (!values) return null;
    const key: Record<string, string | null> = {};
    for (const column of primaryKey) {
      const index = columns.findIndex((candidate) => candidate.name === column);
      const value = index === -1 ? undefined : values[index];
      if (value === undefined) return null;
      // An update casts this text back to the column's type.
      key[column] = value === null ? null : formatCell(value);
    }
    return key;
  }

  function edit(row: number, column: string, value: string | null) {
    const index = dataRow(row);
    const draftRow = drafts[row];
    if (draftRow) {
      setEdits((current) => withNewValue(current, draftRow.id, column, value));
      return;
    }
    const key = keyOfRow(index);
    const version = page?.versions[index];
    if (!key || version === undefined) return;
    setEdits((current) => withEdit(current, { key, version, set: {} }, column, value));
  }

  function pendingValue(row: number, column: string) {
    const draftRow = drafts[row];
    if (draftRow) return draftRow.values[column];
    const key = keyOfRow(dataRow(row));
    return key ? edits.updates[rowKeyOf(key)]?.set[column] : undefined;
  }

  function rowClass(row: number) {
    if (drafts[row]) return "bg-success/10";
    const key = keyOfRow(dataRow(row));
    return key && isDeleted(edits, key) ? "bg-error/15 line-through opacity-60" : undefined;
  }

  // A save clears the edits it started with, so a change made while it is in
  // flight would be lost.
  const editingNow = editingPage && !commit.isPending;

  /**
   * Resolved to the row itself, because a draft shifts indexes and a refetch
   * replaces rows; forgotten once the row is gone from the page.
   */
  function targetAt(row: number | null): DeleteTarget | null {
    if (row === null) return null;
    const draftRow = drafts[row];
    if (draftRow) return { draft: draftRow.id };
    const index = dataRow(row);
    const key = keyOfRow(index);
    const version = page?.versions[index];
    return key && version !== undefined ? { id: rowKeyOf(key), key, version } : null;
  }

  function stillShown(): boolean {
    if (target === null) return false;
    if ("draft" in target) return drafts.some((row) => row.id === target.draft);
    // A row with a new version changed underneath; deleting it would be
    // refused anyway.
    return (page?.result.rows ?? []).some((_, index) => {
      const key = keyOfRow(index);
      return (
        key !== null && rowKeyOf(key) === target.id && page?.versions[index] === target.version
      );
    });
  }

  function toggleDelete() {
    if (target === null || !stillShown()) return;
    if ("draft" in target) {
      setEdits((current) => withoutNewRow(current, target.draft));
      return;
    }
    setEdits((current) => withDeleted(current, target.key, target.version));
  }

  function save() {
    commit.mutate(tableEdits(connectionId, tab.schema, tab.table, edits), {
      onSuccess: () => setEdits(NO_EDITS),
    });
  }

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    onView({ filter: draft });
  }

  function sortBy(column: string) {
    onView({
      sort:
        tab.sort?.column === column
          ? { column, descending: !tab.sort.descending }
          : { column, descending: false },
    });
  }

  const rows = page?.result.rows.length ?? 0;

  return (
    <div className={`flex min-h-0 flex-1 flex-col gap-2 p-3 ${hidden ? "hidden" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium">
          {tab.schema}.{tab.table}
        </span>

        <ViewSwitch
          label="Show the table as"
          views={SHOWS}
          shown={tab.shows}
          onShow={(shows) => onView({ shows })}
        />

        {structure && <span className="grow" />}

        {!structure && (
          <form className="flex grow items-center gap-2" onSubmit={applyFilter}>
            <SqlInput
              label="Filter"
              className="input-sm grow"
              placeholder="WHERE …"
              value={draft}
              onChange={setDraft}
            />
            <button type="submit" className="btn btn-sm btn-soft">
              Filter
            </button>
          </form>
        )}
        {!structure && editingPage && (
          <>
            <button
              type="button"
              className="btn btn-sm btn-soft"
              disabled={commit.isPending}
              onClick={() => setEdits((current) => withNewRow(current, crypto.randomUUID()))}
            >
              New row
            </button>
            <button
              type="button"
              className="btn btn-sm btn-soft"
              disabled={commit.isPending || !stillShown()}
              onClick={toggleDelete}
            >
              Remove row
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          aria-label="Refresh"
          title="Refresh"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? (
            <span className="loading loading-spinner loading-xs" aria-hidden />
          ) : (
            <RotateCw className="size-4" />
          )}
        </button>
        {/* Rendered throughout: a live region that appears with its text is not announced. */}
        <span role="status" className="sr-only">
          {refreshing ? "Refreshing table…" : ""}
        </span>
      </div>

      {pending > 0 && (
        <div
          role="status"
          className="alert alert-soft alert-warning flex items-center gap-2 py-2 text-sm"
        >
          <span className="grow">
            {pending} unsaved {pending === 1 ? "change" : "changes"}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={commit.isPending}
            onClick={() => setEdits(NO_EDITS)}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={commit.isPending}
            onClick={save}
          >
            {commit.isPending && <span className="loading loading-spinner loading-xs" />}
            Save
          </button>
        </div>
      )}

      {commit.isError && (
        <div role="alert" className="alert alert-soft alert-error">
          <span className="text-sm">
            {describeError(commit.error, {
              Conflict:
                commit.error instanceof IpcError
                  ? `${commit.error.message} Reload the page to see what it holds now.`
                  : undefined,
            })}
          </span>
        </div>
      )}

      {!structure && shape.isError && !unwritable && (
        <div role="alert" className="alert alert-soft alert-error">
          <span className="text-sm">
            {describeError(shape.error)} — the rows can still be read, but nothing here knows how to
            name one, so they cannot be edited.
          </span>
        </div>
      )}

      {!structure && preview.isError && (
        <div role="alert" className="alert alert-soft alert-error">
          <span className="font-mono text-sm">{describeError(preview.error)}</span>
        </div>
      )}

      {structure ? (
        <div className="min-h-0 flex-1">
          <TableStructure
            connectionId={connectionId}
            schema={tab.schema}
            table={tab.table}
            hidden={hidden}
          />
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1">
            {shown && columns.length > 0 ? (
              <ResultGrid
                result={shown}
                sort={tab.sort}
                onSortColumn={sortBy}
                onSelectRow={(row) => setTarget(targetAt(row))}
                editing={editingNow ? { pendingValue, onEdit: edit, rowClass } : undefined}
                connectionId={connectionId}
              />
            ) : (
              <EmptyState>{preview.isPending ? "Reading the table…" : "No rows match."}</EmptyState>
            )}
          </div>

          <div className="text-muted flex items-center gap-3 text-sm">
            <button
              type="button"
              className="btn btn-sm"
              disabled={tab.page === 0 || preview.isFetching}
              onClick={() => onView({ page: tab.page - 1 })}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn-sm"
              // `truncated` means the page after this one has something in it.
              disabled={!page?.result.truncated || preview.isFetching}
              onClick={() => onView({ page: tab.page + 1 })}
            >
              Next
            </button>
            <span>
              {rows === 0 ? "No rows" : `${rows} ${rows === 1 ? "row" : "rows"}`} on page{" "}
              {tab.page + 1}
            </span>
            {page && <span>{page.result.elapsed_ms} ms</span>}
            <span className="grow" />
            <span>{unwritable ?? editingHint(editingPage, shape.isError)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function editingHint(editable: boolean, shapeFailed: boolean): string {
  if (shapeFailed) return "Read-only: the table's shape could not be read.";
  if (!editable) return "Read-only: this relation has no primary key.";
  return "Double-click a cell to edit it; ⌘⌫ sets it to NULL. A new row's empty cells take the table's defaults.";
}
