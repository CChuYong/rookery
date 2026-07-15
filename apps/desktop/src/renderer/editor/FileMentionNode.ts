import {
  $applyNodeReplacement,
  type EditorConfig,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
  TextNode,
} from "lexical";

export type SerializedFileMentionNode = Spread<
  {
    path: string;
    name: string;
  },
  SerializedTextNode
>;

/**
 * An inline file chip whose model text matches its displayed filename.
 *
 * This stays a TextNode (instead of a DecoratorNode) so Lexical can keep owning
 * browser selection and IME composition around it. Segmented mode and the text
 * entity boundary make deletion/replacement atomic without a separate DOM editor.
 */
export class FileMentionNode extends TextNode {
  __path: string;
  __name: string;

  static getType(): string {
    return "file-mention";
  }

  static clone(node: FileMentionNode): FileMentionNode {
    return new FileMentionNode(node.__path, node.__name, node.__key);
  }

  static importJSON(serializedNode: SerializedFileMentionNode): FileMentionNode {
    return $createFileMentionNode(
      serializedNode.path,
      serializedNode.name,
    ).updateFromJSON(serializedNode);
  }

  constructor(path: string, name: string, key?: NodeKey) {
    super(name, key);
    this.__path = path;
    this.__name = name;
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedFileMentionNode>): this {
    const self = super.updateFromJSON(serializedNode).getWritable();
    self.__path = serializedNode.path;
    self.__name = serializedNode.name;
    // Lexical selection offsets are derived from getTextContent(), so the
    // model text must stay byte-for-byte aligned with the displayed filename.
    self.__text = serializedNode.name;
    return self.setMode("segmented");
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    element.classList.add("mention-chip");
    element.dataset.path = this.getPath();
    return element;
  }

  updateDOM(
    prevNode: this,
    dom: HTMLElement,
    config: EditorConfig,
  ): boolean {
    dom.dataset.path = this.getPath();
    return super.updateDOM(prevNode, dom, config);
  }

  exportJSON(): SerializedFileMentionNode {
    return {
      ...super.exportJSON(),
      text: this.getName(),
      path: this.getPath(),
      name: this.getName(),
      type: "file-mention",
      version: 1,
    };
  }

  getPath(): string {
    return this.getLatest().__path;
  }

  getName(): string {
    return this.getLatest().__name;
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }
}

export function $createFileMentionNode(path: string, name: string): FileMentionNode {
  return $applyNodeReplacement(new FileMentionNode(path, name)).setMode("segmented");
}

export function $isFileMentionNode(
  node: LexicalNode | null | undefined,
): node is FileMentionNode {
  return node instanceof FileMentionNode;
}
