// PostgreSQL writes times to the microsecond; fewer digits would show a quick node as none.
export const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
export const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function ms(value: number) {
  return `${decimal.format(value)} ms`;
}

export function percent(share: number) {
  return `${integer.format(share * 100)}%`;
}

/** A node with this share of the run or more is drawn as the heavy one it is. */
export const HEAVY = 0.15;

/** A node's own time as a share of the run, which is what marks it heavy. */
export function shareOf(selfMs: number | undefined, whole: number) {
  return selfMs !== undefined && whole > 0 ? Math.min(1, selfMs / whole) : 0;
}
