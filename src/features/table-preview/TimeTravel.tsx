import { type FormEvent, useEffect, useState } from "react";
import { describeError } from "../../lib/invoke";
import { useTimeZone } from "../connections/hooks";
import type { TableView } from "../tabs/tabs";
import { type TableTab, usePreviewCost } from "./hooks";
import { formatBytes, parseWallClock, wallClock } from "./pointInTime";

/**
 * The longest BigQuery keeps a table's past, in minutes. A dataset may keep
 * less, and BigQuery says so when it is asked for more.
 */
const WINDOW = 7 * 24 * 60;

/** Long enough that dragging the slider asks for one estimate, not dozens. */
const SETTLE_MS = 400;

type Props = {
  connectionId: string;
  tab: TableTab;
  onView: (view: Partial<TableView>) => void;
};

/** Picks a point in BigQuery's time-travel window to read the table at. */
export function TimeTravel({ connectionId, tab, onView }: Props) {
  const timeZone = useTimeZone(connectionId);
  // The window is measured back from when the control opened, so that the
  // slider does not creep under the reader's hand.
  const [now] = useState(Date.now);
  const [text, setText] = useState(() =>
    wallClock(new Date(tab.asOf ?? now - 60 * 60_000), timeZone),
  );
  const picked = parseWallClock(text, timeZone);
  const pickedIso = picked?.toISOString() ?? null;

  const [settled, setSettled] = useState(pickedIso);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(pickedIso), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [pickedIso]);
  const cost = usePreviewCost(connectionId, tab, settled);

  const minutesBack = picked
    ? Math.min(WINDOW, Math.max(0, Math.round((now - picked.getTime()) / 60_000)))
    : 0;

  function read(event: FormEvent) {
    event.preventDefault();
    if (pickedIso) onView({ asOf: pickedIso });
  }

  return (
    <div className="bg-base-200 flex flex-col gap-2 rounded-box p-2">
      {tab.asOf !== null && (
        <div role="status" className="alert alert-soft alert-warning py-2 text-sm">
          <span className="grow">
            Showing the table as it was at {wallClock(new Date(tab.asOf), timeZone)} ({timeZone}).
          </span>
          <button type="button" className="btn btn-sm" onClick={() => onView({ asOf: null })}>
            Back to now
          </button>
        </div>
      )}
      <form className="flex items-center gap-2" onSubmit={read}>
        <input
          type="range"
          aria-label="How far back"
          className="range range-sm grow"
          // Right is now, as on a timeline.
          min={-WINDOW}
          max={0}
          value={-minutesBack}
          onChange={(event) =>
            setText(wallClock(new Date(now + Number(event.target.value) * 60_000), timeZone))
          }
        />
        <input
          aria-label="Point in time"
          className="input input-sm w-52 font-mono"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-invalid={picked === null}
        />
        <span className="text-muted text-sm">{timeZone}</span>
        <button
          type="submit"
          className="btn btn-sm btn-soft"
          disabled={pickedIso === null || pickedIso === tab.asOf}
        >
          Read
        </button>
      </form>
      <p className="text-muted text-sm">
        {costText(picked === null, cost)} A past page is always a billed query: only the present can
        be listed for free.
      </p>
      {/* BigQuery's own words, or why this relation cannot be read in the past. */}
      {picked !== null && cost.isError && (
        <p role="alert" className="text-error font-mono text-sm">
          {describeError(cost.error)}
        </p>
      )}
    </div>
  );
}

function costText(invalid: boolean, cost: ReturnType<typeof usePreviewCost>): string {
  if (invalid) return "Write a date and a time, such as 2025-01-02 10:00:00.";
  if (cost.isError) return "What it scans could not be estimated.";
  if (cost.data === undefined) return "Estimating what it scans…";
  return `Reading a page scans ${formatBytes(cost.data.bytes)}.`;
}
