import type { QueryPlan } from "../../bindings/QueryPlan";
import { type PlanNode, readPlan } from "./plan";

type Row = { node: PlanNode; depth: number; key: string };

/** Depth first, as PostgreSQL's text format lists it. */
function rows(node: PlanNode, depth = 0, key = "0"): Row[] {
  return [
    { node, depth, key },
    ...node.children.flatMap((child, i) => rows(child, depth + 1, `${key}.${i}`)),
  ];
}

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function ms(value: number) {
  return `${number.format(value)} ms`;
}

export function PlanView({ plan }: { plan: QueryPlan }) {
  const read = readPlan(plan.plan);
  // Not a shape this reads: what PostgreSQL said is still worth seeing.
  if (!read) {
    return (
      <pre className="hairline h-full overflow-auto rounded-box border p-3 font-mono text-xs">
        {JSON.stringify(plan.plan, null, 2)}
      </pre>
    );
  }

  const analyzed = read.root.actual !== null;
  const settings = Object.entries(read.settings);

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
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="table-pin-rows table table-xs">
          <thead>
            <tr>
              <th>Node</th>
              {analyzed && <th className="text-right">Rows</th>}
              <th className="text-right">{analyzed ? "Estimated" : "Rows"}</th>
              {analyzed && <th className="text-right">Loops</th>}
              {analyzed && <th className="text-right">Time</th>}
              <th className="text-right">Cost</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows(read.root).map(({ node, depth, key }) => (
              <tr key={key} className="hover:bg-base-200">
                <td style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
                  <span className="flex items-baseline gap-2 whitespace-nowrap">
                    {node.role && <span className="badge badge-outline badge-xs">{node.role}</span>}
                    <span className="font-medium">{node.operation}</span>
                    {node.target && (
                      <span className="text-base-content/60 font-mono">{node.target}</span>
                    )}
                  </span>
                </td>
                {analyzed && (
                  <td className="text-right">
                    {node.actual ? number.format(node.actual.rows) : ""}
                  </td>
                )}
                <td className="text-base-content/60 text-right">
                  {number.format(node.estimatedRows)}
                </td>
                {analyzed && (
                  <td className="text-right">
                    {node.actual ? number.format(node.actual.loops) : ""}
                  </td>
                )}
                {analyzed && (
                  <td className="text-right">{node.actual ? ms(node.actual.totalMs) : ""}</td>
                )}
                <td className="text-base-content/60 text-right">{number.format(node.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
