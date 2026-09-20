import { lazy, Suspense } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import { describeError, IpcError } from "../../lib/invoke";
import { ResultGrid } from "./ResultGrid";
import { useQueryRunner } from "./hooks";

// Monaco is the heaviest thing here by far, so it arrives in its own chunk when
// a connection is opened rather than at startup.
const SqlEditor = lazy(() => import("../sql-editor/SqlEditor"));

type Props = {
  connection: ConnectionRecord;
  sql: string;
  onSqlChange: (sql: string) => void;
  hidden: boolean;
};

export function QueryTabPane({ connection, sql, onSqlChange, hidden }: Props) {
  const { run, cancel } = useQueryRunner(connection.id);
  const cancelled = run.error instanceof IpcError && run.error.kind === "Cancelled";

  function submit() {
    if (sql.trim() !== "" && !run.isPending) run.mutate(sql);
  }

  return (
    // Hidden rather than unmounted: a tab keeps its editor and its results
    // while another one is in front.
    <div className={`flex min-h-0 flex-1 flex-col gap-2 p-3 ${hidden ? "hidden" : ""}`}>
      <div className="flex items-center gap-2">
        {run.isPending ? (
          <button type="button" className="btn btn-sm" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={sql.trim() === ""}
            onClick={submit}
          >
            Run
          </button>
        )}
        <span className="text-base-content/60 text-xs">
          <kbd className="kbd kbd-xs">⌘</kbd> <kbd className="kbd kbd-xs">Enter</kbd>
        </span>
        <span className="grow" />
        <Status
          pending={run.isPending}
          cancelled={cancelled}
          error={run.isError && !cancelled ? describeError(run.error) : null}
          result={run.isSuccess ? run.data : null}
        />
      </div>

      <div className="border-base-300 h-56 shrink-0 overflow-hidden rounded-box border">
        <Suspense fallback={<div className="skeleton h-full w-full" />}>
          <SqlEditor value={sql} onChange={onSqlChange} onSubmit={submit} />
        </Suspense>
      </div>

      <div className="min-h-0 flex-1">
        {run.isSuccess && run.data.columns.length > 0 ? (
          <ResultGrid result={run.data} />
        ) : (
          <div className="border-base-300 text-base-content/50 flex h-full items-center justify-center rounded-box border border-dashed text-sm">
            {run.isSuccess ? "The statement returned no rows." : "Run a query to see its rows."}
          </div>
        )}
      </div>
    </div>
  );
}

function Status({
  pending,
  cancelled,
  error,
  result,
}: {
  pending: boolean;
  cancelled: boolean;
  error: string | null;
  result: { rows: unknown[][]; elapsed_ms: number; truncated: boolean } | null;
}) {
  if (pending) return <span className="loading loading-spinner loading-xs" />;
  if (cancelled) return <span className="text-base-content/60 text-sm">Cancelled</span>;
  if (error) return <span className="text-error truncate font-mono text-sm">{error}</span>;
  if (!result) return null;
  return (
    <span className="text-base-content/60 flex gap-3 text-sm">
      <span>
        {result.rows.length} {result.rows.length === 1 ? "row" : "rows"}
      </span>
      <span>{result.elapsed_ms} ms</span>
      {result.truncated && <span className="text-warning">first rows only</span>}
    </span>
  );
}
