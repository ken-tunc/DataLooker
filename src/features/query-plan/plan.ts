import { z } from "zod";

/** What an analyzed run measured of a node. */
export type Measured = {
  /** Per loop, as PostgreSQL gives them. */
  rows: number;
  loops: number;
  /** The node and everything under it, over all its loops. */
  totalMs: number;
  /** Its share alone: `totalMs` less what its inputs took. */
  selfMs: number;
};

export type Warning = { label: string; why: string };

/** One node of a plan. */
export type PlanNode = {
  /** The node's type, with its join type when that is not the plain one. */
  operation: string;
  /** What it reads: a relation, a CTE or a function, and the index it goes through. */
  target: string | null;
  /** Why this node sits under its parent when not as its input: `InitPlan 1`, `SubPlan 2`. */
  role: string | null;
  /** Per loop. */
  estimatedRows: number;
  cost: number;
  /** Present only when the statement was carried out. */
  actual: Measured | null;
  /** How far the rows the planner expected were from those that came, when that is tenfold or more. */
  misestimate: { factor: number; under: boolean } | null;
  warnings: Warning[];
  /** Every key PostgreSQL wrote for the node, in its order, but its children. */
  details: [string, unknown][];
  children: PlanNode[];
};

export type Plan = {
  root: PlanNode;
  planningMs: number | null;
  executionMs: number | null;
  /** Planner settings changed from their defaults, which the plan depends on. */
  settings: Record<string, string>;
};

/** A misestimate is flagged from this factor on; a plan is rarely closer than two or three. */
const MISESTIMATE = 10;

type RawNode = {
  "Node Type": string;
  "Plan Rows": number;
  "Total Cost": number;
  Plans?: RawNode[] | undefined;
  [key: string]: unknown;
};

// Only the keys every node has are checked; the rest are read where used.
const rawNode: z.ZodType<RawNode> = z.lazy(() =>
  z.looseObject({
    "Node Type": z.string(),
    "Plan Rows": z.number(),
    "Total Cost": z.number(),
    Plans: z.array(rawNode).optional(),
  }),
);

const rawPlan = z.object({
  Plan: rawNode,
  "Planning Time": z.number().optional(),
  "Execution Time": z.number().optional(),
  Settings: z.record(z.string(), z.string()).optional(),
});

function text(raw: RawNode, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

function number(raw: RawNode, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" ? value : undefined;
}

/** Null when the JSON is not a plan PostgreSQL would write. */
export function readPlan(json: unknown): Plan | null {
  const parsed = rawPlan.safeParse(json);
  if (!parsed.success) return null;
  const root = parsed.data.Plan;
  const ctes = new Map<string, number>();
  collectCtes(root, null, ctes);
  return {
    root: node(root, null, ctes),
    planningMs: parsed.data["Planning Time"] ?? null,
    executionMs: parsed.data["Execution Time"] ?? null,
    settings: parsed.data.Settings ?? {},
  };
}

/**
 * How long a node took, over all its loops, as the wall clock saw it.
 * `Actual Total Time` is per loop, and in a parallel part of the plan it is
 * the average over the processes that ran the node, which ran side by side:
 * multiplying by the loops would add up the processes' time instead.
 */
function wallMs(raw: RawNode, processes: number | null): number | null {
  const time = number(raw, "Actual Total Time");
  const loops = number(raw, "Actual Loops");
  if (loops === undefined) return null;
  if (time === undefined || loops === 0) return 0;
  const alongside = processes === null ? 1 : Math.min(loops, processes);
  return (time * loops) / alongside;
}

/** How many processes run what sits under a node: those a `Gather` launched and itself. */
function processesUnder(raw: RawNode, processes: number | null): number | null {
  if (!raw["Node Type"].startsWith("Gather")) return processes;
  return (number(raw, "Workers Launched") ?? 0) + 1;
}

const CTE = /^CTE (.+)$/;

/** A CTE's own plan, by name, with how long it took in all. */
function collectCtes(raw: RawNode, processes: number | null, ctes: Map<string, number>) {
  const name = text(raw, "Subplan Name")?.match(CTE)?.[1];
  if (name) ctes.set(name, wallMs(raw, processes) ?? 0);
  const under = processesUnder(raw, processes);
  for (const child of raw.Plans ?? []) collectCtes(child, under, ctes);
}

function node(raw: RawNode, processes: number | null, ctes: Map<string, number>): PlanNode {
  const under = processesUnder(raw, processes);
  const children = raw.Plans ?? [];
  return {
    operation: operation(raw),
    target: target(raw),
    role: text(raw, "Subplan Name") ?? null,
    estimatedRows: raw["Plan Rows"],
    cost: raw["Total Cost"],
    actual: measured(raw, processes, under, ctes),
    misestimate: misestimate(raw),
    warnings: warnings(raw),
    details: Object.entries(raw).filter(([key]) => key !== "Plans"),
    children: children.map((child) => node(child, under, ctes)),
  };
}

/**
 * A node's time holds its inputs', and the time of any InitPlan or SubPlan
 * it evaluates. A CTE is the exception: its plan hangs under the node that
 * defines it, but its time lands in the CTE Scans that read it, so it is taken
 * from those instead. An InitPlan evaluated further down, as by a `Gather`
 * that hands its value to the workers, is counted there as well as here; the
 * floor at zero keeps that from showing as negative time.
 */
function measured(
  raw: RawNode,
  processes: number | null,
  under: number | null,
  ctes: Map<string, number>,
): Measured | null {
  const rows = number(raw, "Actual Rows");
  const loops = number(raw, "Actual Loops");
  const totalMs = wallMs(raw, processes);
  if (rows === undefined || loops === undefined || totalMs === null) return null;

  let inputsMs = 0;
  for (const child of raw.Plans ?? []) {
    if (CTE.test(text(child, "Subplan Name") ?? "")) continue;
    inputsMs += wallMs(child, under) ?? 0;
  }
  if (raw["Node Type"] === "CTE Scan") inputsMs += ctes.get(text(raw, "CTE Name") ?? "") ?? 0;

  return { rows, loops, totalMs, selfMs: Math.max(0, totalMs - inputsMs) };
}

function misestimate(raw: RawNode): PlanNode["misestimate"] {
  const rows = number(raw, "Actual Rows");
  // A node that never ran says nothing of the estimate.
  if (rows === undefined || !number(raw, "Actual Loops")) return null;
  // Both are per loop; a row counted as one keeps an empty side from dividing by zero.
  const actual = Math.max(rows, 1);
  const estimated = Math.max(raw["Plan Rows"], 1);
  const factor = Math.max(actual, estimated) / Math.min(actual, estimated);
  return factor >= MISESTIMATE ? { factor, under: actual > estimated } : null;
}

/** Only what the plan states outright, not a judgement of the query. */
function warnings(raw: RawNode): Warning[] {
  const found: Warning[] = [];
  if (text(raw, "Sort Space Type") === "Disk") {
    found.push({ label: "Sort on disk", why: "The sort did not fit in work_mem." });
  }
  const hashBatches = number(raw, "Hash Batches") ?? 0;
  if (hashBatches > 1) {
    found.push({
      label: `Hash in ${hashBatches} batches`,
      why: "The hash table did not fit in work_mem and was split through temporary files.",
    });
  }
  const aggBatches = number(raw, "HashAgg Batches") ?? 0;
  if (aggBatches > 1) {
    found.push({
      label: `Aggregate in ${aggBatches} batches`,
      why: "The groups did not fit in work_mem and were split through temporary files.",
    });
  }
  // Mostly a spill named above; said alone only when nothing else explains it.
  if (found.length === 0 && (number(raw, "Temp Written Blocks") ?? 0) > 0) {
    found.push({ label: "Temporary files", why: "The node wrote temporary files." });
  }
  if ((number(raw, "Lossy Heap Blocks") ?? 0) > 0) {
    found.push({
      label: "Lossy bitmap",
      why: "The bitmap outgrew work_mem and kept pages rather than rows, so every row on them was checked again.",
    });
  }
  const planned = number(raw, "Workers Planned");
  const launched = number(raw, "Workers Launched");
  if (planned !== undefined && launched !== undefined && launched < planned) {
    found.push({
      label: `${launched} of ${planned} workers`,
      why: "Fewer parallel workers were free than the plan asked for.",
    });
  }
  const removed = number(raw, "Rows Removed by Filter") ?? 0;
  const kept = number(raw, "Actual Rows") ?? 0;
  const loops = number(raw, "Actual Loops") ?? 0;
  // Per loop, like the rows it kept; 1,000 in all keeps a small table quiet.
  if (removed * loops >= 1_000 && removed / (removed + kept) >= 0.9) {
    const share = Math.floor((removed / (removed + kept)) * 100);
    found.push({
      label: `Filter discarded ${share}%`,
      why: "Most rows read were thrown away; an index on the filtered columns might read only those kept.",
    });
  }
  return found;
}

/** As PostgreSQL's own text format names it: `Hash Left Join`, `Nested Loop Anti Join`. */
function operation(raw: RawNode): string {
  const type = raw["Node Type"];
  const join = text(raw, "Join Type");
  if (!join || join === "Inner") return type;
  if (type === "Nested Loop") return `${type} ${join} Join`;
  return type.replace(/ Join$/, ` ${join} Join`);
}

function target(raw: RawNode): string | null {
  const relation = text(raw, "Relation Name");
  const alias = text(raw, "Alias");
  const named = relation
    ? [text(raw, "Schema"), relation].filter(Boolean).join(".")
    : (text(raw, "CTE Name") ?? text(raw, "Function Name"));
  const source = named && alias && alias !== (relation ?? named) ? `${named} ${alias}` : named;
  const index = text(raw, "Index Name");
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

  /** A node an analyzed run measured, with nothing but what the timing reads. */
  function ran(type: string, ms: number, loops: number, rest: Record<string, unknown> = {}) {
    return {
      "Node Type": type,
      "Plan Rows": 1,
      "Total Cost": 1,
      "Actual Rows": 1,
      "Actual Loops": loops,
      "Actual Total Time": ms,
      ...rest,
    };
  }

  function selfTimes(node: PlanNode | undefined): number[] {
    if (!node) return [];
    const self = node.actual ? Math.round(node.actual.selfMs * 100) / 100 : NaN;
    return [self, ...node.children.flatMap(selfTimes)];
  }

  describe("readPlan", () => {
    it("reads an estimate, which has no actual numbers", () => {
      const plan = readPlan({ Plan: scan, "Planning Time": 0.1 });

      expect(plan?.root).toMatchObject({
        operation: "Seq Scan",
        target: "public.orders o",
        role: null,
        estimatedRows: 10,
        cost: 1.5,
        actual: null,
        misestimate: null,
        warnings: [],
        children: [],
      });
      expect(plan?.root.details).toContainEqual(["Alias", "o"]);
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
      expect(plan?.root.actual).toEqual({ rows: 4, loops: 1, totalMs: 2.5, selfMs: 1.9 });
      const [outer, inner] = plan?.root.children ?? [];
      expect(outer?.actual).toEqual({ rows: 1.5, loops: 2, totalMs: 0.6, selfMs: 0.6 });
      expect(inner?.target).toBe("customers using customers_pkey");
      expect(inner?.role).toBe("SubPlan 1");
      expect(inner?.actual).toEqual({ rows: 0, loops: 0, totalMs: 0, selfMs: 0 });
      expect(plan?.root.details.map(([key]) => key)).not.toContain("Plans");
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

  // The shapes below are PostgreSQL 18's, trimmed to the keys the timing reads.
  describe("self time", () => {
    it("takes an InitPlan's time from the node that evaluated it", () => {
      const plan = readPlan({
        Plan: ran("Result", 206.3, 1, {
          Plans: [ran("Result", 206.2, 1, { "Subplan Name": "InitPlan 1" })],
        }),
      });

      expect(selfTimes(plan?.root)).toEqual([0.1, 206.2]);
    });

    it("counts a SubPlan over all the rows it was run for", () => {
      const plan = readPlan({
        Plan: ran("Seq Scan", 0.55, 1, {
          Plans: [ran("Aggregate", 0.01, 50, { "Subplan Name": "SubPlan 1" })],
        }),
      });

      expect(selfTimes(plan?.root)).toEqual([0.05, 0.5]);
    });

    it("gives a CTE's time to its own plan, not to the scans that read it", () => {
      const plan = readPlan({
        Plan: ran("Hash Join", 159.7, 1, {
          Plans: [
            ran("Function Scan", 159.6, 1, { "Subplan Name": "CTE x" }),
            ran("CTE Scan", 55.1, 1, { "CTE Name": "x" }),
            ran("Hash", 104.5, 1, { Plans: [ran("CTE Scan", 104.5, 1, { "CTE Name": "x" })] }),
          ],
        }),
      });

      // The scans' own share is hidden inside the CTE's; the floor keeps them at none.
      expect(selfTimes(plan?.root)).toEqual([0.1, 159.6, 0, 0, 0]);
    });

    it("reads a parallel node's time as the wall clock saw it, not the processes' sum", () => {
      const plan = readPlan({
        Plan: ran("Gather", 2.5, 1, {
          "Workers Launched": 2,
          Plans: [
            ran("Aggregate", 0.5, 3, { Plans: [ran("Seq Scan", 0.32, 3)] }),
            ran("Seq Scan", 0.8, 1, { "Subplan Name": "InitPlan 1" }),
          ],
        }),
      });

      const [aggregate, alone] = plan?.root.children ?? [];
      expect(aggregate?.actual?.totalMs).toBeCloseTo(0.5);
      expect(aggregate?.actual?.selfMs).toBeCloseTo(0.18);
      // One process ran it, so its one loop is all it took.
      expect(alone?.actual?.totalMs).toBeCloseTo(0.8);
    });

    it("keeps a node from going below none when an InitPlan is counted twice", () => {
      const plan = readPlan({
        Plan: ran("Aggregate", 112.7, 1, {
          Plans: [
            ran("Function Scan", 106.3, 1, { "Subplan Name": "InitPlan 1" }),
            ran("Gather", 112.7, 1, { "Workers Launched": 2 }),
          ],
        }),
      });

      expect(plan?.root.actual?.selfMs).toBe(0);
    });
  });

  describe("what a node is flagged for", () => {
    it("flags an estimate tenfold or more off, and which way", () => {
      const off = (planned: number, rows: number) =>
        readPlan({ Plan: { ...ran("Seq Scan", 1, 1), "Plan Rows": planned, "Actual Rows": rows } })
          ?.root.misestimate;

      expect(off(10, 90)).toBeNull();
      expect(off(10, 100)).toEqual({ factor: 10, under: true });
      expect(off(5000, 0)).toEqual({ factor: 5000, under: false });
      const never = { ...ran("Seq Scan", 0, 0), "Plan Rows": 5000, "Actual Rows": 0 };
      expect(readPlan({ Plan: never })?.root.misestimate).toBeNull();
    });

    it("names spills, lossy bitmaps and missing workers", () => {
      const labels = (rest: Record<string, unknown>) =>
        readPlan({ Plan: ran("Sort", 1, 1, rest) })?.root.warnings.map(({ label }) => label);

      expect(labels({ "Sort Space Type": "Disk", "Temp Written Blocks": 30 })).toEqual([
        "Sort on disk",
      ]);
      expect(labels({ "Hash Batches": 4, "Original Hash Batches": 1 })).toEqual([
        "Hash in 4 batches",
      ]);
      expect(labels({ "HashAgg Batches": 5 })).toEqual(["Aggregate in 5 batches"]);
      expect(labels({ "Temp Written Blocks": 12 })).toEqual(["Temporary files"]);
      expect(labels({ "Lossy Heap Blocks": 3 })).toEqual(["Lossy bitmap"]);
      expect(labels({ "Workers Planned": 4, "Workers Launched": 1 })).toEqual(["1 of 4 workers"]);
      expect(labels({ "Sort Space Type": "Memory", "Hash Batches": 1 })).toEqual([]);
    });

    it("flags a filter that throws most rows away, once there are enough of them", () => {
      const labels = (removed: number, rows: number, loops = 1) =>
        readPlan({
          Plan: ran("Seq Scan", 1, loops, {
            "Rows Removed by Filter": removed,
            "Actual Rows": rows,
          }),
        })?.root.warnings.map(({ label }) => label);

      // The demo database's `orders` filtered to the last 90 days.
      expect(labels(7236, 764)).toEqual(["Filter discarded 90%"]);
      expect(labels(700, 80)).toEqual([]);
      expect(labels(100, 1, 20)).toEqual(["Filter discarded 99%"]);
      expect(labels(5000, 5000)).toEqual([]);
    });
  });
}
