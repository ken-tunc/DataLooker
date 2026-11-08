import { useMutation } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";
import type { Risk } from "../../bindings/Risk";
import { EmptyState } from "../../components/EmptyState";
import { Keys } from "../../components/Keys";
import { Splitter } from "../../components/Splitter";
import { useToast } from "../../components/useToast";
import { statementRisks } from "../../lib/commands";
import { describeError, IpcError } from "../../lib/invoke";
import { type Pane, usePaneSize } from "../../lib/paneSize";
import { useDriver } from "../connections/hooks";
import { TemplateFormDialog } from "../query-templates/TemplateFormDialog";
import { useSchemaTree } from "../schema-tree/hooks";
import { type QualifiedName, tablesNamed, written } from "../sql-editor/jump";
import type { EditorHandle, Scope, Target } from "../sql-editor/SqlEditor";
import { PlanView, type Shape } from "../query-plan/PlanView";
import { Results } from "./Results";
import { said } from "./said";
import { RiskDialog } from "./RiskDialog";
import { type Outcome, type Request, useQueryRunner } from "./hooks";

// Monaco is by far the heaviest thing here, so it loads on first use.
const SqlEditor = lazy(() => import("../sql-editor/SqlEditor"));

const EDITOR: Pane = { key: "datalooker.editor-height", initial: 224, min: 80, max: 2000 };

type Props = {
  connectionId: string;
  tabId: string;
  sql: string;
  onSqlChange: (sql: string) => void;
  /** Whatever ran it, Explain included. */
  onRun: () => void;
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
  onRun,
  hidden,
  onOpenStructure,
  onFindTable,
}: Props) {
  const { run, cancel } = useQueryRunner(connectionId);
  const editor = useRef<EditorHandle>(null);
  // Finding what to run asks the backend to split the text, and a second
  // keystroke meanwhile would run it twice.
  const resolving = useRef(false);
  const [editorHeight] = usePaneSize(EDITOR);
  const { show } = useToast();
  const tree = useSchemaTree(connectionId);
  const [saving, setSaving] = useState(false);
  // Only PostgreSQL says how it would run a statement.
  const explains = useDriver(connectionId) === "postgres";
  const outcome = run.isSuccess ? run.data : null;
  // A failed plan rejects; a failed statement stops a run that may have
  // results from the ones before it.
  const failure = run.isError ? run.error : outcome?.kind === "rows" ? outcome.error : null;
  const cancelled = failure instanceof IpcError && failure.kind === "Cancelled";
  // Of several, which one failed: it stopped where its results did.
  const where =
    outcome?.kind === "rows" && outcome.statements.length > 1
      ? `Statement ${outcome.results.length + 1}: `
      : "";
  const [planShape, setPlanShape] = useState<Shape>("table");
  const [asking, setAsking] = useState<{ statements: string[]; risks: Risk[] } | null>(null);
  // A plan needs no asking: it is made where nothing it does is kept.
  const check = useMutation({
    // Statement by statement, since that is how they run: asked of the whole,
    // a typo in a later one would leave the text unparsed and an earlier
    // `DELETE` unasked about.
    mutationFn: async ({ statements }: Target) =>
      (await Promise.all(statements.map((one) => statementRisks(connectionId, one)))).flat(),
    onSuccess: (risks, { statements }) => {
      if (risks.length > 0) setAsking({ statements, risks });
      else start({ kind: "rows", statements });
    },
    // Not run: what could not be asked about would go unasked. Text that does
    // not parse has nothing to ask about rather than failing.
  });
  const busy = run.isPending || check.isPending;

  /** Only what runs counts as run: a statement the reader backs out of does not. */
  function start(request: Request) {
    run.mutate(request);
    onRun();
  }

  /** What runs, or is explained, is the selection, the statement under the cursor, or all of it. */
  async function submit(scope: Scope, explain: "plan" | "analyze" | null = null) {
    if (explain !== null && !explains) return;
    if (busy || asking || resolving.current) return;
    let target: Target | null | undefined;
    resolving.current = true;
    try {
      target = await editor.current?.target(scope);
    } catch (error) {
      show(`${describeError(error)} — nothing was run.`, "error");
      return;
    } finally {
      resolving.current = false;
    }
    if (!target) return;
    if (explain === null) check.mutate(target);
    else if (target.statements.length > 1) {
      show("A plan is of one statement: select it, or put the cursor in it.", "info");
    } else {
      check.reset();
      start({ kind: "plan", sql: target.text, analyze: explain === "analyze" });
    }
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
            disabled={sql.trim() === "" || check.isPending}
            title="Run the selection, or the statement under the cursor"
            onClick={() => void submit("statement")}
          >
            Run
          </button>
        )}
        <span className="text-faint flex items-center gap-1 text-xs">
          <Keys keys="⌘Enter" size="xs" />
          <span>·</span>
          <span>all</span>
          <Keys keys="⇧⌘Enter" size="xs" />
        </span>
        {explains && (
          <div className="join">
            <button
              type="button"
              className="btn btn-sm join-item"
              disabled={sql.trim() === "" || busy}
              title="How PostgreSQL would run it (⌘E)"
              onClick={() => void submit("statement", "plan")}
            >
              Explain
            </button>
            <button
              type="button"
              className="btn btn-sm join-item"
              disabled={sql.trim() === "" || busy}
              title="Run it read-only and time each step (⇧⌘E)"
              onClick={() => void submit("statement", "analyze")}
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
          pending={busy}
          cancelled={cancelled && !check.isError}
          error={
            check.isError
              ? describeError(check.error)
              : failure !== null && !cancelled
                ? `${where}${describeError(failure)}`
                : null
          }
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
            ref={editor}
            connectionId={connectionId}
            tabId={tabId}
            value={sql}
            onChange={onSqlChange}
            onSubmit={(scope) => void submit(scope)}
            onExplain={(analyze) => void submit("statement", analyze ? "analyze" : "plan")}
            onJump={jump}
          />
        </Suspense>
      </div>

      <Splitter pane={EDITOR} axis="y" label="Resize the editor" />

      {/* Asked only in front: a modal from a tab behind would hold the one the
        reader moved to. It waits, and is asked when its tab comes back. */}
      {asking && !hidden && (
        <RiskDialog
          risks={asking.risks}
          onRun={() => start({ kind: "rows", statements: asking.statements })}
          onClose={() => setAsking(null)}
        />
      )}

      {saving && <TemplateFormDialog template={null} sql={sql} onClose={() => setSaving(false)} />}

      <div className="min-h-24 flex-1 basis-0">
        {outcome?.kind === "plan" ? (
          <PlanView
            key={run.submittedAt}
            plan={outcome.plan}
            shape={planShape}
            onShapeChange={setPlanShape}
          />
        ) : outcome ? (
          <Results key={run.submittedAt} ran={outcome} connectionId={connectionId} />
        ) : (
          <EmptyState>Run a query to see its rows.</EmptyState>
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
  if (cancelled) return <span className="text-muted text-sm">Cancelled</span>;
  if (error) return <span className="text-error truncate font-mono text-sm">{error}</span>;
  if (!outcome) return null;
  if (outcome.kind === "plan") {
    return <span className="text-muted text-sm">{outcome.plan.elapsed_ms} ms</span>;
  }
  const { statements, results } = outcome;
  const [only] = results;
  const elapsed = results.reduce((sum, result) => sum + result.elapsed_ms, 0);
  return (
    <span className="text-muted flex gap-3 text-sm">
      <span>
        {statements.length === 1 && only ? said(only) : `${statements.length} statements`}
      </span>
      <span>{elapsed} ms</span>
    </span>
  );
}
