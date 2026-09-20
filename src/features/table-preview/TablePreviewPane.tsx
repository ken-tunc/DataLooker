import { type FormEvent, useState } from "react";
import { describeError } from "../../lib/invoke";
import { ResultGrid } from "../query/ResultGrid";
import type { Tab, TableView } from "../tabs/tabs";
import { useTablePreview } from "./hooks";

type TableTab = Extract<Tab, { kind: "table" }>;

type Props = {
  connectionId: string;
  tab: TableTab;
  hidden: boolean;
  onView: (view: Partial<TableView>) => void;
};

export function TablePreviewPane({ connectionId, tab, hidden, onView }: Props) {
  const preview = useTablePreview(connectionId, tab);
  // The filter applies when it is submitted, not as it is typed: half a
  // predicate is a syntax error, and every keystroke would be a query.
  const [draft, setDraft] = useState(tab.filter);

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

  const rows = preview.data?.rows.length ?? 0;

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
        {preview.isFetching && <span className="loading loading-spinner loading-xs" />}
      </div>

      {preview.isError && (
        <div role="alert" className="alert alert-error">
          <span className="font-mono text-sm">{describeError(preview.error)}</span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {preview.data && preview.data.columns.length > 0 ? (
          <ResultGrid result={preview.data} sort={tab.sort} onSortColumn={sortBy} />
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
          disabled={!preview.data?.truncated || preview.isFetching}
          onClick={() => onView({ page: tab.page + 1 })}
        >
          Next
        </button>
        <span>
          {rows === 0 ? "No rows" : `${rows} ${rows === 1 ? "row" : "rows"}`} on page {tab.page + 1}
        </span>
        {preview.data && <span>{preview.data.elapsed_ms} ms</span>}
      </div>
    </div>
  );
}
