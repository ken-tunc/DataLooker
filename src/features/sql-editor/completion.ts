import type { SchemaTree } from "../../bindings/SchemaTree";
import { complete } from "../../lib/commands";
import { languageClientFor } from "../../lib/lsp/client";
import type { CompletionItem } from "../../lib/lsp/client";
import { type Offered, offered, tablesAfter } from "./candidates";
import { type editor, languages, SQL_LANGUAGE } from "./monaco";

/** LSP's kinds, in its order. Monaco numbers them differently, so they are mapped by name. */
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

/** How what the analyzer offers is drawn, in Monaco's own kinds. */
const OFFERED_KINDS = {
  column: "Field",
  field: "Property",
  range_variable: "Variable",
  dataset: "Module",
  table: "Class",
} as const satisfies Record<Offered["kind"], keyof typeof languages.CompletionItemKind>;

type Position = { lineNumber: number; column: number };

/** What could go at a position of a document, as Monaco takes it. */
export type Completer = (
  model: editor.ITextModel,
  position: Position,
) => Promise<languages.CompletionItem[]>;

const textOf = (documentation: CompletionItem["documentation"]) =>
  typeof documentation === "object" ? documentation.value : documentation;

/**
 * PostgreSQL. sqls sends labels without a range, so an item replaces the word
 * typed so far.
 */
export function languageServerCompleter(connectionId: string): Completer {
  return async (model, position) => {
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
    return items.map((item) => ({
      label: item.label,
      kind: kindOf(item.kind),
      insertText: item.insertText ?? item.label,
      detail: item.detail,
      documentation: textOf(item.documentation),
      sortText: item.sortText,
      filterText: item.filterText,
      range,
    }));
  };
}

/** BigQuery. Table names come from the schema tree the window already holds. */
export function analyzerCompleter(
  connectionId: string,
  project: string,
  tree: () => Promise<SchemaTree>,
): Completer {
  return async (model, position) => {
    const answer = await complete(connectionId, model.getValue(), model.getOffsetAt(position))
      // The footer says when the analyzer is missing.
      .catch(() => ({ kind: "nothing" as const }));
    if (answer.kind === "nothing") return [];

    const names =
      answer.kind === "names"
        ? offered(answer.candidates, answer.expected_type)
        : await tree()
            .then((schema) => tablesAfter(answer.path, schema, project))
            .catch(() => []);
    const start = model.getPositionAt(answer.replace.start);
    const end = model.getPositionAt(answer.replace.end);
    const range = {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    };
    return names.map((name) => ({
      label: name.label,
      kind: languages.CompletionItemKind[OFFERED_KINDS[name.kind]],
      insertText: name.label,
      detail: name.detail,
      sortText: name.sortText,
      range,
    }));
  };
}

/**
 * Monaco holds completion providers by language, not by editor, so one
 * provider answers every tab by asking whoever the tab registered here.
 */
const completers = new Map<string, Completer>();

/** Answer for this document with `completer` until the returned function is called. */
export function completeWith(uri: string, completer: Completer): () => void {
  completers.set(uri, completer);
  return () => {
    if (completers.get(uri) === completer) completers.delete(uri);
  };
}

let registered = false;

export function registerCompletion() {
  if (registered) return;
  registered = true;

  languages.registerCompletionItemProvider(SQL_LANGUAGE, {
    // A qualified name and a call start where no word has begun.
    triggerCharacters: [".", "("],
    async provideCompletionItems(model, position) {
      const completer = completers.get(model.uri.toString());
      return { suggestions: completer ? await completer(model, position) : [] };
    },
  });
}
