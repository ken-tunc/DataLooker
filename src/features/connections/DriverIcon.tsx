import { siGooglebigquery, siPostgresql, type SimpleIcon } from "simple-icons";
import { DRIVER_LABELS, type DriverKind } from "./driver";

// Each mark sits on the tile its colour reads against: PostgreSQL's blue is
// too dark for the theme's background, and BigQuery's too light for a white one.
const MARKS: Record<DriverKind, { icon: SimpleIcon; tile: string }> = {
  postgres: { icon: siPostgresql, tile: "bg-base-content" },
  bigquery: { icon: siGooglebigquery, tile: "bg-base-300" },
};

/** The driver's own mark, so a list of connections says which is which before it is read. */
export function DriverIcon({ kind }: { kind: DriverKind }) {
  const { icon, tile } = MARKS[kind];
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      className={`${tile} size-6 shrink-0 rounded-md p-0.5`}
      fill={`#${icon.hex}`}
      aria-label={DRIVER_LABELS[kind]}
    >
      <path d={icon.path} />
    </svg>
  );
}
