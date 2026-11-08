import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { describeError } from "../../lib/invoke";
import type { Ran } from "./hooks";
import { ResultGrid } from "./ResultGrid";
import { changed, said } from "./said";

const SUMMARY = "summary";

/**
 * What a run gave back. One statement shows its rows, or what it changed;
 * several get a tab each that returned rows, and a summary of every one.
 */
export function Results({ ran, connectionId }: { ran: Ran; connectionId: string }) {
  const { statements, results } = ran;
  const returning = results.flatMap((result, at) => (result.columns.length > 0 ? [at] : []));
  const [shown, setShown] = useState<number | typeof SUMMARY>(returning[0] ?? SUMMARY);

  if (statements.length === 1) {
    const result = results[0];
    if (!result) return <EmptyState>Run a query to see its rows.</EmptyState>;
    if (result.columns.length > 0) {
      return <ResultGrid result={result} connectionId={connectionId} />;
    }
    return <EmptyState>{changed(result)}.</EmptyState>;
  }

  const showing = shown === SUMMARY ? undefined : results[shown];
  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      <div role="tablist" aria-label="Results" className="tabs tabs-border tabs-xs shrink-0">
        {returning.map((at) => (
          <button
            key={at}
            type="button"
            role="tab"
            aria-selected={shown === at}
            className={`tab ${shown === at ? "tab-active" : ""}`}
            onClick={() => setShown(at)}
          >
            Statement {at + 1}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={shown === SUMMARY}
          className={`tab ${shown === SUMMARY ? "tab-active" : ""}`}
          onClick={() => setShown(SUMMARY)}
        >
          Summary
        </button>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {showing ? (
          // Keyed, so a grid's selection and scroll are not carried to another's rows.
          <ResultGrid key={shown} result={showing} connectionId={connectionId} />
        ) : (
          <Summary ran={ran} />
        )}
      </div>
    </div>
  );
}

function Summary({ ran: { statements, results, error } }: { ran: Ran }) {
  return (
    <div className="hairline h-full overflow-auto rounded-box border">
      <table className="table-sm table">
        <tbody>
          {statements.map((statement, at) => {
            const result = results[at];
            const failed = !result && at === results.length && error !== null;
            return (
              <tr key={at}>
                <td className="text-faint w-0 tabular-nums">{at + 1}</td>
                <td className="max-w-0 truncate font-mono" title={statement}>
                  {statement}
                </td>
                <td className={`w-0 whitespace-nowrap ${failed ? "text-error" : "text-muted"}`}>
                  {result ? said(result) : failed ? describeError(error) : "Not run"}
                </td>
                <td className="text-muted w-0 text-right whitespace-nowrap tabular-nums">
                  {result && `${result.elapsed_ms} ms`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
