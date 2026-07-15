import {
  $convertFromMarkdownString,
  BOLD_STAR,
  INLINE_CODE,
  type Transformer,
  UNORDERED_LIST,
} from "@lexical/markdown";
import { $isListItemNode, $isListNode } from "@lexical/list";
import {
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type LexicalNode,
} from "lexical";
import { $isFileMentionNode } from "./FileMentionNode.js";

/** The visual Markdown behavior supported by the old prompt editor. */
export const PROMPT_TRANSFORMERS: Transformer[] = [
  UNORDERED_LIST,
  BOLD_STAR,
  INLINE_CODE,
];

/** Must be called inside an editor-state read transaction. */
export function $serializePrompt(): string {
  return $getRoot().getChildren().map($serializeNode).join("\n");
}

function $serializeNode(node: LexicalNode): string {
  if ($isFileMentionNode(node)) return `@${node.getPath()}`;
  if ($isLineBreakNode(node)) return "\n";
  if ($isTextNode(node)) {
    let text = node.getTextContent();
    if (node.hasFormat("code")) text = `\`${text}\``;
    if (node.hasFormat("bold")) text = `**${text}**`;
    return text;
  }
  if ($isListNode(node)) {
    return node.getChildren().map((child) => `- ${$serializeNode(child)}`).join("\n");
  }
  if ($isListItemNode(node) || $isElementNode(node)) {
    return node.getChildren().map($serializeNode).join("");
  }
  return node.getTextContent();
}

/** Must be called inside an editor update transaction. */
export function $setPromptText(text: string): void {
  $convertFromMarkdownString(
    text,
    PROMPT_TRANSFORMERS,
    undefined,
    true,
  );
}
