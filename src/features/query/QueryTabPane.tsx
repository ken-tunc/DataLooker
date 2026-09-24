import { lazy, Suspense } from "react";
import { Splitter } from "../../components/Splitter";
import { useToast } from "../../components/useToast";
import { describeError, IpcError } from "../../lib/invoke";
import { type Pane, usePaneSize } from "../../lib/paneSize";
import { useSchemaTree } from "../schema-tree/hooks";
import { type QualifiedName, tablesNamed, written } from "../sql-editor/jump";
import { ResultGrid } from "./ResultGrid";
import { useQueryRunner } from "./hooks";

// Monaco is by far the heaviest thing here, so it loads on first use.
const SqlEditor = lazy(() => import("../sql-editor/SqlEditor"));

const EDITOR: Pane = { key: "datalooker.editor-height", initial: 224, min: 80, max: 2000 };

type Props = {
  connectionId: string;
  tabId: string;
  sql: string;
  onSqlChange: (sql: string) => void;
  hidden: boolean;
  /** Where a name in the statement leads: the table it names, as it is made. */
  onOpenStructure: (schema: string, table: string) => void;
  /** Where a name that means several tables leads: the reader chooses. */
  onFindTable: (query: string) => void;
};

export function QueryTabPane({
  connectionId,
  tabId,
  sql,
  onSqlChange,
  hidden,
  onOpenStructure,
  onFindTable,
}: Props) {
  const { run, cancel } = useQueryRunner(connectionId);
  const [editorHeight] = usePaneSize(EDITOR);
  const { show } = useToast();
  const tree = useSchemaTree(connectionId);
  const cancelled = run.error instanceof IpcError && run.error.kind === "Cancelled";

  function submit() {
    if (sql.trim() !== "" && !run.isPending) run.mutate(sql);
  }

  /** Several matches go to the palette: the search path decides, not the tree. */
  function jump(name: QualifiedName) {
    // Without a tree, "not found" would claim more than is known.
    if (tree.isPending) {
      show("The schema is still being read.", "info");
      return;
    }
    if (!tree.data) {
      show(`${describeError(tree.error)} — no name can be looked up.`, "error");
      return;
    }
    const found = tablesNamed(tree.data, name);
    const first = found[0];
    if (found.length === 1 && first) onOpenStructure(first.schema, first.table);
    else if (found.length > 1) onFindTable(name.name);
    else show(`No table here is called ${written(name)}.`, "info");
  }

  return (
    // Hidden rather than unmounted, so the editor and results survive.
    <div className={`flex min-h-0 flex-1 flex-col gap-2 p-3 ${hidden ? "hidden" : ""}`}>
      <div className="flex items-center gap-2">
        {run.isPending ? (
          <button type="button" className="btn btn-sm" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={sql.trim() === ""}
            onClick={submit}
          >
            Run
          </button>
        )}
        <span className="text-base-content/60 text-xs">
          <kbd className="kbd kbd-xs">⌘</kbd> <kbd className="kbd kbd-xs">Enter</kbd>
        </span>
        <span className="grow" />
        <Status
          pending={run.isPending}
          cancelled={cancelled}
          error={run.isError && !cancelled ? describeError(run.error) : null}
          result={run.isSuccess ? run.data : null}
        />
      </div>

      {/* The editor gives way before the rows do: dragged taller than the
        window, it shrinks rather than pushing them out of sight. */}
      <div
        className="hairline min-h-20 overflow-hidden rounded-box border"
        style={{ flexBasis: editorHeight }}
      >
        <Suspense fallback={<div className="skeleton h-full w-full" />}>
          <SqlEditor
            connectionId={connectionId}
            tabId={tabId}
            value={sql}
            onChange={onSqlChange}
            onSubmit={submit}
            onJump={jump}
          />
        </Suspense>
      </div>

      <Splitter pane={EDITOR} axis="y" label="Resize the editor" />

      <div className="min-h-24 flex-1 basis-0">
        {run.isSuccess && run.data.columns.length > 0 ? (
          <ResultGrid result={run.data} />
        ) : (
          <div className="hairline text-base-content/50 flex h-full items-center justify-center rounded-box border border-dashed text-sm">
            {run.isSuccess ? "The statement returned no rows." : "Run a query to see its rows."}
          </div>
        )}
      </div>
    </div>
  );
}

function Status({
  pending,
  cancelled,
  error,
  result,
}: {
  pending: boolean;
  cancelled: boolean;
  error: string | null;
  result: { rows: unknown[][]; elapsed_ms: number; truncated: boolean } | null;
}) {
  if (pending) return <span className="loading loading-spinner loading-xs" />;
  if (cancelled) return <span className="text-base-content/60 text-sm">Cancelled</span>;
  if (error) return <span className="text-error truncate font-mono text-sm">{error}</span>;
  if (!result) return null;
  return (
    <span className="text-base-content/60 flex gap-3 text-sm">
      <span>
        {result.rows.length} {result.rows.length === 1 ? "row" : "rows"}
      </span>
      <span>{result.elapsed_ms} ms</span>
      {result.truncated && <span className="text-warning">first rows only</span>}
    </span>
  );
}
