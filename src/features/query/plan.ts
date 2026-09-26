import { z } from "zod";

/** One node of a plan, with PostgreSQL's numbers as it gave them: per loop. */
export type PlanNode = {
  /** The node's type, with its join type when that is not the plain one. */
  operation: string;
  /** What it reads: a relation, a CTE or a function, and the index it goes through. */
  target: string | null;
  /** Why this node sits under its parent when not as its input: `InitPlan 1`, `SubPlan 2`. */
  role: string | null;
  estimatedRows: number;
  cost: number;
  /** Present only when the statement was carried out. */
  actual: { rows: number; loops: number; totalMs: number } | null;
  children: PlanNode[];
};

export type Plan = {
  root: PlanNode;
  planningMs: number | null;
  executionMs: number | null;
  /** Planner settings changed from their defaults, which the plan depends on. */
  settings: Record<string, string>;
};

type RawNode = {
  "Node Type": string;
  "Join Type"?: string | undefined;
  "Relation Name"?: string | undefined;
  Schema?: string | undefined;
  Alias?: string | undefined;
  "CTE Name"?: string | undefined;
  "Function Name"?: string | undefined;
  "Index Name"?: string | undefined;
  "Subplan Name"?: string | undefined;
  "Plan Rows": number;
  "Total Cost": number;
  "Actual Rows"?: number | undefined;
  "Actual Loops"?: number | undefined;
  "Actual Total Time"?: number | undefined;
  Plans?: RawNode[] | undefined;
};

// Only the keys read here; a node carries many more.
const rawNode: z.ZodType<RawNode> = z.lazy(() =>
  z.object({
    "Node Type": z.string(),
    "Join Type": z.string().optional(),
    "Relation Name": z.string().optional(),
    Schema: z.string().optional(),
    Alias: z.string().optional(),
    "CTE Name": z.string().optional(),
    "Function Name": z.string().optional(),
    "Index Name": z.string().optional(),
    "Subplan Name": z.string().optional(),
    "Plan Rows": z.number(),
    "Total Cost": z.number(),
    "Actual Rows": z.number().optional(),
    "Actual Loops": z.number().optional(),
    "Actual Total Time": z.number().optional(),
    Plans: z.array(rawNode).optional(),
  }),
);

const rawPlan = z.object({
  Plan: rawNode,
  "Planning Time": z.number().optional(),
  "Execution Time": z.number().optional(),
  Settings: z.record(z.string(), z.string()).optional(),
});

/** Null when the JSON is not a plan PostgreSQL would write. */
export function readPlan(json: unknown): Plan | null {
  const parsed = rawPlan.safeParse(json);
  if (!parsed.success) return null;
  return {
    root: node(parsed.data.Plan),
    planningMs: parsed.data["Planning Time"] ?? null,
    executionMs: parsed.data["Execution Time"] ?? null,
    settings: parsed.data.Settings ?? {},
  };
}

function node(raw: RawNode): PlanNode {
  const rows = raw["Actual Rows"];
  const loops = raw["Actual Loops"];
  const totalMs = raw["Actual Total Time"];
  return {
    operation: operation(raw),
    target: target(raw),
    role: raw["Subplan Name"] ?? null,
    estimatedRows: raw["Plan Rows"],
    cost: raw["Total Cost"],
    // A node that never ran reports loops but no time.
    actual:
      rows !== undefined && loops !== undefined ? { rows, loops, totalMs: totalMs ?? 0 } : null,
    children: (raw.Plans ?? []).map(node),
  };
}

/** As PostgreSQL's own text format names it: `Hash Left Join`, `Nested Loop Anti Join`. */
function operation(raw: RawNode): string {
  const type = raw["Node Type"];
  const join = raw["Join Type"];
  if (!join || join === "Inner") return type;
  if (type === "Nested Loop") return `${type} ${join} Join`;
  return type.replace(/ Join$/, ` ${join} Join`);
}

function target(raw: RawNode): string | null {
  const relation = raw["Relation Name"];
  const named = relation
    ? [raw.Schema, relation].filter(Boolean).join(".")
    : (raw["CTE Name"] ?? raw["Function Name"]);
  const source =
    named && raw.Alias && raw.Alias !== (relation ?? named) ? `${named} ${raw.Alias}` : named;
  const index = raw["Index Name"];
  if (source && index) return `${source} using ${index}`;
  return source ?? index ?? null;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const scan = {
    "Node Type": "Seq Scan",
    "Relation Name": "orders",
    Schema: "public",
    Alias: "o",
    "Plan Rows": 10,
    "Total Cost": 1.5,
  };

  describe("readPlan", () => {
    it("reads an estimate, which has no actual numbers", () => {
      const plan = readPlan({ Plan: scan, "Planning Time": 0.1 });

      expect(plan?.root).toEqual({
        operation: "Seq Scan",
        target: "public.orders o",
        role: null,
        estimatedRows: 10,
        cost: 1.5,
        actual: null,
        children: [],
      });
      expect(plan?.planningMs).toBe(0.1);
      expect(plan?.executionMs).toBeNull();
    });

    it("reads what an analyzed run measured, down the tree", () => {
      const plan = readPlan({
        Plan: {
          "Node Type": "Hash Join",
          "Join Type": "Left",
          "Plan Rows": 5,
          "Total Cost": 9,
          "Actual Rows": 4,
          "Actual Loops": 1,
          "Actual Total Time": 2.5,
          Plans: [
            { ...scan, "Actual Rows": 1.5, "Actual Loops": 2, "Actual Total Time": 0.3 },
            {
              "Node Type": "Index Scan",
              "Relation Name": "customers",
              Schema: "public",
              Alias: "customers",
              "Index Name": "customers_pkey",
              "Subplan Name": "SubPlan 1",
              "Plan Rows": 1,
              "Total Cost": 0.3,
              "Actual Rows": 0,
              "Actual Loops": 0,
            },
          ],
        },
        "Execution Time": 3,
        Settings: { work_mem: "64MB" },
      });

      expect(plan?.root.operation).toBe("Hash Left Join");
      expect(plan?.root.actual).toEqual({ rows: 4, loops: 1, totalMs: 2.5 });
      const [outer, inner] = plan?.root.children ?? [];
      expect(outer?.actual).toEqual({ rows: 1.5, loops: 2, totalMs: 0.3 });
      expect(inner?.target).toBe("public.customers using customers_pkey");
      expect(inner?.role).toBe("SubPlan 1");
      expect(inner?.actual).toEqual({ rows: 0, loops: 0, totalMs: 0 });
      expect(plan?.executionMs).toBe(3);
      expect(plan?.settings).toEqual({ work_mem: "64MB" });
    });

    it("names joins as the text format does", () => {
      const join = (type: string, join: string) =>
        readPlan({
          Plan: { "Node Type": type, "Join Type": join, "Plan Rows": 1, "Total Cost": 1 },
        })?.root.operation;

      expect(join("Nested Loop", "Anti")).toBe("Nested Loop Anti Join");
      expect(join("Merge Join", "Full")).toBe("Merge Full Join");
      expect(join("Hash Join", "Inner")).toBe("Hash Join");
    });

    it("refuses what is not a plan", () => {
      expect(readPlan([{ Plan: scan }])).toBeNull();
      expect(readPlan({ Plan: { "Node Type": "Seq Scan" } })).toBeNull();
    });
  });
}
