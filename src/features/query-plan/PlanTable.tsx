import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { decimal, integer, ms, percent, shareOf } from "./format";
import type { PlanNode } from "./plan";

type Props = {
  nodes: { node: PlanNode; depth: number }[];
  /** What the bars are a share of. */
  whole: number;
  analyzed: boolean;
  selected: number | null;
  onSelect: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Put on the element that takes the focus. */
  surface: string;
};

export function PlanTable({
  nodes,
  whole,
  analyzed,
  selected,
  onSelect,
  onKeyDown,
  surface,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const rowId = useId();

  // The keys move the selection, not the focus, so nothing else brings the row into view.
  // For the same reason `aria-activedescendant` names the row to a screen reader.
  useEffect(() => {
    scroller.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-auto">
      <table
        id={surface}
        role="grid"
        aria-label="Plan"
        aria-activedescendant={selected === null ? undefined : `${rowId}-${selected}`}
        tabIndex={0}
        className="table-pin-rows table table-xs focus-visible:outline-primary outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            <th>Node</th>
            {analyzed && <th>Self time</th>}
            <th className="text-right">Rows</th>
            {analyzed && <th className="text-right">Estimated</th>}
            {analyzed && <th className="text-right">Loops</th>}
            <th className="text-right">Cost</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {nodes.map(({ node, depth }, index) => (
            <NodeRow
              // The list is fixed for as long as this plan is shown.
              // oxlint-disable-next-line no-array-index-key
              key={index}
              id={`${rowId}-${index}`}
              node={node}
              depth={depth}
              whole={whole}
              analyzed={analyzed}
              selected={index === selected}
              onSelect={() => onSelect(index)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeRow({
  id,
  node,
  depth,
  whole,
  analyzed,
  selected,
  onSelect,
}: {
  id: string;
  node: PlanNode;
  depth: number;
  whole: number;
  analyzed: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const actual = node.actual;
  const never = actual !== null && actual.loops === 0;
  const share = shareOf(actual?.selfMs, whole);

  return (
    <tr
      id={id}
      aria-selected={selected}
      // Clear of the pinned header when scrolled to from below.
      className={`cursor-default scroll-mt-8 ${selected ? "bg-base-300" : "hover:bg-base-200"} ${never ? "opacity-50" : ""}`}
      onClick={onSelect}
    >
      <td style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
        <span className="flex items-baseline gap-2 whitespace-nowrap">
          {node.role && <span className="badge badge-outline badge-xs">{node.role}</span>}
          <span className="font-medium">{node.operation}</span>
          {node.target && <span className="text-faint font-mono">{node.target}</span>}
          {node.warnings.map((warning) => (
            <span key={warning.label} className="badge badge-warning badge-xs" title={warning.why}>
              {warning.label}
            </span>
          ))}
        </span>
      </td>
      {analyzed && (
        <td className="w-48">
          {actual && !never && (
            <span className="flex items-center gap-2">
              <span className="bg-base-300 h-1.5 w-20 shrink-0 overflow-hidden rounded-full">
                <span className="bg-primary block h-full" style={{ width: `${share * 100}%` }} />
              </span>
              <span className="whitespace-nowrap">{ms(actual.selfMs)}</span>
              <span className="text-faint">{percent(share)}</span>
            </span>
          )}
        </td>
      )}
      <td className="text-right whitespace-nowrap">
        {never ? (
          "never executed"
        ) : (
          <span className="inline-flex items-center gap-1.5">
            {node.misestimate && <Misestimate {...node.misestimate} />}
            {decimal.format(actual ? actual.rows : node.estimatedRows)}
          </span>
        )}
      </td>
      {analyzed && <td className="text-muted text-right">{decimal.format(node.estimatedRows)}</td>}
      {analyzed && <td className="text-right">{actual ? decimal.format(actual.loops) : ""}</td>}
      <td className="text-muted text-right">{decimal.format(node.cost)}</td>
    </tr>
  );
}

/** A hundredfold is past a stale statistic; it is the planner guessing blind. */
function Misestimate({ factor, under }: { factor: number; under: boolean }) {
  const times = integer.format(factor);
  return (
    <span
      className={`badge badge-xs ${factor >= 100 ? "badge-error" : "badge-warning"}`}
      title={`${times}× ${under ? "more" : "fewer"} rows than the planner expected`}
    >
      {under ? "↑" : "↓"}
      {times}×
    </span>
  );
}
