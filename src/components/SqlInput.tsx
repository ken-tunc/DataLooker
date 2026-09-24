import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Colorizer = (line: string) => string;

let loading: Promise<Colorizer> | null = null;

/**
 * The editor's own tokenizer, as `SqlText` uses, but synchronous: colouring a
 * keystroke asynchronously would paint the new text a frame before its colours.
 * One model is enough, since a line is coloured the moment it is set.
 */
function loadColorizer(): Promise<Colorizer> {
  loading ??= (async () => {
    const { editor, SQL_LANGUAGE } = await import("../features/sql-editor/monaco");
    // Settles once the language's tokenizer has loaded; before that a model
    // tokenizes everything as plain text.
    await editor.colorize("", SQL_LANGUAGE, {});
    const model = editor.createModel("", SQL_LANGUAGE);
    return (line: string) => {
      model.setValue(line);
      return editor.colorizeModelLine(model, 1);
    };
  })();
  return loading;
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

/**
 * A one-line input whose SQL is coloured: the input's own text is transparent
 * over a coloured copy, so the caret, selection and editing stay the browser's.
 */
export function SqlInput({ value, onChange, placeholder, className }: Props) {
  const [colorize, setColorize] = useState<Colorizer | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const overlay = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let live = true;
    loadColorizer()
      .then((colorizer) => {
        if (live) setColorize(() => colorizer);
      })
      // The input's own text stays visible.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The coloured copy has to scroll with the text the input scrolled to keep
  // the caret in view.
  function follow() {
    if (input.current && overlay.current) {
      overlay.current.style.translate = `${-input.current.scrollLeft}px 0`;
    }
  }
  useLayoutEffect(follow);

  const html = colorize?.(value) ?? null;

  return (
    <label className={`input font-mono ${className ?? ""}`}>
      <span className="relative flex h-full min-w-0 grow overflow-hidden">
        {html !== null && (
          <span
            ref={overlay}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 flex items-center whitespace-pre"
            // Monaco escapes the text it colours.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        <input
          ref={input}
          className={html === null ? "" : "caret-base-content text-transparent"}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={follow}
          onSelect={follow}
        />
      </span>
    </label>
  );
}
