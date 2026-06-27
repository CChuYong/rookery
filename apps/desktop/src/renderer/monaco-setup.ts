import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Theme the editor/diff onto the ink-coral deck (stock vs-dark's #1e1e1e reads as "a different app" next to the tokenized
// panels). Hardcoded hex mirrors @theme — globals.css isn't loaded yet at this import (top of main.tsx), so getComputedStyle
// would be empty here. inherit:true keeps vs-dark's syntax token colors; we only override the chrome.
monaco.editor.defineTheme("rookery-ink", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0b0d12", // --color-ink
    "editor.foreground": "#e7e9ee", // --color-fg
    "editorCursor.foreground": "#f97362", // --color-accent
    "editor.selectionBackground": "#f9736233", // coral wash (accent @ ~20%)
    "editor.lineHighlightBackground": "#13161d", // --color-surface
    "editorLineNumber.foreground": "#79808f", // --color-muted
    "editorLineNumber.activeForeground": "#aab1c0", // --color-fg-dim
    "editorIndentGuide.background1": "#232936", // --color-line
    "editorIndentGuide.activeBackground1": "#2a313d",
    "editorWhitespace.foreground": "#232936",
    "editorWidget.background": "#13161d",
    "editorWidget.border": "#232936",
    "input.background": "#0b0d12",
    "focusBorder": "#f9736266", // accent @ 40%
    "scrollbarSlider.background": "#2a313d80",
    "scrollbarSlider.hoverBackground": "#38414f80",
    "diffEditor.insertedTextBackground": "#46c07322", // --color-pr @ ~13%
    "diffEditor.removedTextBackground": "#ef535022", // --color-fail @ ~13%
    "diffEditor.insertedLineBackground": "#46c07314",
    "diffEditor.removedLineBackground": "#ef535014",
    "editorGutter.addedBackground": "#46c073",
    "editorGutter.deletedBackground": "#ef5350",
    "editorGutter.modifiedBackground": "#5b8def", // --color-nochg
  },
});

// Monaco needs web workers for its language services. Since this is Electron (offline), we self-host them via Vite ?worker instead of the CDN loader.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};
