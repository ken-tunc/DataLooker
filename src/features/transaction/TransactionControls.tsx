import { useToast } from "../../components/useToast";
import { describeError } from "../../lib/invoke";
import { useEndTransaction, useTransactionState } from "./hooks";

/**
 * Says the reader's session is inside a transaction, which nothing else on
 * screen would, and ends it. A failed transaction can only be rolled back:
 * PostgreSQL answers its `COMMIT` with a rollback anyway.
 */
export function TransactionControls({ connectionId }: { connectionId: string }) {
  const { show } = useToast();
  const state = useTransactionState(connectionId).data;
  const end = useEndTransaction(connectionId);

  if (state !== "open" && state !== "failed") return null;

  function run(statement: "COMMIT" | "ROLLBACK") {
    end.mutate(statement, { onError: (error) => show(describeError(error), "error") });
  }

  return (
    <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-1">
      {state === "open" ? (
        <span
          className="badge badge-warning badge-soft badge-xs"
          title="A transaction is open on this connection's session"
        >
          Transaction open
        </span>
      ) : (
        <span
          className="badge badge-error badge-soft badge-xs"
          title="A statement failed inside the transaction; every other is refused until it is rolled back"
        >
          Transaction failed
        </span>
      )}
      {state === "open" && (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          disabled={end.isPending}
          onClick={() => run("COMMIT")}
        >
          Commit
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        disabled={end.isPending}
        onClick={() => run("ROLLBACK")}
      >
        Roll back
      </button>
    </div>
  );
}
