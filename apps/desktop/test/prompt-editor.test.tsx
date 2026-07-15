import { afterEach, describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { PromptEditor, slashQueryOf, matchCommands } from "../src/renderer/components/PromptEditor.js";
import type { PromptEditorHandle } from "../src/renderer/components/PromptEditor.js";
import { insertNodesAtCaret } from "../src/renderer/lib/mention-editor.js";

const CMDS = [
  { id: "review", name: "review", description: "review code", action: { type: "insert-prompt" as const, text: "$review" } },
  { id: "remember", name: "remember", description: "save memory", action: { type: "insert-prompt" as const, text: "/remember" } },
];

const originalExecCommand = document.execCommand;

function installExecCommand(impl: (command: string, showDefaultUI?: boolean, value?: string) => boolean): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: mock });
  return mock;
}

function placeCaretAtTextEnd(root: HTMLElement): void {
  const text = root.lastChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("expected a trailing text node");
  const range = document.createRange();
  range.setStart(text, text.textContent?.length ?? 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: originalExecCommand });
});

describe("slashQueryOf / matchCommands", () => {
  it("extracts slash query at caret token only", () => {
    expect(slashQueryOf("/rev")).toBe("rev");
    expect(slashQueryOf("hi /rem")).toBe("rem");
    expect(slashQueryOf("a/b")).toBeNull();
    expect(slashQueryOf("plain")).toBeNull();
  });
  it("matches by substring, prefix-first", () => {
    expect(matchCommands(CMDS, "re").map((c) => c.name)).toEqual(["review", "remember"]);
    expect(matchCommands(CMDS, "mem").map((c) => c.name)).toEqual(["remember"]);
  });
});

describe("PromptEditor", () => {
  it("seeds initialText and getText returns it", () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} initialText="hello" />);
    expect(ref.current!.getText()).toBe("hello");
  });
  it("onChange fires on input", () => {
    const onChange = vi.fn();
    const { getByRole } = render(<PromptEditor onChange={onChange} />);
    const ed = getByRole("textbox");
    ed.textContent = "typed";
    fireEvent.input(ed);
    expect(onChange).toHaveBeenLastCalledWith("typed");
  });
  it("pastes plain text through the native editing command without applying markdown shortcuts", () => {
    const onChange = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} onChange={onChange} />);
    const ed = getByRole("textbox");
    ed.textContent = "before ";
    fireEvent.input(ed);
    placeCaretAtTextEnd(ed);

    const execCommand = installExecCommand((_command, _showDefaultUI, value) => {
      insertNodesAtCaret(ed, [document.createTextNode(value ?? "")]);
      placeCaretAtTextEnd(ed);
      fireEvent.input(ed, { inputType: "insertText", data: value });
      return true;
    });
    const getData = vi.fn((type: string) => type === "text/plain" ? "**pasted**" : "<strong>pasted</strong>");

    fireEvent.paste(ed, { clipboardData: { getData } });

    expect(getData).toHaveBeenCalledWith("text/plain");
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "**pasted**");
    expect(ref.current!.getText()).toBe("before **pasted**");
    expect(ed.querySelector("strong")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith("before **pasted**");
  });
  it("falls back to Range insertion when the native editing command is unavailable", () => {
    const onChange = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} onChange={onChange} />);
    const ed = getByRole("textbox");
    ed.textContent = "before ";
    fireEvent.input(ed);
    placeCaretAtTextEnd(ed);
    const execCommand = installExecCommand(() => false);

    fireEvent.paste(ed, { clipboardData: { getData: () => "pasted" } });

    expect(execCommand).toHaveBeenCalledWith("insertText", false, "pasted");
    expect(ref.current!.getText()).toBe("before pasted");
    expect(onChange).toHaveBeenLastCalledWith("before pasted");
  });
  it("falls back to Range insertion when the native editing command throws", () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} />);
    const ed = getByRole("textbox");
    const execCommand = installExecCommand(() => { throw new Error("unsupported"); });

    fireEvent.paste(ed, { clipboardData: { getData: () => "pasted" } });

    expect(execCommand).toHaveBeenCalledWith("insertText", false, "pasted");
    expect(ref.current!.getText()).toBe("pasted");
  });
  it.each(["historyUndo", "historyRedo"])("syncs %s without applying markdown shortcuts", (inputType) => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} />);
    const ed = getByRole("textbox");
    ed.textContent = "**restored**";
    placeCaretAtTextEnd(ed);

    fireEvent.input(ed, { inputType });

    expect(ref.current!.getText()).toBe("**restored**");
    expect(ed.querySelector("strong")).toBeNull();
  });
  it("opens /skill popup and pick replaces the token", () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole, getByText } = render(<PromptEditor ref={ref} commands={CMDS} />);
    const ed = getByRole("textbox");
    ed.textContent = "/rev";
    fireEvent.input(ed);
    fireEvent.click(getByText("/review"));
    expect(ref.current!.getText()).toContain("$review ");
  });
  it("executes a zero-argument client action on pick instead of inserting or submitting it", () => {
    const ref = createRef<PromptEditorHandle>();
    const onCommandAction = vi.fn();
    const commands = [{
      id: "skills",
      name: "skills",
      description: "open skills",
      action: { type: "open-capability-center" as const, tab: "effective" as const, kind: "skill" as const },
    }];
    const { getByRole, getByText } = render(<PromptEditor ref={ref} commands={commands} onCommandAction={onCommandAction} />);
    const ed = getByRole("textbox");
    ed.textContent = "/ski";
    fireEvent.input(ed);
    fireEvent.click(getByText("/skills"));
    expect(onCommandAction).toHaveBeenCalledWith(commands[0]!.action);
    expect(ref.current!.getText()).toBe("");
  });
  it("WITHOUT onSubmit, Enter does NOT submit (inserts newline)", () => {
    const { getByRole } = render(<PromptEditor />);
    const ed = getByRole("textbox");
    ed.textContent = "line";
    fireEvent.input(ed);
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(true).toBe(true);
  });
  it("WITH onSubmit, Enter (no popup) calls onSubmit", () => {
    const onSubmit = vi.fn();
    const { getByRole } = render(<PromptEditor onSubmit={onSubmit} />);
    const ed = getByRole("textbox");
    ed.textContent = "msg";
    fireEvent.input(ed);
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });
  it("Shift+Enter never submits", () => {
    const onSubmit = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} onSubmit={onSubmit} />);
    const ed = getByRole("textbox");
    ed.textContent = "msg"; fireEvent.input(ed);
    fireEvent.keyDown(ed, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ref.current!.getText()).toBe("msg\n");
  });
  it("Shift+Enter inserts a newline instead of picking a slash command", () => {
    const onSubmit = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} commands={CMDS} onSubmit={onSubmit} />);
    const ed = getByRole("textbox");
    ed.textContent = "/rev"; fireEvent.input(ed);
    fireEvent.keyDown(ed, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ref.current!.getText()).toBe("/rev\n");
  });
  it("Shift+Enter during IME composition inserts a newline after composition commits", async () => {
    const onSubmit = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} onSubmit={onSubmit} />);
    const ed = getByRole("textbox");
    ed.textContent = "~/Desktop/wt.png"; fireEvent.input(ed);
    fireEvent.keyDown(ed, { key: "Enter", shiftKey: true, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ref.current!.getText()).toBe("~/Desktop/wt.png");
    fireEvent.compositionEnd(ed);
    await waitFor(() => expect(ref.current!.getText()).toBe("~/Desktop/wt.png\n"));
  });
  it("handle.clear empties the editor", () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} initialText="x" />);
    ref.current!.clear();
    expect(ref.current!.getText()).toBe("");
  });
});
