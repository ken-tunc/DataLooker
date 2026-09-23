import { siGooglebigquery, siPostgresql, type SimpleIcon } from "simple-icons";
import { DRIVER_LABELS, type DriverKind } from "./driver";

const ICONS: Record<DriverKind, SimpleIcon> = {
  postgres: siPostgresql,
  bigquery: siGooglebigquery,
};

/** The driver's own mark, so a list of connections says which is which before it is read. */
export function DriverIcon({ kind }: { kind: DriverKind }) {
  const icon = ICONS[kind];
  // On a light tile: PostgreSQL's blue is too dark to read against the sidebar.
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      className="bg-base-content size-6 shrink-0 rounded-md p-0.5"
      fill={`#${icon.hex}`}
      aria-label={DRIVER_LABELS[kind]}
    >
      <path d={icon.path} />
    </svg>
  );
}
