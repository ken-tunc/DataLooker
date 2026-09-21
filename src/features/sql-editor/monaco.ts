// The editor API brings no editor features and no languages of its own, so
// this file is the list of what DataLooker actually needs: a SQL editor, not
// the IDE Monaco ships by default.
import "monaco-editor/features/bracketMatching/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/comment/register.js";
import "monaco-editor/features/contextmenu/register.js";
import "monaco-editor/features/cursorUndo/register.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/gotoLine/register.js";
// Reads out a syntax error where it is marked.
import "monaco-editor/features/hover/register.js";
import "monaco-editor/features/indentation/register.js";
import "monaco-editor/features/linesOperations/register.js";
import "monaco-editor/features/multicursor/register.js";
import "monaco-editor/features/smartSelect/register.js";
import "monaco-editor/features/snippet/register.js";
import "monaco-editor/features/suggest/register.js";
import "monaco-editor/features/tokenization/register.js";
import "monaco-editor/features/wordHighlighter/register.js";
import "monaco-editor/features/wordOperations/register.js";
import "monaco-editor/features/wordPartOperations/register.js";
import "monaco-editor/languages/definitions/pgsql/register.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

import { editor } from "monaco-editor/editor/editor.api.js";

export {
  KeyCode,
  KeyMod,
  MarkerSeverity,
  editor,
  languages,
} from "monaco-editor/editor/editor.api.js";

// Monaco paints itself rather than reading the page's theme, and it holds one
// theme for everything it draws. Setting it here rather than on each editor is
// what makes a statement coloured outside one — a table's definition — come
// out the same colours as the same SQL in a tab.
editor.setTheme("vs-dark");

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

/** The language id the pgsql definition registers under. */
export const SQL_LANGUAGE = "pgsql";
