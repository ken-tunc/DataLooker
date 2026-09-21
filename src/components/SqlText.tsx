import { useEffect, useState } from "react";

/**
 * Colours a statement with the editor's own tokenizer, so that a definition
 * reads the way the same SQL would in a tab. Monaco is imported when the first
 * statement is drawn rather than in this module's own chunk: opening a
 * connection opens a SQL tab, which has already loaded it, and nothing here
 * should be what pulls three megabytes in.
 */
async function colorize(sql: string): Promise<string> {
  const { editor, SQL_LANGUAGE } = await import("../features/sql-editor/monaco");
  return editor.colorize(sql, SQL_LANGUAGE, { tabSize: 4 });
}

const STYLE = "bg-base-200 overflow-x-auto rounded-box p-3 font-mono text-xs whitespace-pre";

export function SqlText({ children, className }: { children: string; className?: string }) {
  const [coloured, setColoured] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    colorize(children)
      // The statement is worth reading uncoloured, so a tokenizer that never
      // arrives leaves the text rather than an empty box.
      .then((html) => {
        if (live) setColoured(html);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [children]);

  // Monaco escapes the text it colours, and what it is handed came from the
  // catalogs of the database the reader opened.
  return coloured === null ? (
    <pre className={`${STYLE} ${className ?? ""}`}>{children}</pre>
  ) : (
    <pre
      className={`${STYLE} ${className ?? ""}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: colorize returns spans
      dangerouslySetInnerHTML={{ __html: coloured }}
    />
  );
}
