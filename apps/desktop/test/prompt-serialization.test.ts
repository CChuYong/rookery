import { describe, expect, it } from "vitest";
import { ListItemNode, ListNode } from "@lexical/list";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
} from "lexical";
import {
  $createFileMentionNode,
  FileMentionNode,
} from "../src/renderer/editor/FileMentionNode.js";
import {
  $serializePrompt,
  PROMPT_TRANSFORMERS,
} from "../src/renderer/editor/prompt-serialization.js";
import { $convertFromMarkdownString } from "@lexical/markdown";

function makeEditor() {
  return createEditor({
    namespace: "prompt-serialization-test",
    nodes: [FileMentionNode, ListNode, ListItemNode],
    onError: (error) => { throw error; },
  });
}

describe("FileMentionNode", () => {
  it("keeps selection text aligned to the rendered filename", () => {
    const editor = makeEditor();
    let fileNode: FileMentionNode | null = null;

    editor.update(() => {
      const paragraph = $createParagraphNode();
      fileNode = $createFileMentionNode("/repo/src/a.ts", "a.ts");
      paragraph.append(fileNode);
      $getRoot().append(paragraph);
    }, { discrete: true });

    editor.getEditorState().read(() => {
      expect(fileNode!.getPath()).toBe("/repo/src/a.ts");
      expect(fileNode!.getName()).toBe("a.ts");
      expect(fileNode!.getTextContent()).toBe("a.ts");
      expect(fileNode!.getMode()).toBe("segmented");
    });
  });

  it("round-trips its path and display name through editor JSON", () => {
    const editor = makeEditor();
    editor.update(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createFileMentionNode("/repo/src/a.ts", "a.ts"),
        ),
      );
    }, { discrete: true });

    const restored = makeEditor();
    restored.setEditorState(restored.parseEditorState(editor.getEditorState().toJSON()));

    restored.getEditorState().read(() => {
      const node = $getRoot().getFirstDescendant();
      expect(node).toBeInstanceOf(FileMentionNode);
      expect((node as FileMentionNode).getPath()).toBe("/repo/src/a.ts");
      expect((node as FileMentionNode).getName()).toBe("a.ts");
    });
  });

});

describe("prompt serialization", () => {
  it("serializes interleaved text, file chips, and explicit line breaks", () => {
    const editor = makeEditor();
    editor.update(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode("이거 "),
          $createFileMentionNode("/repo/src/a.ts", "a.ts"),
          $createTextNode(" 보고"),
          $createLineBreakNode(),
          $createTextNode("다음 줄"),
        ),
      );
    }, { discrete: true });

    expect(editor.getEditorState().read($serializePrompt)).toBe(
      "이거 @/repo/src/a.ts 보고\n다음 줄",
    );
  });

  it("round-trips the supported bold, inline-code, and unordered-list markdown", () => {
    const editor = makeEditor();
    editor.update(() => {
      $convertFromMarkdownString(
        "hello **world**\nrun `ls -la`\n- item",
        PROMPT_TRANSFORMERS,
        undefined,
        true,
      );
    }, { discrete: true });

    expect(editor.getEditorState().read($serializePrompt)).toBe(
      "hello **world**\nrun `ls -la`\n- item",
    );
  });
});
