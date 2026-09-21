import { type FormEvent, useState } from "react";
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
import { type TableTab, useCommitEdits, useTablePreview, useTableShape } from "./hooks";

type Props = {
  connectionId: string;
  tab: TableTab;
  hidden: boolean;
  onView: (view: Partial<TableView>) => void;
};

export function TablePreviewPane({ connectionId, tab, hidden, onView }: Props) {
  const shape = useTableShape(connectionId, tab.schema, tab.table);
  // A row can only be written when it can be named, which is what a primary
  // key is for. A view has none, and neither has a table nobody gave one.
  const primaryKey = shape.data?.primary_key ?? [];
  const editable = primaryKey.length > 0;

  const preview = useTablePreview(connectionId, tab, editable, !shape.isPending);
  const commit = useCommitEdits(connectionId, tab.schema, tab.table);
  const [edits, setEdits] = useState<PendingEdits>(NO_EDITS);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  // The filter applies when it is submitted, not as it is typed: half a
  // predicate is a syntax error, and every keystroke would be a query.
  const [draft, setDraft] = useState(tab.filter);

  const page = preview.data;
  const columns = page?.result.columns ?? [];
  const editingPage =
    editable && page !== undefined && page.versions.length === page.result.rows.length;
  const pending = editCount(edits);

  // New rows sit above the table's own, so a row index below their count is a
  // draft and the rest are the page's, shifted by it.
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
      // The text of a cell is what an update casts back to the column's type.
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

  function toggleDelete() {
    if (selectedRow === null) return;
    const draftRow = drafts[selectedRow];
    if (draftRow) {
      setEdits((current) => withoutNewRow(current, draftRow.id));
      return;
    }
    const index = dataRow(selectedRow);
    const key = keyOfRow(index);
    const version = page?.versions[index];
    if (!key || version === undefined) return;
    setEdits((current) => withDeleted(current, key, version));
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
        <form className="flex grow items-center gap-2" onSubmit={applyFilter}>
          <input
            className="input input-sm grow font-mono"
            placeholder="WHERE …"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn btn-sm">
            Filter
          </button>
        </form>
        {editingPage && (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setEdits((current) => withNewRow(current, crypto.randomUUID()))}
            >
              New row
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={selectedRow === null}
              onClick={toggleDelete}
            >
              Remove row
            </button>
          </>
        )}
        {preview.isFetching && <span className="loading loading-spinner loading-xs" />}
      </div>

      {pending > 0 && (
        <div className="bg-warning/15 flex items-center gap-2 rounded-box px-3 py-2 text-sm">
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
        <div role="alert" className="alert alert-error">
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

      {shape.isError && (
        <div role="alert" className="alert alert-error">
          <span className="text-sm">
            {describeError(shape.error)} — the rows can still be read, but nothing here knows how to
            name one, so they cannot be edited.
          </span>
        </div>
      )}

      {preview.isError && (
        <div role="alert" className="alert alert-error">
          <span className="font-mono text-sm">{describeError(preview.error)}</span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {shown && columns.length > 0 ? (
          <ResultGrid
            result={shown}
            sort={tab.sort}
            onSortColumn={sortBy}
            onSelectRow={setSelectedRow}
            editing={editingPage ? { pendingValue, onEdit: edit, rowClass } : undefined}
          />
        ) : (
          <div className="border-base-300 text-base-content/50 flex h-full items-center justify-center rounded-box border border-dashed text-sm">
            {preview.isPending ? "Reading the table…" : "No rows match."}
          </div>
        )}
      </div>

      <div className="text-base-content/60 flex items-center gap-3 text-sm">
        <button
          type="button"
          className="btn btn-xs"
          disabled={tab.page === 0 || preview.isFetching}
          onClick={() => onView({ page: tab.page - 1 })}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn btn-xs"
          // `truncated` means the page after this one has something in it.
          disabled={!page?.result.truncated || preview.isFetching}
          onClick={() => onView({ page: tab.page + 1 })}
        >
          Next
        </button>
        <span>
          {rows === 0 ? "No rows" : `${rows} ${rows === 1 ? "row" : "rows"}`} on page {tab.page + 1}
        </span>
        {page && <span>{page.result.elapsed_ms} ms</span>}
        <span className="grow" />
        <span>{editingHint(editingPage, shape.isError)}</span>
      </div>
    </div>
  );
}

function editingHint(editable: boolean, shapeFailed: boolean): string {
  if (shapeFailed) return "Read-only: the table's shape could not be read.";
  if (!editable) return "Read-only: this relation has no primary key.";
  return "Double-click a cell to edit it; ⌘⌫ sets it to NULL. A new row's empty cells take the table's defaults.";
}
