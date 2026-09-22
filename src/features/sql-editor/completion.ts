import { languageClientFor } from "../../lib/lsp/client";
import type { CompletionItem } from "../../lib/lsp/client";
import { connectionOf } from "./documents";
import { languages, SQL_LANGUAGE } from "./monaco";

/**
 * The kinds a server may name, in the protocol's order. Monaco numbers its own
 * kinds differently, so the number that arrives is read as a name and handed
 * back to Monaco as its own.
 */
const KINDS = [
  "Text",
  "Method",
  "Function",
  "Constructor",
  "Field",
  "Variable",
  "Class",
  "Interface",
  "Module",
  "Property",
  "Unit",
  "Value",
  "Enum",
  "Keyword",
  "Snippet",
  "Color",
  "File",
  "Reference",
  "Folder",
  "EnumMember",
  "Constant",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
] as const satisfies readonly (keyof typeof languages.CompletionItemKind)[];

const kindOf = (kind: number | undefined) =>
  languages.CompletionItemKind[KINDS[(kind ?? 1) - 1] ?? "Text"];

/** What the word being completed covers, which is what a name replaces. */
type Range = {
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
};

const textOf = (documentation: CompletionItem["documentation"]) =>
  typeof documentation === "object" ? documentation.value : documentation;

/**
 * One item as Monaco takes it. The range is the word the reader has typed so
 * far: a server sends the whole name it is offering, so the part already there
 * is what the name replaces rather than something it follows.
 */
function suggestion(item: CompletionItem, range: Range): languages.CompletionItem {
  return {
    label: item.label,
    kind: kindOf(item.kind),
    insertText: item.insertText ?? item.label,
    detail: item.detail,
    documentation: textOf(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    range,
  };
}

let registered = false;

/**
 * Let Monaco ask a connection's language server what could follow. One
 * provider answers for every editor: Monaco holds providers by language, and
 * which server to ask is what the document's URI says.
 */
export function registerCompletion() {
  if (registered) return;
  registered = true;

  languages.registerCompletionItemProvider(SQL_LANGUAGE, {
    // What a reader has typed is a prefix of a name, and the two characters
    // that start one where no word has begun: a qualified name and a call.
    triggerCharacters: [".", "("],
    async provideCompletionItems(model, position) {
      const connectionId = connectionOf(model.uri.toString());
      if (connectionId === null) return { suggestions: [] };

      const items = await languageClientFor(connectionId).completions(model.uri.toString(), {
        line: position.lineNumber - 1,
        character: position.column - 1,
      });

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: position.column,
      };
      return { suggestions: items.map((item) => suggestion(item, range)) };
    },
  });
}
