import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { QueryPlan } from "../../bindings/QueryPlan";
import { stepFor } from "../../lib/keys";
import { type PlanNode, readPlan } from "./plan";

type Row = { node: PlanNode; depth: number };

/** Depth first, as PostgreSQL's text format lists it. */
function rows(node: PlanNode, depth = 0): Row[] {
  return [{ node, depth }, ...node.children.flatMap((child) => rows(child, depth + 1))];
}

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function ms(value: number) {
  return `${decimal.format(value)} ms`;
}

export function PlanView({ plan }: { plan: QueryPlan }) {
  const [selected, setSelected] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // The keys move the selection, not the focus, so nothing else brings the row into view.
  useEffect(() => {
    scroller.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const read = readPlan(plan.plan);
  // Not a shape this reads: what PostgreSQL said is still worth seeing.
  if (!read) {
    return (
      <pre className="hairline h-full overflow-auto rounded-box border p-3 font-mono text-xs">
        {JSON.stringify(plan.plan, null, 2)}
      </pre>
    );
  }

  const list = rows(read.root);
  const analyzed = read.root.actual !== null;
  // What the bars are a share of: the whole run, so a heavy node deep down
  // stands out as much as it weighs.
  const whole = read.executionMs ?? read.root.actual?.totalMs ?? 0;
  const settings = Object.entries(read.settings);
  const chosen = selected === null ? null : (list[selected]?.node ?? null);

  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && selected !== null) {
      event.preventDefault();
      setSelected(null);
      return;
    }
    const step = stepFor(event);
    if (step === 0) return;
    event.preventDefault();
    const from = selected ?? (step > 0 ? -1 : list.length);
    setSelected(Math.min(list.length - 1, Math.max(0, from + step)));
  }

  return (
    <div className="hairline flex h-full flex-col overflow-hidden rounded-box border">
      <div className="hairline text-base-content/70 flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1.5 text-xs">
        <span>{analyzed ? "Analyzed" : "Estimated"}</span>
        {read.planningMs !== null && <span>Planning {ms(read.planningMs)}</span>}
        {read.executionMs !== null && <span>Execution {ms(read.executionMs)}</span>}
        {settings.map(([name, value]) => (
          <span key={name} className="badge badge-ghost badge-sm font-mono">
            {name} = {value}
          </span>
        ))}
        {analyzed && (
          <span className="text-base-content/50 ml-auto">
            Self time is approximate: a node's time less its inputs'.
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          ref={scroller}
          role="group"
          aria-label="Plan"
          tabIndex={0}
          className="min-h-0 min-w-0 flex-1 overflow-auto outline-none"
          onKeyDown={move}
        >
          <table className="table-pin-rows table table-xs">
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
              {list.map(({ node, depth }, index) => (
                <NodeRow
                  // The list is fixed for as long as this plan is shown.
                  // oxlint-disable-next-line no-array-index-key
                  key={index}
                  node={node}
                  depth={depth}
                  whole={whole}
                  analyzed={analyzed}
                  selected={index === selected}
                  onSelect={() => setSelected(index)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {/* Only while a node is chosen: a plan's columns need the width. */}
        {chosen && (
          <aside
            aria-label="Node details"
            className="hairline w-80 shrink-0 overflow-auto border-l px-3 py-2 text-xs"
          >
            <Details node={chosen} onClose={() => setSelected(null)} />
          </aside>
        )}
      </div>
    </div>
  );
}

function NodeRow({
  node,
  depth,
  whole,
  analyzed,
  selected,
  onSelect,
}: {
  node: PlanNode;
  depth: number;
  whole: number;
  analyzed: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const actual = node.actual;
  const never = actual !== null && actual.loops === 0;
  const share = actual && whole > 0 ? Math.min(1, actual.selfMs / whole) : 0;

  return (
    <tr
      aria-selected={selected}
      // Clear of the pinned header when scrolled to from below.
      className={`cursor-default scroll-mt-8 ${selected ? "bg-base-300" : "hover:bg-base-200"} ${never ? "opacity-50" : ""}`}
      onClick={onSelect}
    >
      <td style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
        <span className="flex items-baseline gap-2 whitespace-nowrap">
          {node.role && <span className="badge badge-outline badge-xs">{node.role}</span>}
          <span className="font-medium">{node.operation}</span>
          {node.target && <span className="text-base-content/60 font-mono">{node.target}</span>}
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
              <span className="text-base-content/50">{percent(share)}</span>
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
      {analyzed && (
        <td className="text-base-content/60 text-right">{decimal.format(node.estimatedRows)}</td>
      )}
      {analyzed && <td className="text-right">{actual ? decimal.format(actual.loops) : ""}</td>}
      <td className="text-base-content/60 text-right">{decimal.format(node.cost)}</td>
    </tr>
  );
}

function percent(share: number) {
  return `${integer.format(share * 100)}%`;
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

const GROUPS: { title: string; holds: (key: string) => boolean }[] = [
  // `Rows Removed by Filter` is a count, not a condition.
  { title: "Conditions", holds: (key) => /^(?!Rows Removed).*(Cond|Filter|Key)$/.test(key) },
  {
    title: "Rows and time",
    holds: (key) =>
      /^(Actual |Plan Rows|Plan Width|Rows Removed|Startup Cost|Total Cost)/.test(key),
  },
  { title: "Buffers", holds: (key) => /(Blocks|I\/O Read Time|I\/O Write Time|^WAL )/.test(key) },
];

function Details({ node, onClose }: { node: PlanNode; onClose: () => void }) {
  const groups = GROUPS.map(({ title, holds }) => ({
    title,
    entries: node.details.filter(([key]) => holds(key)),
  }));
  const placed = new Set(groups.flatMap(({ entries }) => entries.map(([key]) => key)));
  groups.push({ title: "Other", entries: node.details.filter(([key]) => !placed.has(key)) });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{node.operation}</div>
          {node.target && <div className="text-base-content/60 font-mono">{node.target}</div>}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square"
          aria-label="Close the details"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      {node.warnings.map((warning) => (
        <div key={warning.label} role="alert" className="alert alert-warning alert-soft py-1.5">
          <span>
            <span className="font-medium">{warning.label}.</span> {warning.why}
          </span>
        </div>
      ))}
      {groups
        .filter(({ entries }) => entries.length > 0)
        .map(({ title, entries }) => (
          <section key={title}>
            <h3 className="text-base-content/50 mb-1 font-medium">{title}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {entries.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-base-content/60 whitespace-nowrap">{key}</dt>
                  <dd className="font-mono break-words">{shown(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
    </div>
  );
}

function shown(value: unknown): string {
  if (typeof value === "number") return decimal.format(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(", ");
  }
  return JSON.stringify(value);
}
