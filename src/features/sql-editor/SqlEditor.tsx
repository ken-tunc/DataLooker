import { useEffect, useLayoutEffect, useRef } from "react";
import { editor as monaco, KeyCode, KeyMod, SQL_LANGUAGE } from "./monaco";

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

  return <div ref={host} className="h-full w-full" />;
}
