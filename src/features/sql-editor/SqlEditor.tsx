import { useEffect, useLayoutEffect, useRef } from "react";
import type { SyntaxError } from "../../bindings/SyntaxError";
import { checkSyntax } from "../../lib/commands";
import { editor as monaco, KeyCode, KeyMod, MarkerSeverity, SQL_LANGUAGE } from "./monaco";

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
};

export default function SqlEditor({ value, onChange, onSubmit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.IStandaloneCodeEditor | null>(null);
  // Monaco keeps the callback it was handed at mount, so the handlers reach it
  // through a ref. Writing that ref while rendering would publish handlers from
  // a render React can still throw away, and a passive effect would leave the
  // previous ones live until after the browser could dispatch to Monaco.
  const handlers = useRef({ onChange, onSubmit });
  useLayoutEffect(() => {
    handlers.current = { onChange, onSubmit };
  });

  useEffect(() => {
    const instance = monaco.create(host.current as HTMLElement, {
      value,
      language: SQL_LANGUAGE,
      theme: "vs-dark",
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

    return () => {
      changed.dispose();
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

  return <div ref={host} className="h-full w-full" />;
}
