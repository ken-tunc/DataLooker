import { type KeyboardEvent, useState } from "react";
import type { ConnectionRecord } from "../../bindings/ConnectionRecord";
import type { QueryResult } from "../../bindings/QueryResult";
import { describeError, IpcError } from "../../lib/invoke";
import { formatCell } from "./cell";
import { useQueryRunner } from "./hooks";

export function QueryPanel({ connection }: { connection: ConnectionRecord }) {
  const [sql, setSql] = useState("");
  const { run, cancel } = useQueryRunner(connection.id);
  const cancelled = run.error instanceof IpcError && run.error.kind === "Cancelled";

  function submit() {
    if (sql.trim() !== "" && !run.isPending) run.mutate(sql);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{connection.label}</h2>
        <div className="flex gap-2">
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
        </div>
      </div>

      <textarea
        className="textarea h-40 w-full font-mono"
        placeholder="SELECT 1"
        spellCheck={false}
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <p className="text-base-content/60 text-xs">
        <kbd className="kbd kbd-xs">⌘</kbd> <kbd className="kbd kbd-xs">Enter</kbd> runs the query.
      </p>

      {run.isPending && <progress className="progress" />}

      {cancelled && <p className="text-base-content/60 text-sm">Cancelled.</p>}

      {run.isError && !cancelled && (
        <div role="alert" className="alert alert-error">
          <span className="font-mono text-sm">{describeError(run.error)}</span>
        </div>
      )}

      {run.isSuccess && <Result result={run.data} />}
    </section>
  );
}

function Result({ result }: { result: QueryResult }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-base-content/60 flex gap-3 text-sm">
        <span>
          {result.rows.length} {result.rows.length === 1 ? "row" : "rows"}
        </span>
        <span>{result.elapsed_ms} ms</span>
        {result.truncated && <span className="text-warning">Showing the first rows only</span>}
      </div>

      {result.columns.length === 0 ? (
        <p className="text-base-content/60 text-sm">The statement returned no rows.</p>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table className="table table-zebra table-pin-rows table-sm">
            <thead>
              <tr>
                {result.columns.map((column, index) => (
                  // A result may name two columns alike (`SELECT 1 AS a, 2 AS a`).
                  <th key={`${index}-${column.name}`}>
                    {column.name}
                    <span className="text-base-content/40 ml-2 font-normal lowercase">
                      {column.type_name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono">
              {result.rows.map((row, rowIndex) => (
                // A result set can repeat a row, and nothing here reorders them.
                // eslint-disable-next-line react/no-array-index-key
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={cell === null ? "text-base-content/40 italic" : undefined}
                    >
                      {formatCell(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
