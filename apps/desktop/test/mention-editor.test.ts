import { describe, it, expect } from "vitest";
import { makeChip, serializeEditor, setEditorText, getCaretContext, replaceRange, applyMarkdownShortcuts } from "../src/renderer/lib/mention-editor.js";

function editor(...nodes: Node[]): HTMLElement {
  const div = document.createElement("div");
  nodes.forEach((n) => div.appendChild(n));
  return div;
}

describe("mention-editor", () => {
  it("serializes text + inline chips to @path interleaved (chip in the middle of text)", () => {
    const div = editor(
      document.createTextNode("이거 "),
      makeChip("/abc/def", "def"),
      document.createTextNode(" 랑 "),
      makeChip("/bcd/efc", "efc"),
      document.createTextNode(" 보고 해줘"),
    );
    expect(serializeEditor(div)).toBe("이거 @/abc/def 랑 @/bcd/efc 보고 해줘");
  });

  it("chip shows filename only but serializes full path; <br>→newline", () => {
    const chip = makeChip("/x/y/z.ts", "z.ts");
    expect(chip.textContent).toBe("z.ts");
    expect(chip.dataset.path).toBe("/x/y/z.ts");
    expect(serializeEditor(editor(document.createTextNode("a"), document.createElement("br"), chip))).toBe("a\n@/x/y/z.ts");
  });

  it("setEditorText replaces all content", () => {
    const div = editor(document.createTextNode("old"), makeChip("/p", "p"));
    setEditorText(div, "/review ");
    expect(serializeEditor(div)).toBe("/review ");
  });
});

// Build a selection collapsed to an offset inside a text node (for testing the @ autocomplete helper).
function caretAt(node: Text, offset: number): void {
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

describe("getCaretContext", () => {
  it("returns the caret's text node, offset, and text-before-caret", () => {
    const div = editor(document.createTextNode("이거 @sr"));
    document.body.appendChild(div); // selection only registers on nodes attached to the document (the real editor is attached too)
    const node = div.firstChild as Text;
    caretAt(node, 6); // caret at the end of the typed mention input
    const ctx = getCaretContext(div);
    expect(ctx?.node).toBe(node);
    expect(ctx?.offset).toBe(6);
    expect(ctx?.textBefore).toBe("이거 @sr");
    div.remove();
  });

  it("returns null when the caret is outside the editor root", () => {
    const div = editor(document.createTextNode("@sr"));
    const other = editor(document.createTextNode("elsewhere"));
    document.body.appendChild(other);
    caretAt(other.firstChild as Text, 3);
    expect(getCaretContext(div)).toBeNull();
    other.remove();
  });
});

describe("replaceRange", () => {
  it("replaces the @token range with a chip + space (file selection)", () => {
    const div = editor(document.createTextNode("이거 @src"));
    const node = div.firstChild as Text;
    replaceRange(node, 3, 7, [makeChip("/abs/x", "x"), document.createTextNode(" ")]); // [3,7)="@src"
    expect(serializeEditor(div)).toBe("이거 @/abs/x ");
  });

  it("replaces the @token with longer text (folder drill-in)", () => {
    const div = editor(document.createTextNode("@src"));
    const node = div.firstChild as Text;
    replaceRange(node, 0, 4, [document.createTextNode("@src/comp/")]);
    expect(serializeEditor(div)).toBe("@src/comp/");
  });
});

describe("applyMarkdownShortcuts (composer markdown shortcuts)", () => {
  it("**X** → <strong>, serialization round-trips back to markdown", () => {
    const t = document.createTextNode("hello **world**");
    const div = editor(t);
    document.body.appendChild(div); // jsdom selection is stable only when the node is in the document
    caretAt(t, t.length);
    expect(applyMarkdownShortcuts(div)).toBe(true);
    expect(div.querySelector("strong")?.textContent).toBe("world"); // bold with markers stripped
    expect(serializeEditor(div)).toBe("hello **world**"); // outgoing text stays as markdown
  });

  it("`X` → <code>, round-trip", () => {
    const t = document.createTextNode("run `ls -la`");
    const div = editor(t);
    document.body.appendChild(div); // jsdom selection is stable only when the node is in the document
    caretAt(t, t.length);
    expect(applyMarkdownShortcuts(div)).toBe(true);
    expect(div.querySelector("code")?.textContent).toBe("ls -la");
    expect(serializeEditor(div)).toBe("run `ls -la`");
  });

  it("line-leading '- ' → bullet marker (• ), serialization restores it to '- '", () => {
    const t = document.createTextNode("- ");
    const div = editor(t);
    document.body.appendChild(div); // jsdom selection is stable only when the node is in the document
    caretAt(t, 2);
    expect(applyMarkdownShortcuts(div)).toBe(true);
    expect(div.querySelector(".md-bullet")).toBeTruthy();
    expect(serializeEditor(div)).toBe("- "); // markdown bullet preserved
  });

  it("does not convert a '- ' in the middle of a line (avoids misreading it as a bullet)", () => {
    const t = document.createTextNode("5 - 3");
    const div = editor(t);
    document.body.appendChild(div); // jsdom selection is stable only when the node is in the document
    caretAt(t, 4); // right after "5 - "
    expect(applyMarkdownShortcuts(div)).toBe(false);
  });

  it("does not convert an unclosed token (**wip)", () => {
    const t = document.createTextNode("hi **wip");
    const div = editor(t);
    document.body.appendChild(div); // jsdom selection is stable only when the node is in the document
    caretAt(t, t.length);
    expect(applyMarkdownShortcuts(div)).toBe(false);
  });
});
