// Pure DOM helpers for contenteditable-based mention input. Chips (file attachments) are embedded as
// non-editable inline spans, and on send we walk text nodes + chips to serialize them as "@path". This
// enables "inline chips in the middle of text", which is impossible with a textarea.

// Create a file-attachment chip node. data-path holds the absolute path; the display text is just the file name.
export function makeChip(path: string, name: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.dataset.path = path;
  chip.contentEditable = "false";
  chip.className = "mention-chip";
  chip.textContent = name;
  return chip;
}

// Editor DOM → send text. Text nodes stay as-is, chips become "@path", and markdown shortcut elements are
// reverted to their original markdown (bullet data-md, **bold**=strong, `code`=code) → send text is always
// markdown (round-trip invariant, regardless of the visual transform).
export function serializeEditor(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { out += (node.textContent ?? "").replace(/​/g, ""); return; } // strip ZWSP (inline escape)
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.path) { out += `@${el.dataset.path}`; return; } // mention chip
    if (el.dataset.md) { out += el.dataset.md; return; } // bullets etc. — data-md holds the original markdown ("- ")
    if (el.tagName === "STRONG") { out += `**${el.textContent ?? ""}**`; return; }
    if (el.tagName === "CODE") { out += `\`${el.textContent ?? ""}\``; return; }
    if (el.tagName === "BR") { out += "\n"; return; }
    for (const c of Array.from(el.childNodes)) walk(c);
  };
  for (const c of Array.from(root.childNodes)) walk(c);
  return out;
}

// Insert nodes at the current caret (when inside the editor), or at the end otherwise, and move the caret after them.
export function insertNodesAtCaret(root: HTMLElement, nodes: Node[]): void {
  if (nodes.length === 0) return;
  const sel = window.getSelection();
  let range: Range;
  if (sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    range = sel.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false); // end
  }
  const frag = document.createDocumentFragment();
  for (const n of nodes) frag.appendChild(n);
  const last = nodes[nodes.length - 1];
  range.insertNode(frag);
  range.setStartAfter(last);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// If the current caret is collapsed onto a text node inside root, return {node, offset, text before caret} (for @ autocomplete detection).
// textBefore = node.textContent.slice(0, offset) → activeMentionQuery's start index lines up exactly with this node's offset.
export function getCaretContext(root: HTMLElement): { node: Text; offset: number; textBefore: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  const text = node as Text;
  const offset = range.startOffset;
  return { node: text, offset, textBefore: (text.textContent ?? "").slice(0, offset) };
}

// Replace only the [start,end) range of a single text node with nodes and place the caret after them (@token → chip or drill-in text).
export function replaceRange(node: Text, start: number, end: number, nodes: Node[]): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  range.deleteContents();
  const frag = document.createDocumentFragment();
  for (const n of nodes) frag.appendChild(n);
  const last = nodes[nodes.length - 1];
  range.insertNode(frag);
  // Move the caret after the last inserted node. If it's a text node, place it at the end inside it so getCaretContext can read the caret and re-detect (re-list after drill-in).
  if (last) {
    if (last.nodeType === Node.TEXT_NODE) range.setStart(last, (last as Text).length);
    else range.setStartAfter(last);
    range.collapse(true);
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// Line-leading bullet marker ("- "/"* " → "• "). A contenteditable=false unit (deleted whole by backspace), preserving the markdown via data-md.
export function makeBullet(): HTMLSpanElement {
  const b = document.createElement("span");
  b.className = "md-bullet";
  b.contentEditable = "false";
  b.dataset.md = "- "; // restored to markdown on serialization
  b.textContent = "• ";
  return b;
}

// Inline markdown transform rules: a completed token becomes a style element (markers removed). Serialization round-trips tag → markdown.
const INLINE_RULES: Array<{ re: RegExp; tag: "strong" | "code"; cls?: string }> = [
  { re: /\*\*([^*\n]+)\*\*$/, tag: "strong" }, // **bold**
  { re: /`([^`\n]+)`$/, tag: "code", cls: "md-code" }, // `code`
];

// If there's a completed inline token (**X**/`X`) or a line-leading bullet ("- "/"* ") right before the caret, convert it
// into a style element and move the caret after it. Returns true if converted. Serialization-invariant (send text = markdown), so it doesn't affect slash/mention detection.
export function applyMarkdownShortcuts(root: HTMLElement): boolean {
  const ctx = getCaretContext(root);
  if (!ctx) return false;
  const { node, offset, textBefore } = ctx;
  for (const rule of INLINE_RULES) {
    const m = rule.re.exec(textBefore);
    if (m) {
      const elx = document.createElement(rule.tag);
      elx.textContent = m[1]!;
      if (rule.cls) elx.className = rule.cls;
      replaceRange(node, offset - m[0].length, offset, [elx, document.createTextNode("​")]);
      return true; // trailing zero-width text node → caret lands outside the style element so further typing isn't bolded
    }
  }
  const bm = /(?:^|\n)[-*] $/.exec(textBefore); // line-leading "- " / "* "
  if (bm) {
    replaceRange(node, offset - 2, offset, [makeBullet()]);
    return true;
  }
  return false;
}

// Replace the entire editor text with the given string and place the caret at the end (slash command selection, etc.).
export function setEditorText(root: HTMLElement, text: string): void {
  root.textContent = text;
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
}
