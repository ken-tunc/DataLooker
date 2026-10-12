import { History, RotateCw } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { SqlInput } from "../../components/SqlInput";
import { ViewSwitch } from "../../components/ViewSwitch";
import { describeError, IpcError } from "../../lib/invoke";
import { useDriver, useTimeZone } from "../connections/hooks";
import { ResultGrid } from "../query/ResultGrid";
import type { TableView } from "../tabs/tabs";
import { type TableTab, useRefreshTable, useTablePreview, useTableShape } from "./hooks";
import { wallClock } from "./pointInTime";
import { TableStructure } from "./TableStructure";
import { TimeTravel } from "./TimeTravel";
import { useRowEdits } from "./useRowEdits";

const SHOWS = [
  { value: "rows", label: "Rows" },
  { value: "structure", label: "Structure" },
] as const satisfies readonly { value: TableView["shows"]; label: string }[];

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
  const { refresh, refreshing } = useRefreshTable(connectionId, tab.schema, tab.table);
  // Applied on submit: half a predicate is a syntax error.
  const [draft, setDraft] = useState(tab.filter);
  // Only BigQuery keeps a table's past.
  const keepsPast = useDriver(connectionId) === "bigquery";
  const [traveling, setTraveling] = useState(tab.asOf !== null);
  const timeZone = useTimeZone(connectionId);

  const page = preview.data;
  const {
    shown,
    pageEditable,
    grid,
    pending,
    commit,
    selectRow,
    canRemove,
    toggleRemove,
    addRow,
    save,
    discard,
  } = useRowEdits(connectionId, tab, page, primaryKey);
  const unsaved = pending > 0;
  // Only a change is worth telling, and the callback is new every render.
  // eslint-disable-next-line react/exhaustive-deps
  useEffect(() => onUnsaved(unsaved), [unsaved]);

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    onView({ filter: draft });
  }

  function toggleTimeTravel() {
    // Closing it is going back to now: an open control is what says the rows
    // are from the past.
    if (traveling && tab.asOf !== null) onView({ asOf: null });
    setTraveling(!traveling);
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

        {structure ? (
          <span className="grow" />
        ) : (
          <>
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
            {pageEditable && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-soft"
                  disabled={commit.isPending}
                  onClick={addRow}
                >
                  New row
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-soft"
                  disabled={commit.isPending || !canRemove}
                  onClick={toggleRemove}
                >
                  Remove row
                </button>
              </>
            )}
            {keepsPast && (
              <button
                type="button"
                className={`btn btn-ghost btn-sm btn-square ${traveling ? "btn-active" : ""}`}
                aria-label="Time travel"
                title="Read the table as it was"
                aria-pressed={traveling}
                onClick={toggleTimeTravel}
              >
                <History className="size-4" />
              </button>
            )}
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

      {!structure && keepsPast && traveling && (
        <TimeTravel connectionId={connectionId} tab={tab} hidden={hidden} onView={onView} />
      )}

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
            onClick={discard}
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
              // Its `COMMIT` would end the reader's transaction.
              InTransaction:
                "Nothing was saved: a save would end the transaction open on this connection. Commit or roll it back in the header first.",
            })}
          </span>
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
          {shape.isError && !unwritable && (
            <div role="alert" className="alert alert-soft alert-error">
              <span className="text-sm">
                {describeError(shape.error)} — the rows can still be read, but nothing here knows
                how to name one, so they cannot be edited.
              </span>
            </div>
          )}

          {preview.isError && (
            <div role="alert" className="alert alert-soft alert-error">
              <span className="font-mono text-sm">{describeError(preview.error)}</span>
            </div>
          )}

          <div className="min-h-0 flex-1">
            {shown && shown.columns.length > 0 ? (
              <ResultGrid
                result={shown}
                sort={tab.sort}
                onSortColumn={sortBy}
                onSelectRow={selectRow}
                editing={grid}
                connectionId={connectionId}
                table={{ schema: tab.schema, table: tab.table }}
                fileName={tab.table}
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
            {tab.asOf !== null && (
              <span className="text-warning">as of {wallClock(new Date(tab.asOf), timeZone)}</span>
            )}
            <span className="grow" />
            <span>{unwritable ?? editingHint(pageEditable, shape.isError)}</span>
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
