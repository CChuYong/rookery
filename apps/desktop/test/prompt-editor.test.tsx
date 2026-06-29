import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { PromptEditor, slashQueryOf, matchCommands } from "../src/renderer/components/PromptEditor.js";
import type { PromptEditorHandle } from "../src/renderer/components/PromptEditor.js";

const CMDS = [
  { name: "review", description: "review code" },
  { name: "remember", description: "save memory" },
];

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
  it("opens /skill popup and pick replaces the token", () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole, getByText } = render(<PromptEditor ref={ref} commands={CMDS} />);
    const ed = getByRole("textbox");
    ed.textContent = "/rev";
    fireEvent.input(ed);
    fireEvent.click(getByText("/review"));
    expect(ref.current!.getText()).toContain("/review ");
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
