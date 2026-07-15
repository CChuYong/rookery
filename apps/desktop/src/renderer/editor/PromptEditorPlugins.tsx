import { $insertDataTransferForPlainText } from "@lexical/clipboard";
import type { HistoryState } from "@lexical/history";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  PASTE_TAG,
} from "lexical";

export function EditablePlugin({ editable }: { editable: boolean }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(editable), [editor, editable]);
  return null;
}

export function FocusPlugin({ autoFocus }: { autoFocus: boolean }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (autoFocus) editor.focus();
  }, [autoFocus, editor]);
  return null;
}

/** Establish the initialized editor as the undo baseline after HistoryPlugin registers. */
export function HistoryBaselinePlugin({ historyState }: { historyState: HistoryState }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (historyState.current == null) {
      historyState.current = { editor, editorState: editor.getEditorState() };
    }
  }, [editor, historyState]);
  return null;
}

/** Plain text only, with a Lexical-owned history boundary around each paste. */
export function PlainTextPastePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      const clipboardData = "clipboardData" in event ? event.clipboardData : null;
      if (clipboardData == null) return false;
      event.preventDefault();
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          $insertDataTransferForPlainText(clipboardData, selection);
        }
      }, { tag: PASTE_TAG });
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  ), [editor]);

  return null;
}
