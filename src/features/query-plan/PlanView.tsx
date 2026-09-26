import { X } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import type { QueryPlan } from "../../bindings/QueryPlan";
import { stepFor } from "../../lib/keys";
import { decimal, HEAVY, ms, percent } from "./format";
import { PlanGraph } from "./PlanGraph";
import { PlanTable } from "./PlanTable";
import { type PlanNode, readPlan } from "./plan";

export type Shape = "table" | "graph";

type Row = { node: PlanNode; depth: number };

/** Depth first, as PostgreSQL's text format lists it. */
function rows(node: PlanNode, depth = 0): Row[] {
  return [{ node, depth }, ...node.children.flatMap((child) => rows(child, depth + 1))];
}

type Props = {
  plan: QueryPlan;
  /** Held by the tab, so the next plan it shows comes in the same shape. */
  shape: Shape;
  onShapeChange: (shape: Shape) => void;
};

export function PlanView({ plan, shape, onShapeChange }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  // Whichever of the table and the graph is shown takes the focus under this id.
  const surface = useId();

  const read = readPlan(plan.plan);
  // Not a shape this reads: what PostgreSQL said is still worth seeing.
  if (!read) {
    return (
      <pre className="hairline h-full overflow-auto rounded-box border p-3 font-mono text-sm">
        {JSON.stringify(plan.plan, null, 2)}
      </pre>
    );
  }

  const list = rows(read.root);
  const analyzed = read.root.actual !== null;
  // What a node's own time is a share of: the whole run, so a heavy node deep
  // down stands out as much as it weighs.
  const whole = read.executionMs ?? read.root.actual?.totalMs ?? 0;
  const settings = Object.entries(read.settings);
  const chosen = selected === null ? null : (list[selected]?.node ?? null);

  function move(event: KeyboardEvent<HTMLElement>) {
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
      <div className="hairline text-base-content/70 flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1.5 text-sm">
        <div className="join" role="group" aria-label="Show the plan as">
          {(["table", "graph"] as const).map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={shape === each}
              className={`btn btn-sm join-item ${shape === each ? "btn-primary" : "btn-ghost"}`}
              onClick={() => onShapeChange(each)}
            >
              {each === "table" ? "Table" : "Graph"}
            </button>
          ))}
        </div>
        <span>{analyzed ? "Analyzed" : "Estimated"}</span>
        {read.planningMs !== null && <span>Planning {ms(read.planningMs)}</span>}
        {read.executionMs !== null && <span>Execution {ms(read.executionMs)}</span>}
        {settings.map(([name, value]) => (
          <span key={name} className="badge badge-ghost badge-sm font-mono">
            {name} = {value}
          </span>
        ))}
        <span className="text-base-content/50 ml-auto">
          {shape === "graph" &&
            `A line is as wide as the rows it carries${analyzed ? `; amber is ${percent(HEAVY)} or more of the run` : ""}. `}
          {analyzed && "Self time is approximate: a node's time less its inputs'."}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        {shape === "table" ? (
          <PlanTable
            nodes={list}
            whole={whole}
            analyzed={analyzed}
            selected={selected}
            onSelect={setSelected}
            onKeyDown={move}
            surface={surface}
          />
        ) : (
          <PlanGraph
            root={read.root}
            nodes={list.map(({ node }) => node)}
            whole={whole}
            selected={selected}
            onSelect={setSelected}
            onKeyDown={move}
            surface={surface}
          />
        )}
        {/* Only while a node is chosen: a plan's columns need the width. */}
        {chosen && (
          <aside
            aria-label="Node details"
            className="hairline w-80 shrink-0 overflow-auto border-l px-3 py-2 text-sm"
          >
            <Details
              node={chosen}
              onClose={() => {
                setSelected(null);
                // The button that had the focus is gone; the plan takes it back.
                document.getElementById(surface)?.focus();
              }}
            />
          </aside>
        )}
      </div>
    </div>
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
          className="btn btn-ghost btn-sm btn-square"
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
