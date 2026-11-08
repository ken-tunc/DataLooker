import { useQueryClient } from "@tanstack/react-query";
import { initVimMode } from "monaco-vim";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { StatementSpan } from "../../bindings/StatementSpan";
import type { SyntaxError } from "../../bindings/SyntaxError";
import { checkSyntax, splitStatements } from "../../lib/commands";
import { InstallServer } from "../language-server/InstallServer";
import { Estimate } from "../query-estimate/Estimate";
import { languageClientFor } from "../../lib/lsp/client";
import { useConnections } from "../connections/hooks";
import { schemaTreeQuery } from "../schema-tree/hooks";
import {
  analyzerCompleter,
  type Completer,
  completeWith,
  languageServerCompleter,
  registerCompletion,
} from "./completion";
import { documentUri } from "./documents";
import { formatWith, registerFormatting } from "./formatting";
import type { Dialect } from "./format";
import { identifierAt, type QualifiedName } from "./jump";
import { editor as monaco, KeyCode, KeyMod, MarkerSeverity, SQL_LANGUAGE, Uri } from "./monaco";
import { statementAt, trimmed } from "./statements";
import { useVimMode } from "./vim";

/** Whoever owns a marker can replace it, so the name has to be ours alone. */
const SYNTAX = "datalooker.syntax";

/** Monaco's own, registered by the import of its message contribution. */
const MESSAGES = "editor.contrib.messageController";
type Messages = monaco.IEditorContribution & {
  showMessage(message: string, position: { lineNumber: number; column: number }): void;
};

/** Long enough that a burst of typing is parsed once, short enough to feel live. */
const SETTLE_MS = 400;

/** Long enough to see what ran, short enough not to be mistaken for a selection. */
const FLASH_MS = 600;

const toMarker = (error: SyntaxError): monaco.IMarkerData => ({
  severity: MarkerSeverity.Error,
  message: error.message,
  startLineNumber: error.start_line,
  startColumn: error.start_column,
  endLineNumber: error.end_line,
  endColumn: error.end_column,
});

/** ⌘Enter runs the selection or the statement under the cursor, ⇧⌘Enter all of it. */
export type Scope = "statement" | "all";

/** What a run covers, and the statements in it, in order. */
export type Target = { text: string; statements: string[] };

export type EditorHandle = {
  /**
   * Null when the scope holds nothing to run. What it covers is highlighted
   * for a moment, so the reader sees what went to the server.
   */
  target(scope: Scope): Promise<Target | null>;
};

type Props = {
  ref?: Ref<EditorHandle>;
  /** Whose language server answers for this tab, and which document it is. */
  connectionId: string;
  tabId: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (scope: Scope) => void;
  /** ⌘E asks for the plan, ⇧⌘E for it measured. */
  onExplain: (analyze: boolean) => void;
  /** What ⇧⌘D and ⌘-click ask about: the name under the cursor. */
  onJump: (name: QualifiedName) => void;
};

export default function SqlEditor({
  ref,
  connectionId,
  tabId,
  value,
  onChange,
  onSubmit,
  onExplain,
  onJump,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const [vim, setVim] = useVimMode();
  const editor = useRef<monaco.IStandaloneCodeEditor | null>(null);
  // Monaco keeps the callbacks it was handed at mount, so they go through a
  // ref, updated in a layout effect: writing it during render could publish a
  // discarded render's handlers, and a passive effect would run too late.
  const handlers = useRef({ onChange, onSubmit, onExplain, onJump });
  useLayoutEffect(() => {
    handlers.current = { onChange, onSubmit, onExplain, onJump };
  });

  // BigQuery is completed by the analyzer, anything else by its language
  // server. A ref for the same reason as the handlers.
  const queryClient = useQueryClient();
  const config = useConnections().data?.find((c) => c.id === connectionId)?.config;
  const completer = useRef<Completer | null>(null);
  useLayoutEffect(() => {
    completer.current =
      config?.kind === "bigquery"
        ? analyzerCompleter(connectionId, config.project_id, () =>
            queryClient.ensureQueryData(schemaTreeQuery(connectionId)),
          )
        : languageServerCompleter(connectionId);
  });

  // Read when a format is asked for, since the connections may not have been
  // read when the editor was made. Until they are, neither grammar is assumed:
  // PostgreSQL's would split BigQuery's `@name` in two.
  const dialect = useRef<Dialect | null>(null);
  useLayoutEffect(() => {
    dialect.current = config ? (config.kind === "bigquery" ? "bigquery" : "postgresql") : null;
  });

  useEffect(() => {
    registerCompletion();
    registerFormatting();
    const client = languageClientFor(connectionId);
    // The URI says which connection's server to ask.
    const uri = Uri.parse(documentUri(connectionId, tabId));
    const model = monaco.getModel(uri) ?? monaco.createModel(value, SQL_LANGUAGE, uri);
    client.wrote(uri.toString(), value);
    const answering = completeWith(uri.toString(), async (model, position) =>
      completer.current ? completer.current(model, position) : [],
    );

    const instance = monaco.create(host.current as HTMLElement, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      renderLineHighlight: "none",
      // Monaco's own suggestions are just the words already in the document.
      wordBasedSuggestions: "off",
      padding: { top: 8, bottom: 8 },
      // Otherwise a hover on the first line is cut off by the editor's edge.
      fixedOverflowWidgets: true,
    });
    editor.current = instance;

    const formatting = formatWith(uri.toString(), {
      dialect: () => dialect.current,
      refused(reason, at) {
        const position = at ?? instance.getPosition();
        if (position) {
          instance
            .getContribution<Messages>(MESSAGES)
            ?.showMessage(`Left unformatted: ${reason}`, position);
        }
      },
    });

    const changed = instance.onDidChangeModelContent(() => {
      handlers.current.onChange(instance.getValue());
      client.wrote(uri.toString(), instance.getValue());
    });
    instance.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () =>
      handlers.current.onSubmit("statement"),
    );
    instance.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, () =>
      handlers.current.onSubmit("all"),
    );
    // Takes ⌘E from Monaco's "find with the selection", which ⌘F covers.
    instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyE, () => handlers.current.onExplain(false));
    instance.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE, () =>
      handlers.current.onExplain(true),
    );

    function jumpAt(position: { lineNumber: number; column: number } | null) {
      const line = position && instance.getModel()?.getLineContent(position.lineNumber);
      if (!position || line === undefined || line === null) return;
      // Monaco's columns count from one.
      const name = identifierAt(line, position.column - 1);
      if (name) handlers.current.onJump(name);
    }

    instance.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD, () =>
      jumpAt(instance.getPosition()),
    );
    // One key for either, as BigQuery's console has it: Monaco's own keys are
    // one for the document, even with a selection, and a chord for a selection.
    instance.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF, () =>
      instance.trigger(
        "keyboard",
        instance.getSelection()?.isEmpty() === false
          ? "editor.action.formatSelection"
          : "editor.action.formatDocument",
        null,
      ),
    );

    // Free: Monaco's multi-cursor click is ⌥, not ⌘.
    const clicked = instance.onMouseUp((event) => {
      if (event.event.metaKey || event.event.ctrlKey) jumpAt(event.target.position);
    });

    return () => {
      changed.dispose();
      clicked.dispose();
      answering();
      formatting();
      client.closed(uri.toString());
      instance.getModel()?.dispose();
      instance.dispose();
      editor.current = null;
    };
    // The editor owns its content after mount; `value` below only pushes a
    // change the editor did not make itself.
    // eslint-disable-next-line react/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (instance && instance.getValue() !== value) instance.setValue(value);
  }, [value]);

  // Only PostgreSQL's statements can be told apart: GoogleSQL has no splitter
  // here, so a BigQuery run is the selection or the whole text, as one script.
  const kind = config?.kind;
  useImperativeHandle(ref, () => ({
    async target(scope) {
      const instance = editor.current;
      const model = instance?.getModel();
      if (!instance || !model) return null;
      const text = model.getValue();
      const whole = { start: 0, end: text.length };
      const selection = instance.getSelection();
      const splits = kind === "postgres";

      let span: StatementSpan | null | undefined;
      let alone = false;
      if (scope === "all") span = trimmed(text, whole);
      else if (selection && !selection.isEmpty()) {
        span = trimmed(text, {
          start: model.getOffsetAt(selection.getStartPosition()),
          end: model.getOffsetAt(selection.getEndPosition()),
        });
      } else if (splits) {
        const cursor = model.getOffsetAt(instance.getPosition() ?? { lineNumber: 1, column: 1 });
        span = statementAt(text, await splitStatements(text), cursor);
        alone = true;
      } else span = trimmed(text, whole);
      if (!span) return null;

      const covered = text.slice(span.start, span.end);
      const statements =
        splits && !alone
          ? (await splitStatements(covered)).map(({ start, end }) => covered.slice(start, end))
          : [covered];
      if (statements.length === 0) return null;

      // Placed by the text it was read from, which a keystroke since may have
      // moved; a moment's highlight a few characters off is harmless.
      if (instance.getModel() === model && model.getValueLength() >= span.end) {
        const from = model.getPositionAt(span.start);
        const to = model.getPositionAt(span.end);
        const flash = instance.createDecorationsCollection([
          {
            range: {
              startLineNumber: from.lineNumber,
              startColumn: from.column,
              endLineNumber: to.lineNumber,
              endColumn: to.column,
            },
            options: { className: "ran-flash" },
          },
        ]);
        setTimeout(() => flash.clear(), FLASH_MS);
      }
      return { text: covered, statements };
    },
  }));

  // The check is PostgreSQL's grammar, which refuses GoogleSQL such as a
  // backquoted `project.dataset.table`. The kind is a dependency so that marks
  // made before the connections were read are cleared once it is known.
  useEffect(() => {
    if (kind === "bigquery") {
      const model = editor.current?.getModel();
      if (model) monaco.setModelMarkers(model, SYNTAX, []);
      return;
    }

    let live = true;
    const timer = setTimeout(async () => {
      // A later keystroke starts this over.
      const found = await checkSyntax(value).catch(() => []);
      const model = editor.current?.getModel();
      if (live && model) monaco.setModelMarkers(model, SYNTAX, found.map(toMarker));
    }, SETTLE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value, kind]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance || !vim) return;
    const mode = initVimMode(instance, status.current);
    return () => mode.dispose();
  }, [vim]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div ref={host} className="min-h-0 w-full flex-1" />
      {/* Monaco paints its own background (`vs-dark`) rather than reading the
          theme, so the row under it takes the same colour by hand. */}
      <div className="flex items-center gap-3 bg-[#1e1e1e] px-2 py-1 text-xs">
        {/* Where vim writes `-- INSERT --` and the `:` line it is reading. It
            hides the node it was handed when it is turned off, and a hidden
            node holds no space, so what keeps the row's shape is the span
            around it rather than the one vim writes to. */}
        <span className="text-muted grow truncate font-mono">
          <span ref={status} />
        </span>
        {kind === "bigquery" && <Estimate connectionId={connectionId} sql={value} />}
        <InstallServer connectionId={connectionId} />
        <label className="flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            className="toggle toggle-xs"
            checked={vim}
            onChange={(event) => setVim(event.target.checked)}
          />
          Vim
        </label>
      </div>
    </div>
  );
}
