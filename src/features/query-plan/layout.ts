import type { PlanNode } from "./plan";

/** A node's box, in the graph's own units. */
export const BOX = { width: 208, height: 66, gapX: 24, gapY: 52 };

/** Where a node's box sits: its top-left corner. */
export type Spot = { x: number; y: number; depth: number };

/** Rows go up an edge from a node into the one that reads it. */
export type Edge = { from: number; to: number; rows: number };

export type Layout = {
  /** By a node's place in the depth-first order the table lists them in. */
  spots: Spot[];
  edges: Edge[];
  /** From a CTE's own plan to each CTE Scan that reads it, which is where its rows go. */
  ctes: { from: number; to: number }[];
  width: number;
  height: number;
};

/**
 * Leaves in a row, left to right as the plan lists them, and every other node
 * centred over its first and last child. A plan is a tree, so no leaf ever
 * shares a column and no two boxes can overlap; the price is some width a
 * tidier layout would claw back, which a plan rarely needs.
 */
export function layout(root: PlanNode): Layout {
  const spots: Spot[] = [];
  const edges: Edge[] = [];
  const bodies = new Map<string, number>();
  const scans: { index: number; cte: string }[] = [];
  let leaves = 0;
  let deepest = 0;

  function place(node: PlanNode, depth: number): number {
    const index = spots.length;
    spots.push({ x: 0, y: depth * (BOX.height + BOX.gapY), depth });
    deepest = Math.max(deepest, depth);

    const name = node.role?.match(/^CTE (.+)$/)?.[1];
    if (name) bodies.set(name, index);
    const cte = node.details.find(([key]) => key === "CTE Name")?.[1];
    if (node.operation === "CTE Scan" && typeof cte === "string") scans.push({ index, cte });

    const children = node.children.map((child) => place(child, depth + 1));
    const spot = spots[index]!;
    if (children.length === 0) {
      spot.x = leaves * (BOX.width + BOX.gapX);
      leaves += 1;
    } else {
      spot.x = (spots[children[0]!]!.x + spots[children.at(-1)!]!.x) / 2;
    }
    node.children.forEach((child, i) =>
      edges.push({ from: children[i]!, to: index, rows: flowed(child) }),
    );
    return index;
  }

  place(root, 0);
  const ctes = scans.flatMap(({ index, cte }) => {
    const body = bodies.get(cte);
    return body === undefined ? [] : [{ from: body, to: index }];
  });
  return {
    spots,
    edges,
    ctes,
    width: Math.max(1, leaves) * (BOX.width + BOX.gapX) - BOX.gapX,
    height: (deepest + 1) * (BOX.height + BOX.gapY) - BOX.gapY,
  };
}

/** All the rows a node handed up: per loop, as PostgreSQL counts them, times its loops. */
export function flowed(node: PlanNode): number {
  return node.actual ? node.actual.rows * node.actual.loops : node.estimatedRows;
}

/** How the graph is shown: moved by `x`, `y` and then scaled by `k`. */
export type View = { x: number; y: number; k: number };

export const ZOOM = { min: 0.2, max: 2 };

/** Scaled about `at`, a point in the viewport, so what is under the pointer stays there. */
export function zoomAt(view: View, factor: number, at: { x: number; y: number }): View {
  const k = Math.min(ZOOM.max, Math.max(ZOOM.min, view.k * factor));
  const kept = k / view.k;
  return { k, x: at.x - (at.x - view.x) * kept, y: at.y - (at.y - view.y) * kept };
}

/**
 * The whole width in view, no larger than life, centred across and held to
 * the top: a deep plan is read downwards, as the table reads it.
 */
export function fit(
  graph: { width: number; height: number },
  viewport: { width: number; height: number },
): View {
  const margin = 16;
  const k = Math.min(1, Math.max(ZOOM.min, (viewport.width - margin * 2) / graph.width));
  return { k, x: (viewport.width - graph.width * k) / 2, y: margin };
}

/** Moved just enough to bring a box inside the viewport, or not at all. */
export function reveal(view: View, spot: Spot, viewport: { width: number; height: number }): View {
  const margin = 24;
  const left = view.x + spot.x * view.k;
  const top = view.y + spot.y * view.k;
  const right = left + BOX.width * view.k;
  const bottom = top + BOX.height * view.k;
  let { x, y } = view;
  if (left < margin) x += margin - left;
  else if (right > viewport.width - margin) x -= right - (viewport.width - margin);
  if (top < margin) y += margin - top;
  else if (bottom > viewport.height - margin) y -= bottom - (viewport.height - margin);
  return { ...view, x, y };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  function node(
    operation: string,
    children: PlanNode[] = [],
    rest: Partial<PlanNode> = {},
  ): PlanNode {
    return {
      operation,
      target: null,
      role: null,
      estimatedRows: 10,
      cost: 1,
      actual: null,
      misestimate: null,
      warnings: [],
      details: [],
      children,
      ...rest,
    };
  }

  const step = BOX.width + BOX.gapX;
  const row = BOX.height + BOX.gapY;

  describe("layout", () => {
    it("lines the leaves up and centres each parent over its children", () => {
      // Hash Join ← (Seq Scan, Hash ← Seq Scan), as a join over a hashed table is.
      const placed = layout(
        node("Hash Join", [node("Seq Scan"), node("Hash", [node("Seq Scan")])]),
      );

      expect(placed.spots).toEqual([
        { x: step / 2, y: 0, depth: 0 },
        { x: 0, y: row, depth: 1 },
        { x: step, y: row, depth: 1 },
        { x: step, y: row * 2, depth: 2 },
      ]);
      expect(placed.width).toBe(step * 2 - BOX.gapX);
      expect(placed.height).toBe(row * 3 - BOX.gapY);
    });

    it("counts the rows up an edge over all the loops that sent them", () => {
      const inner = node("Index Scan", [], {
        actual: { rows: 2, loops: 50, totalMs: 1, selfMs: 1 },
      });
      const outer = node("Seq Scan", [], { estimatedRows: 50 });

      expect(layout(node("Nested Loop", [outer, inner])).edges).toEqual([
        { from: 1, to: 0, rows: 50 },
        { from: 2, to: 0, rows: 100 },
      ]);
    });

    it("joins a CTE's plan to every scan that reads it", () => {
      const scan = () => node("CTE Scan", [], { details: [["CTE Name", "x"]] });
      const placed = layout(
        node("Hash Join", [
          node("Function Scan", [], { role: "CTE x" }),
          scan(),
          node("Hash", [scan()]),
        ]),
      );

      expect(placed.ctes).toEqual([
        { from: 1, to: 2 },
        { from: 1, to: 4 },
      ]);
    });
  });

  describe("the view", () => {
    it("keeps the point under the pointer where it was when zooming", () => {
      const view = zoomAt({ x: 10, y: 20, k: 1 }, 2, { x: 110, y: 120 });

      expect(view).toEqual({ k: 2, x: -90, y: -80 });
      // The graph's point (100, 100) was at (110, 120), and still is.
      expect(view.x + 100 * view.k).toBe(110);
      expect(view.y + 100 * view.k).toBe(120);
    });

    it("stops zooming at its bounds", () => {
      expect(zoomAt({ x: 0, y: 0, k: 1.5 }, 4, { x: 0, y: 0 }).k).toBe(ZOOM.max);
      expect(zoomAt({ x: 0, y: 0, k: 0.3 }, 0.1, { x: 0, y: 0 }).k).toBe(ZOOM.min);
    });

    it("fits the width without enlarging a small plan", () => {
      expect(fit({ width: 200, height: 100 }, { width: 632, height: 400 })).toEqual({
        k: 1,
        x: 216,
        y: 16,
      });
      expect(fit({ width: 1200, height: 100 }, { width: 632, height: 400 }).k).toBe(0.5);
    });

    it("moves only as far as it takes to show a box", () => {
      const viewport = { width: 600, height: 400 };
      const shown = { x: 0, y: 0, k: 1 };

      expect(reveal(shown, { x: 100, y: 100, depth: 1 }, viewport)).toEqual(shown);
      expect(reveal(shown, { x: 500, y: 500, depth: 4 }, viewport)).toEqual({
        k: 1,
        x: 600 - 24 - (500 + BOX.width),
        y: 400 - 24 - (500 + BOX.height),
      });
    });
  });
}
