import { initVimMode } from "monaco-vim";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { SyntaxError } from "../../bindings/SyntaxError";
import { checkSyntax } from "../../lib/commands";
import { identifierAt, type QualifiedName } from "./jump";
import { editor as monaco, KeyCode, KeyMod, MarkerSeverity, SQL_LANGUAGE } from "./monaco";
import { useVimMode } from "./vim";

/** Whoever owns a marker can replace it, so the name has to be ours alone. */
const SYNTAX = "datalooker.syntax";

/** Long enough that a burst of typing is parsed once, short enough to feel live. */
const SETTLE_MS = 400;

const toMarker = (error: SyntaxError): monaco.IMarkerData => ({
  severity: MarkerSeverity.Error,
  message: error.message,
  startLineNumber: error.start_line,
  startColumn: error.start_column,
  endLineNumber: error.end_line,
  endColumn: error.end_column,
});

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** What ⌘⇧D and ⌘-click ask about: the name under the cursor. */
  onJump: (name: QualifiedName) => void;
};

export default function SqlEditor({ value, onChange, onSubmit, onJump }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const [vim, setVim] = useVimMode();
  const editor = useRef<monaco.IStandaloneCodeEditor | null>(null);
  // Monaco keeps the callback it was handed at mount, so the handlers reach it
  // through a ref. Writing that ref while rendering would publish handlers from
  // a render React can still throw away, and a passive effect would leave the
  // previous ones live until after the browser could dispatch to Monaco.
  const handlers = useRef({ onChange, onSubmit, onJump });
  useLayoutEffect(() => {
    handlers.current = { onChange, onSubmit, onJump };
  });

  useEffect(() => {
    const instance = monaco.create(host.current as HTMLElement, {
      value,
      language: SQL_LANGUAGE,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      renderLineHighlight: "none",
      padding: { top: 8, bottom: 8 },
      // A hover or a suggestion is drawn inside the editor by default, so the
      // one belonging to the first line is cut off by its top edge. This hands
      // them to a layer over the window instead.
      fixedOverflowWidgets: true,
    });
    editor.current = instance;

    const changed = instance.onDidChangeModelContent(() => {
      handlers.current.onChange(instance.getValue());
    });
    instance.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => handlers.current.onSubmit());

    function jumpAt(position: { lineNumber: number; column: number } | null) {
      const line = position && instance.getModel()?.getLineContent(position.lineNumber);
      if (!position || line === undefined || line === null) return;
      // Monaco counts columns from one, and a column is the place before the
      // character of that number — which is the index of that character.
      const name = identifierAt(line, position.column - 1);
      if (name) handlers.current.onJump(name);
    }

    instance.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD, () =>
      jumpAt(instance.getPosition()),
    );
    // The other half of the same gesture. Monaco puts a second cursor on an
    // ⌥-click rather than a ⌘-click, so this takes nothing that was in use.
    const clicked = instance.onMouseUp((event) => {
      if (event.event.metaKey || event.event.ctrlKey) jumpAt(event.target.position);
    });

    return () => {
      changed.dispose();
      clicked.dispose();
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

  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      // The parser is the backend's, so what comes back describes the text as
      // it was when this ran — a later keystroke starts this over.
      const found = await checkSyntax(value).catch(() => []);
      const model = editor.current?.getModel();
      if (live && model) monaco.setModelMarkers(model, SYNTAX, found.map(toMarker));
    }, SETTLE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance || !vim) return;
    const mode = initVimMode(instance, status.current);
    return () => mode.dispose();
  }, [vim]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div ref={host} className="min-h-0 w-full flex-1" />
      <div className="flex items-center gap-3 px-2 pt-1 text-xs">
        {/* Where vim writes `-- INSERT --` and the `:` line it is reading. It
            hides the node it was handed when it is turned off, and a hidden
            node holds no space, so what keeps the row's shape is the span
            around it rather than the one vim writes to. */}
        <span className="text-base-content/70 grow truncate font-mono">
          <span ref={status} />
        </span>
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
