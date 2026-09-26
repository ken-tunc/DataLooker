import { type Dialect, formatted } from "./format";
import { languages, SQL_LANGUAGE } from "./monaco";

/**
 * How a tab formats its document, and where it says it would not. No dialect
 * means the tab does not know yet which database it is written for.
 */
export type Formatter = {
  dialect: () => Dialect | null;
  refused: (reason: string, at: { lineNumber: number; column: number } | null) => void;
};

/**
 * Monaco holds formatting providers by language, not by editor, so one
 * provider answers every tab by asking whoever the tab registered here.
 */
const formatters = new Map<string, Formatter>();

/** Format this document with `formatter` until the returned function is called. */
export function formatWith(uri: string, formatter: Formatter): () => void {
  formatters.set(uri, formatter);
  return () => {
    if (formatters.get(uri) === formatter) formatters.delete(uri);
  };
}

let registered = false;

/** A range provider is all Monaco needs: it formats a document as its whole range. */
export function registerFormatting() {
  if (registered) return;
  registered = true;

  languages.registerDocumentRangeFormattingEditProvider(SQL_LANGUAGE, {
    provideDocumentRangeFormattingEdits(model, range, options) {
      const formatter = formatters.get(model.uri.toString());
      if (!formatter) return [];
      const dialect = formatter.dialect();
      if (!dialect) {
        formatter.refused("the connection has not been read yet", null);
        return [];
      }
      const lineStart = model.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1);
      const result = formatted(model.getValueInRange(range), dialect, options.tabSize, lineStart);
      if (!result.ok) {
        // Moved from the range's own lines into the document's.
        const at = result.at && {
          lineNumber: result.at.line + range.startLineNumber - 1,
          column: result.at.column + (result.at.line === 1 ? range.startColumn - 1 : 0),
        };
        formatter.refused(result.reason, at);
        return [];
      }
      return [{ range, text: result.text }];
    },
  });
}
