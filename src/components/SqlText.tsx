import { useEffect, useState } from "react";

/**
 * The editor's own tokenizer, so a definition reads as the same SQL does in a
 * tab. Imported dynamically: opening a connection opens a SQL tab, which has
 * loaded Monaco already.
 */
async function colorize(sql: string): Promise<string> {
  const { editor, SQL_LANGUAGE } = await import("../features/sql-editor/monaco");
  return editor.colorize(sql, SQL_LANGUAGE, { tabSize: 4 });
}

const STYLE = "bg-base-200 overflow-x-auto rounded-box p-3 font-mono text-sm whitespace-pre";

export function SqlText({ children, className }: { children: string; className?: string }) {
  const [coloured, setColoured] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    colorize(children)
      // Uncoloured text beats an empty box.
      .then((html) => {
        if (live) setColoured(html);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [children]);

  // Monaco escapes the text it colours.
  return coloured === null ? (
    <pre className={`${STYLE} ${className ?? ""}`}>{children}</pre>
  ) : (
    <pre className={`${STYLE} ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: coloured }} />
  );
}
