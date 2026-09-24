// The editor API brings no features or languages; this is the list DataLooker
// needs, rather than everything Monaco's main entry ships.
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
// The suggestion widget. The `suggest` feature entry registers only inline
// (ghost text) suggestions, so the widget's contribution is imported directly.
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
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
  Uri,
  editor,
  languages,
} from "monaco-editor/editor/editor.api.js";

// Monaco holds one theme for everything it draws, so it is set here rather than
// per editor; `colorize` outside an editor uses it too.
editor.setTheme("vs-dark");

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

/** The language id the pgsql definition registers under. */
export const SQL_LANGUAGE = "pgsql";
