import { useEffect, useState } from "react";

type Range = { first: number; last: number };

/**
 * The rows to render: those inside the viewport, and `overscan` more on each
 * side so that a fast scroll does not show blank space before they arrive.
 * `top` is the scroll offset measured from the list's own top.
 */
function rangeOf(
  top: number,
  height: number,
  count: number,
  rowHeight: number,
  overscan: number,
): Range {
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(count - 1, Math.ceil((top + height) / rowHeight) + overscan);
  return { first, last };
}

/** How far below the scroller's top the list begins, such as under a header. */
function offsetOf(list: HTMLElement, scroller: HTMLElement): number {
  return (
    list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
}

/**
 * Renders only the rows in view of a list whose rows are all one height,
 * which is what lets the range be worked out from the scroll offset alone.
 * `list` is the element the rows are placed in, inside `scroller`.
 */
export function useFixedRows({
  scroller,
  list,
  count,
  rowHeight,
  overscan,
  coveredTop = 0,
}: {
  scroller: HTMLElement | null;
  list: HTMLElement | null;
  count: number;
  rowHeight: number;
  overscan: number;
  /** Height hidden at the top of the viewport by something sticky. */
  coveredTop?: number;
}) {
  const [range, setRange] = useState<Range>({ first: 0, last: -1 });

  useEffect(() => {
    if (!scroller || !list) return;
    const read = () => {
      const next = rangeOf(
        scroller.scrollTop - offsetOf(list, scroller),
        scroller.clientHeight,
        count,
        rowHeight,
        overscan,
      );
      // A new object only when the range moves, so a scroll within a row
      // renders nothing.
      setRange((current) =>
        current.first === next.first && current.last === next.last ? current : next,
      );
    };
    read();
    scroller.addEventListener("scroll", read, { passive: true });
    const resized = new ResizeObserver(read);
    resized.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", read);
      resized.disconnect();
    };
  }, [scroller, list, count, rowHeight, overscan]);

  /** Scrolls as little as it takes to bring the row fully into view. */
  function scrollToRow(index: number) {
    if (!scroller || !list) return;
    const start = offsetOf(list, scroller) + index * rowHeight;
    const end = start + rowHeight;
    if (start < scroller.scrollTop + coveredTop) {
      scroller.scrollTo({ top: start - coveredTop });
    } else if (end > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTo({ top: end - scroller.clientHeight });
    }
  }

  const rows: { index: number; start: number }[] = [];
  for (let index = range.first; index <= Math.min(range.last, count - 1); index++) {
    rows.push({ index, start: index * rowHeight });
  }

  return { rows, totalHeight: count * rowHeight, scrollToRow };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("rangeOf", () => {
    it("covers the viewport and the overscan on each side", () => {
      expect(rangeOf(280, 100, 1000, 28, 2)).toEqual({ first: 8, last: 16 });
    });

    it("stops at the first and the last row", () => {
      expect(rangeOf(0, 100, 3, 28, 5)).toEqual({ first: 0, last: 2 });
      expect(rangeOf(0, 100, 0, 28, 5)).toEqual({ first: 0, last: -1 });
    });

    it("counts the scroll from the list's top, not the scroller's", () => {
      // Scrolled less than the header above the list: still the first rows.
      expect(rangeOf(-20, 100, 1000, 28, 0).first).toBe(0);
    });
  });
}
