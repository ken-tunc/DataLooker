import { useQuery } from "@tanstack/react-query";
import { SqlText } from "../../components/SqlText";
import { routineDefinition } from "../../lib/commands";
import { describeError } from "../../lib/invoke";
import { schemaKeys } from "../schema-tree/keys";
import type { Tab } from "../tabs/tabs";

type Props = {
  connectionId: string;
  tab: Extract<Tab, { kind: "routine" }>;
  /** Off screen, the definition is neither read nor read again. */
  hidden: boolean;
  /** Hands the definition to a query tab, where it can be changed and run. */
  onEdit: (sql: string) => void;
};

/**
 * Read-only, so that opening a routine to look at it cannot change it; editing
 * starts from a copy in a query tab.
 */
export function RoutinePane({ connectionId, tab, hidden, onEdit }: Props) {
  const definition = useQuery({
    enabled: !hidden,
    // Under the schema's key, so that reloading the tree reads it again.
    queryKey: schemaKeys.routine(connectionId, tab.schema, tab.name, tab.arguments),
    queryFn: () => routineDefinition(connectionId, tab.schema, tab.name, tab.arguments),
    staleTime: 5 * 60_000,
  });

  return (
    <div className={`flex min-h-0 flex-1 flex-col gap-2 p-3 ${hidden ? "hidden" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-medium">
          {tab.schema}.{tab.name}({tab.arguments})
        </span>
        <button
          type="button"
          className="btn btn-sm ml-auto"
          disabled={!definition.data}
          onClick={() => definition.data && onEdit(definition.data)}
        >
          Edit in a query tab
        </button>
      </div>

      {definition.isPending && <p className="text-faint text-sm">Reading the definition…</p>}
      {definition.isError && (
        <div role="alert" className="alert alert-soft alert-error">
          <span className="font-mono text-sm">{describeError(definition.error)}</span>
        </div>
      )}
      {definition.data && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SqlText>{definition.data}</SqlText>
        </div>
      )}
    </div>
  );
}
