import type { SchemaTree } from "../../bindings/SchemaTree";
import { complete } from "../../lib/commands";
import { languageClientFor } from "../../lib/lsp/client";
import type { CompletionItem } from "../../lib/lsp/client";
import { type Offered, offered, tablesAfter } from "./candidates";
import { type editor, languages, SQL_LANGUAGE } from "./monaco";

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
 * Ask the connection's language server, which is how PostgreSQL is completed.
 * The range is the word the reader has typed so far: a server sends the whole
 * name it is offering, so the part already there is what the name replaces
 * rather than something it follows.
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

/**
 * Ask the analyzer, which is how BigQuery is completed. It reads the statement
 * and says what can go at the cursor, save for which tables there are: that is
 * the schema tree's to say, and `tree` is how it is read.
 */
export function analyzerCompleter(
  connectionId: string,
  project: string,
  tree: () => Promise<SchemaTree>,
): Completer {
  return async (model, position) => {
    // The offsets either way are UTF-16 units of the text as the model holds
    // it, which is what the model counts in.
    const answer = await complete(connectionId, model.getValue(), model.getOffsetAt(position))
      // Completion that cannot be had is completion that is not offered; the
      // footer is where a missing analyzer is said.
      .catch(() => ({ kind: "nothing" as const }));
    if (answer.kind === "nothing") return [];

    const names =
      answer.kind === "names"
        ? offered(answer.candidates, answer.expected_type)
        : // A tree that cannot be read is tables that cannot be offered.
          await tree()
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
 * Who answers for each open document. Monaco holds completion providers by
 * language rather than by editor, so one provider answers for every tab and
 * hands each question to whoever the tab's editor said answers for it.
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
    // What a reader has typed is a prefix of a name, and the two characters
    // that start one where no word has begun: a qualified name and a call.
    triggerCharacters: [".", "("],
    async provideCompletionItems(model, position) {
      const completer = completers.get(model.uri.toString());
      return { suggestions: completer ? await completer(model, position) : [] };
    },
  });
}
