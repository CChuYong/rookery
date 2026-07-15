import { act } from "@testing-library/react";
import { getEditorPropertyFromDOMNode, isLexicalEditor } from "lexical";
import { $getRoot } from "lexical";
import { $setPromptText } from "../src/renderer/editor/prompt-serialization.js";

/** Set a PromptEditor's model in component tests without mutating its managed DOM. */
export function setPromptEditorText(element: HTMLElement, text: string): void {
  const editor = getEditorPropertyFromDOMNode(element);
  if (!isLexicalEditor(editor)) throw new Error("expected a Lexical editor root");
  act(() => {
    editor.update(() => {
      $setPromptText(text);
      $getRoot().selectEnd();
    }, { discrete: true });
  });
}
