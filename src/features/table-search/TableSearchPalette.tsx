import { Palette } from "../../components/Palette";
import { describeError } from "../../lib/invoke";
import { useSchemaTree } from "../schema-tree/hooks";
import { KIND_LABELS } from "../schema-tree/rows";
import { highlight, MATCH_LIMIT, searchTables } from "./search";

type Props = {
  connectionId: string;
  /** What to look for straight away, when the palette was opened about a name. */
  initial?: string;
  onOpenTable: (schema: string, table: string) => void;
  onClose: () => void;
};

/**
 * Finds a table by name rather than by where it sits. The tree it searches is
 * the one the sidebar already asked for, so opening the palette costs no
 * request of its own.
 */
export function TableSearchPalette({ connectionId, initial, onOpenTable, onClose }: Props) {
  const tree = useSchemaTree(connectionId);

  return (
    <Palette
      label="Open a table"
      placeholder="Find a table"
      initial={initial}
      search={(query) => (tree.data ? searchTables(tree.data, query) : [])}
      keyOf={(match) => `${match.schema}.${match.table}`}
      onChoose={(match) => onOpenTable(match.schema, match.table)}
      onClose={onClose}
      empty="No table matches."
      status={
        tree.isPending ? (
          <p className="text-base-content/60 p-2 text-sm">Reading the schema…</p>
        ) : tree.isError ? (
          <div role="alert" className="alert alert-soft alert-error text-sm">
            <span className="truncate">{describeError(tree.error)}</span>
          </div>
        ) : null
      }
      footer={(matches) =>
        matches.length === MATCH_LIMIT && (
          <p className="text-base-content/50 px-2 text-xs">
            The first {MATCH_LIMIT} matches. Type more to narrow them.
          </p>
        )
      }
    >
      {(match) => (
        <>
          <span className="truncate">
            {highlight(`${match.schema}.${match.table}`, match.hits).map((part, at) =>
              part.matched ? (
                <mark key={at} className="text-primary bg-transparent font-semibold">
                  {part.text}
                </mark>
              ) : (
                <span key={at}>{part.text}</span>
              ),
            )}
          </span>
          <span className="text-base-content/50 shrink-0 text-xs">{KIND_LABELS[match.kind]}</span>
        </>
      )}
    </Palette>
  );
}
