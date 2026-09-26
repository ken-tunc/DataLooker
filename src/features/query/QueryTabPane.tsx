import { lazy, Suspense, useState } from "react";
import { Splitter } from "../../components/Splitter";
import { useToast } from "../../components/useToast";
import { describeError, IpcError } from "../../lib/invoke";
import { type Pane, usePaneSize } from "../../lib/paneSize";
import { useDriver } from "../connections/hooks";
import { TemplateFormDialog } from "../query-templates/TemplateFormDialog";
import { useSchemaTree } from "../schema-tree/hooks";
import { type QualifiedName, tablesNamed, written } from "../sql-editor/jump";
import { PlanView, type Shape } from "../query-plan/PlanView";
import { ResultGrid } from "./ResultGrid";
import { type Outcome, type Request, useQueryRunner } from "./hooks";

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
  const [saving, setSaving] = useState(false);
  const cancelled = run.error instanceof IpcError && run.error.kind === "Cancelled";
  // Only PostgreSQL says how it would run a statement.
  const explains = useDriver(connectionId) === "postgres";
  const outcome = run.isSuccess ? run.data : null;
  const [planShape, setPlanShape] = useState<Shape>("table");

  function submit(explain: Request["explain"] = null) {
    if (explain !== null && !explains) return;
    if (sql.trim() !== "" && !run.isPending) run.mutate({ sql, explain });
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
            onClick={() => submit()}
          >
            Run
          </button>
        )}
        <span className="text-base-content/60 text-xs">
          <kbd className="kbd kbd-xs">⌘</kbd> <kbd className="kbd kbd-xs">Enter</kbd>
        </span>
        {explains && (
          <div className="join">
            <button
              type="button"
              className="btn btn-sm join-item"
              disabled={sql.trim() === "" || run.isPending}
              title="How PostgreSQL would run it (⌘E)"
              onClick={() => submit("plan")}
            >
              Explain
            </button>
            <button
              type="button"
              className="btn btn-sm join-item"
              disabled={sql.trim() === "" || run.isPending}
              title="Run it read-only and time each step (⌘⇧E)"
              onClick={() => submit("analyze")}
            >
              Analyze
            </button>
          </div>
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={sql.trim() === ""}
          onClick={() => setSaving(true)}
        >
          Save as template
        </button>
        <span className="grow" />
        <Status
          pending={run.isPending}
          cancelled={cancelled}
          error={run.isError && !cancelled ? describeError(run.error) : null}
          outcome={outcome}
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
            onSubmit={() => submit()}
            onExplain={(analyze) => submit(analyze ? "analyze" : "plan")}
            onJump={jump}
          />
        </Suspense>
      </div>

      <Splitter pane={EDITOR} axis="y" label="Resize the editor" />

      {saving && <TemplateFormDialog template={null} sql={sql} onClose={() => setSaving(false)} />}

      <div className="min-h-24 flex-1 basis-0">
        {outcome?.kind === "plan" ? (
          <PlanView
            key={run.submittedAt}
            plan={outcome.plan}
            shape={planShape}
            onShapeChange={setPlanShape}
          />
        ) : outcome && outcome.result.columns.length > 0 ? (
          <ResultGrid result={outcome.result} connectionId={connectionId} />
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
  outcome,
}: {
  pending: boolean;
  cancelled: boolean;
  error: string | null;
  outcome: Outcome | null;
}) {
  if (pending) return <span className="loading loading-spinner loading-xs" />;
  if (cancelled) return <span className="text-base-content/60 text-sm">Cancelled</span>;
  if (error) return <span className="text-error truncate font-mono text-sm">{error}</span>;
  if (!outcome) return null;
  if (outcome.kind === "plan") {
    return <span className="text-base-content/60 text-sm">{outcome.plan.elapsed_ms} ms</span>;
  }
  const { result } = outcome;
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
