import { describeError } from "../../lib/invoke";
import { DOLLARS_PER_TIB, formatBytes, formatCost } from "./format";
import { useEstimate } from "./hooks";

const DYNAMIC = "At least: the SQL that EXECUTE IMMEDIATE runs is not read by a dry run.";
const PRICING = `At on-demand pricing, $${DOLLARS_PER_TIB} per TiB. Editions and reservations bill differently.`;

/**
 * In the editor's footer: what BigQuery would bill for the statement, before
 * it is run. The bytes are the fact; the price is an estimate.
 */
export function Estimate({ connectionId, sql }: { connectionId: string; sql: string }) {
  const estimate = useEstimate(connectionId, sql);

  if (!estimate.isEnabled || estimate.empty) return null;
  if (estimate.isError) {
    const message = describeError(estimate.error);
    return (
      <span
        className={`text-error min-w-0 truncate ${estimate.stale ? "opacity-60" : ""}`}
        title={message}
      >
        {message}
      </span>
    );
  }
  if (!estimate.data) return null;

  const { bytes, at_least, unpruned } = estimate.data;
  const least = at_least ? "≥ " : "";
  const warning = unpruned
    .map((table) => `${table.table} is read whole: nothing filters on ${table.column}`)
    .join(". ");
  return (
    <span className={`flex min-w-0 items-center gap-3 ${estimate.stale ? "opacity-60" : ""}`}>
      {warning && (
        <span className="text-warning min-w-0 truncate" title={warning}>
          {warning}
        </span>
      )}
      <span className="shrink-0" title={at_least ? `${DYNAMIC} ${PRICING}` : PRICING}>
        {least}
        {formatBytes(bytes)} · {least || "≈ "}
        {formatCost(bytes)}
      </span>
    </span>
  );
}
