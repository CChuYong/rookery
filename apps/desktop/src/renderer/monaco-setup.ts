import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Theme the editor/diff onto the neutral IDE deck (stock vs-dark's #1e1e1e reads as "a different app" next to the tokenized
// panels). Hardcoded hex mirrors @theme — globals.css isn't loaded yet at this import (top of main.tsx), so getComputedStyle
// would be empty here. inherit:true keeps vs-dark's syntax token colors; we only override the chrome.
monaco.editor.defineTheme("rookery-ink", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0f0f0f", // --color-ink
    "editor.foreground": "#e8e8e8", // --color-fg
    "editorCursor.foreground": "#f97c3d", // --color-accent
    "editor.selectionBackground": "#f97c3d38", // orange wash (accent @ ~22%)
    "editor.lineHighlightBackground": "#161616", // --color-surface
    "editorLineNumber.foreground": "#5b5b5b", // --color-faint
    "editorLineNumber.activeForeground": "#b7b7b7", // --color-fg-dim
    "editorIndentGuide.background1": "#252525", // --color-line
    "editorIndentGuide.activeBackground1": "#303030",
    "editorWhitespace.foreground": "#252525",
    "editorWidget.background": "#161616",
    "editorWidget.border": "#252525",
    "input.background": "#0c0c0c",
    "focusBorder": "#f97c3d66", // accent @ 40%
    "scrollbarSlider.background": "#30303080",
    "scrollbarSlider.hoverBackground": "#44444480",
    "diffEditor.insertedTextBackground": "#6fc88422", // --color-pr @ ~13%
    "diffEditor.removedTextBackground": "#f2716622", // --color-fail @ ~13%
    "diffEditor.insertedLineBackground": "#6fc88414",
    "diffEditor.removedLineBackground": "#f2716614",
    "editorGutter.addedBackground": "#6fc884",
    "editorGutter.deletedBackground": "#f27166",
    "editorGutter.modifiedBackground": "#6db0f4", // --color-run
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
