import type { HistoryEntry } from "../../bindings/HistoryEntry";
import { Palette } from "../../components/Palette";
import { describeError } from "../../lib/invoke";
import { useQueryHistory } from "./hooks";
import { oneLine, recentQueries } from "./history";

type Props = {
  connectionId: string;
  onOpenQuery: (sql: string) => void;
  onClose: () => void;
};

/** Local, because when a statement was run is read against the reader's own clock. */
const ranAt = (entry: HistoryEntry) =>
  new Date(entry.ran_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/**
 * Reopens a statement that was run before. It arrives in a tab of its own
 * rather than in the one in front, which is holding something the reader wrote.
 */
export function QueryHistoryPalette({ connectionId, onOpenQuery, onClose }: Props) {
  const history = useQueryHistory(connectionId);

  return (
    <Palette
      label="Reopen a query"
      placeholder="Search the queries you have run"
      search={(query) => recentQueries(history.data ?? [], query)}
      keyOf={(entry) => String(entry.id)}
      onChoose={(entry) => onOpenQuery(entry.sql)}
      onClose={onClose}
      empty="No query matches."
      status={
        history.isPending ? (
          <p className="text-base-content/60 p-2 text-sm">Reading the history…</p>
        ) : history.isError ? (
          <div role="alert" className="alert alert-error text-sm">
            <span className="truncate">{describeError(history.error)}</span>
          </div>
        ) : null
      }
    >
      {(entry) => (
        <>
          <span className="truncate font-mono">{oneLine(entry.sql)}</span>
          {/* Whose run this was, said only where it was not the reader's: the
              log is mostly theirs, and a mark on every line marks nothing. */}
          {entry.source === "agent" && (
            <span className="badge badge-ghost badge-xs shrink-0">agent</span>
          )}
          <span className="grow" />
          <span className="shrink-0 text-xs">
            {entry.error ? (
              <span className="text-error">failed</span>
            ) : (
              <span className="text-base-content/50">
                {entry.row_count} {entry.row_count === 1 ? "row" : "rows"}
              </span>
            )}
          </span>
          <span className="text-base-content/50 shrink-0 text-xs">{ranAt(entry)}</span>
        </>
      )}
    </Palette>
  );
}
