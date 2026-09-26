import { DRIVER_LABELS, type DriverKind } from "./driver";
// Each mark is the file its owner publishes, byte for byte, and shown as a file
// rather than redrawn: PostgreSQL's trademark policy allows the logo only
// unmodified. PostgreSQL's is the three-colour logo from
// wiki.postgresql.org/wiki/Logo, BigQuery's the product icon from
// cloud.google.com/icons.
import bigquery from "./bigquery.svg";
import postgresql from "./postgresql.svg";

const MARKS: Record<DriverKind, string> = { postgres: postgresql, bigquery };

/** The driver's own mark, so a list of connections says which is which before it is read. */
export function DriverIcon({
  kind,
  className = "size-6",
}: {
  kind: DriverKind;
  className?: string;
}) {
  return (
    <img
      src={MARKS[kind]}
      alt={DRIVER_LABELS[kind]}
      // An image is draggable by default, which would take a press on a rail tile's mark
      // from the tile's own drag and carry the image's address to wherever it is dropped.
      draggable={false}
      className={`bg-base-300 ${className} shrink-0 rounded-md object-contain p-0.5`}
    />
  );
}
