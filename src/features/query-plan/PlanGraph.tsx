import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useState } from "react";
import { decimal, HEAVY, integer, percent, shareOf } from "./format";
import { BOX, fit, layout, reveal, type Spot, type View, zoomAt } from "./layout";
import type { PlanNode } from "./plan";

type Props = {
  root: PlanNode;
  /** In the depth-first order the table lists them in, which is the order the keys walk. */
  nodes: PlanNode[];
  /** What a node's own time is a share of. */
  whole: number;
  selected: number | null;
  onSelect: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Put on the element that takes the focus. */
  surface: string;
};

/** How wide the line carrying the most rows is; the rest shrink by the root of their share. */
const WIDEST = 6;

type Size = { width: number; height: number };

export function PlanGraph({ root, nodes, whole, selected, onSelect, onKeyDown, surface }: Props) {
  const graph = layout(root);
  const nodeId = useId();
  // Held in state, not a ref: it is observed from the moment it is attached.
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<Size | null>(null);
  // Null until the reader moves it: until then it is fitted to the viewport.
  const [moved, setMoved] = useState<View | null>(null);
  const view = moved ?? (measured ? fit(graph, measured) : null);

  useEffect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = viewport;
      // A hidden tab is measured as nothing, which is no size to fit or reveal in,
      // and coming back to the size it had is no change.
      if (width === 0 || height === 0) return;
      setMeasured((was) =>
        was?.width === width && was.height === height ? was : { width, height },
      );
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);

  // The keys move the selection, not the view, so a node picked off screen is
  // brought on, and kept on when the viewport narrows, as it does when the
  // details pane opens with a selection. Nothing else moves the view: not the
  // reader's own pans, and not a fit to the narrower viewport, so the view is
  // held as it is the moment a node is picked.
  const [seen, setSeen] = useState({ selected, measured });
  const spot = selected === null ? undefined : graph.spots[selected];
  if (selected !== seen.selected || measured !== seen.measured) {
    setSeen({ selected, measured });
    if (view && measured && selected !== seen.selected) {
      setMoved(spot ? reveal(view, spot, measured) : view);
    } else if (view && measured && spot) {
      setMoved(reveal(view, spot, measured));
    }
  }

  // A pinch arrives as a wheel with Ctrl held, and a two-finger drag as a plain
  // wheel. React listens to wheels passively, so it could not keep the page from
  // scrolling or zooming as well. Several wheels can arrive before a render, so
  // each builds on the last rather than on the view this render drew.
  useEffect(() => {
    if (!viewport || !measured) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const at = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      setMoved((current) => {
        const from = current ?? fit(graph, measured);
        return event.ctrlKey
          ? zoomAt(from, Math.exp(-event.deltaY / 100), at)
          : { ...from, x: from.x - event.deltaX, y: from.y - event.deltaY };
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [viewport, measured, graph]);

  function drag(event: PointerEvent<SVGRectElement>) {
    if (!view) return;
    const handle = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY };
    const from = view;
    handle.setPointerCapture(event.pointerId);
    const onMove = (move: globalThis.PointerEvent) => {
      setMoved({ ...from, x: from.x + move.clientX - start.x, y: from.y + move.clientY - start.y });
    };
    const ends = ["pointerup", "pointercancel", "lostpointercapture"] as const;
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      for (const end of ends) handle.removeEventListener(end, onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    for (const end of ends) handle.addEventListener(end, onEnd);
  }

  function zoomBy(factor: number) {
    if (!measured || !view) return;
    setMoved(zoomAt(view, factor, { x: measured.width / 2, y: measured.height / 2 }));
  }

  const busiest = Math.max(1, ...graph.edges.map(({ rows }) => rows));
  const centre = (index: number) => graph.spots[index]!.x + BOX.width / 2;

  return (
    <div
      ref={setViewport}
      id={surface}
      role="tree"
      aria-label="Plan graph"
      aria-activedescendant={selected === null ? undefined : `${nodeId}-${selected}`}
      tabIndex={0}
      className="focus-visible:outline-primary relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      onKeyDown={onKeyDown}
    >
      {view && (
        <svg className="block h-full w-full select-none">
          <rect
            width="100%"
            height="100%"
            className="cursor-grab fill-transparent active:cursor-grabbing"
            onPointerDown={drag}
          />
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {graph.edges.map(({ from, to, rows }) => {
              const below = graph.spots[from]!;
              const above = graph.spots[to]!;
              const middle = (below.y + above.y + BOX.height) / 2;
              return (
                <path
                  key={`${from}-${to}`}
                  d={`M ${centre(from)} ${below.y} C ${centre(from)} ${middle}, ${centre(to)} ${middle}, ${centre(to)} ${above.y + BOX.height}`}
                  className="stroke-base-content/35 fill-none"
                  strokeWidth={1 + (WIDEST - 1) * Math.sqrt(rows / busiest)}
                >
                  <title>{`${integer.format(rows)} rows`}</title>
                </path>
              );
            })}
            {graph.ctes.map(({ from, to }) => {
              const body = graph.spots[from]!;
              const scan = graph.spots[to]!;
              return (
                <path
                  key={`cte-${from}-${to}`}
                  d={`M ${centre(from)} ${body.y} L ${centre(to)} ${scan.y + BOX.height}`}
                  className="stroke-base-content/35 fill-none"
                  strokeDasharray="4 4"
                  data-cte=""
                >
                  <title>What the CTE made, read by this scan</title>
                </path>
              );
            })}
            {nodes.map((node, index) => (
              <Node
                // The list is fixed for as long as this plan is shown.
                // oxlint-disable-next-line no-array-index-key
                key={index}
                id={`${nodeId}-${index}`}
                node={node}
                spot={graph.spots[index]!}
                whole={whole}
                selected={index === selected}
                onSelect={() => onSelect(index)}
              />
            ))}
          </g>
        </svg>
      )}
      <div className="absolute top-2 right-2 join">
        <button
          type="button"
          className="btn btn-xs btn-square join-item"
          aria-label="Zoom in"
          onClick={() => zoomBy(1.25)}
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          className="btn btn-xs btn-square join-item"
          aria-label="Zoom out"
          onClick={() => zoomBy(0.8)}
        >
          <ZoomOut size={14} />
        </button>
        <button
          type="button"
          className="btn btn-xs btn-square join-item"
          aria-label="Fit the plan"
          onClick={() => setMoved(null)}
        >
          <Maximize size={14} />
        </button>
      </div>
    </div>
  );
}

/** Cut to what a box holds, since SVG text does not wrap or clip itself. */
function clip(text: string, fits: number) {
  return text.length > fits ? `${text.slice(0, fits - 1)}…` : text;
}

function Node({
  id,
  node,
  spot,
  whole,
  selected,
  onSelect,
}: {
  id: string;
  node: PlanNode;
  spot: Spot;
  whole: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const actual = node.actual;
  const never = actual !== null && actual.loops === 0;
  const share = shareOf(actual?.selfMs, whole);
  const heavy = !never && share >= HEAVY;
  const flagged = node.warnings.length + (node.misestimate ? 1 : 0);
  const reads = [node.target, node.role].filter(Boolean).join(" · ");
  const measured = actual
    ? never
      ? "never executed"
      : // Rows per loop are an average, so their total is whole only once rounded.
        `${integer.format(actual.rows * actual.loops)} rows · ${percent(share)}`
    : `~${decimal.format(node.estimatedRows)} rows · cost ${integer.format(node.cost)}`;

  return (
    <g
      id={id}
      role="treeitem"
      aria-level={spot.depth + 1}
      aria-selected={selected}
      aria-label={[node.operation, reads, measured].filter(Boolean).join(", ")}
      transform={`translate(${spot.x} ${spot.y})`}
      className={`cursor-default ${never ? "opacity-50" : ""}`}
      onClick={onSelect}
    >
      <rect
        width={BOX.width}
        height={BOX.height}
        rx={8}
        strokeWidth={selected ? 2 : 1}
        className={`${heavy ? "fill-warning/15" : "fill-base-200"} ${
          selected ? "stroke-primary" : heavy ? "stroke-warning" : "stroke-base-content/25"
        }`}
      />
      <text x={12} y={20} className="fill-base-content text-[13px] font-medium">
        {clip(node.operation, flagged ? 21 : 25)}
      </text>
      {flagged > 0 && (
        <text x={BOX.width - 12} y={20} textAnchor="end" className="fill-warning text-[11px]">
          {`⚠ ${flagged}`}
        </text>
      )}
      <text x={12} y={38} className="fill-base-content/60 font-mono text-[11px]">
        {clip(reads, 28)}
      </text>
      <text x={12} y={56} className="fill-base-content/70 text-[11px] tabular-nums">
        {measured}
      </text>
    </g>
  );
}
