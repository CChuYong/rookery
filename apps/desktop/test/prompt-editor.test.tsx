import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  getEditorPropertyFromDOMNode,
  isLexicalEditor,
  REDO_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import {
  matchCommands,
  PromptEditor,
  slashQueryOf,
  type PromptEditorHandle,
} from "../src/renderer/components/PromptEditor.js";

const CMDS = [
  { id: "review", name: "review", description: "review code", action: { type: "insert-prompt" as const, text: "$review" } },
  { id: "remember", name: "remember", description: "save memory", action: { type: "insert-prompt" as const, text: "/remember" } },
];

function insert(ref: React.RefObject<PromptEditorHandle | null>, text: string): void {
  act(() => ref.current!.insertText(text));
}

function paste(root: HTMLElement, text: string, html = "<b>ignored</b>"): void {
  fireEvent.paste(root, {
    clipboardData: {
      files: [],
      getData: (type: string) => type === "text/plain" ? text : html,
      types: ["text/plain", "text/html"],
    },
  });
}

describe("slashQueryOf / matchCommands", () => {
  it("extracts slash query at caret token only", () => {
    expect(slashQueryOf("/rev")).toBe("rev");
    expect(slashQueryOf("hi /rem")).toBe("rem");
    expect(slashQueryOf("a/b")).toBeNull();
    expect(slashQueryOf("plain")).toBeNull();
  });

  it("matches by substring, prefix-first", () => {
    expect(matchCommands(CMDS, "re").map((command) => command.name)).toEqual(["review", "remember"]);
    expect(matchCommands(CMDS, "mem").map((command) => command.name)).toEqual(["remember"]);
  });
});

describe("PromptEditor", () => {
  it("seeds initialText and getText returns it", () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} initialText="hello" />);
    expect(ref.current!.getText()).toBe("hello");
    expect(getByRole("textbox")).toHaveTextContent("hello");
  });

  it("publishes serialized changes from Lexical state", async () => {
    const ref = createRef<PromptEditorHandle>();
    const onChange = vi.fn();
    render(<PromptEditor ref={ref} onChange={onChange} />);

    insert(ref, "typed");

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("typed"));
    expect(ref.current!.getText()).toBe("typed");
  });

  it("pastes only text/plain without document.execCommand or clipboard HTML", async () => {
    const ref = createRef<PromptEditorHandle>();
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const { getByRole } = render(<PromptEditor ref={ref} />);
    insert(ref, "before ");

    paste(getByRole("textbox"), "**pasted**", "<strong>HTML</strong>");

    await waitFor(() => expect(ref.current!.getText()).toBe("before **pasted**"));
    expect(execCommand).not.toHaveBeenCalled();
    expect(getByRole("textbox")).not.toHaveTextContent("HTML");
    expect(getByRole("textbox").querySelector("strong")).toBeNull();
  });

  it("keeps paste as its own undo item, then accepts fresh Korean text", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} />);
    const editor = getByRole("textbox");
    insert(ref, "하이 ");
    paste(editor, "붙임");
    await waitFor(() => expect(ref.current!.getText()).toBe("하이 붙임"));

    fireEvent.keyDown(editor, { key: "z", code: "KeyZ", ctrlKey: true });
    await waitFor(() => expect(ref.current!.getText()).toBe("하이 "));

    insert(ref, "안녕");
    await waitFor(() => expect(ref.current!.getText()).toBe("하이 안녕"));
  });

  it("opens the slash popup and replaces only the active token", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { findByText } = render(<PromptEditor ref={ref} commands={CMDS} />);
    insert(ref, "hi /rev");

    fireEvent.click(await findByText("/review"));

    await waitFor(() => expect(ref.current!.getText()).toBe("hi $review "));
  });

  it("executes a zero-argument client action instead of inserting it", async () => {
    const ref = createRef<PromptEditorHandle>();
    const onCommandAction = vi.fn();
    const action = {
      type: "open-capability-center" as const,
      tab: "effective" as const,
      kind: "skill" as const,
    };
    const commands = [{
      id: "skills",
      name: "skills",
      description: "open skills",
      action,
    }];
    const { findByText } = render(
      <PromptEditor ref={ref} commands={commands} onCommandAction={onCommandAction} />,
    );
    insert(ref, "/ski");

    fireEvent.click(await findByText("/skills"));

    await waitFor(() => expect(onCommandAction).toHaveBeenCalledWith(action));
    expect(ref.current!.getText()).toBe("");
  });

  it("replaces an @ query with a serialized inline file chip", async () => {
    const ref = createRef<PromptEditorHandle>();
    const browseDir = vi.fn(async () => ({
      dir: "/repo",
      entries: [{ name: "src.ts", isDir: false }],
    }));
    const { findByText, getByRole } = render(
      <PromptEditor ref={ref} browseDir={browseDir} />,
    );
    insert(ref, "check @sr");

    fireEvent.mouseDown(await findByText("src.ts"));

    await waitFor(() => expect(ref.current!.getText()).toBe("check @/repo/src.ts "));
    expect(getByRole("textbox").querySelector(".mention-chip")).toHaveTextContent("src.ts");
  });

  it("inserts semantic file chips through the imperative bridge", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} />);
    act(() => ref.current!.insertFiles([
      { path: "/repo/a.ts", name: "a.ts" },
      { path: "/repo/b.ts", name: "b.ts" },
    ]));

    await waitFor(() => expect(ref.current!.getText()).toBe("@/repo/a.ts @/repo/b.ts "));
    expect(getByRole("textbox").querySelectorAll(".mention-chip")).toHaveLength(2);
  });

  it("undoes and redoes semantic file insertion as one history item", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} />);
    const editor = getByRole("textbox");
    act(() => ref.current!.insertFiles([{ path: "/repo/a.ts", name: "a.ts" }]));
    await waitFor(() => expect(ref.current!.getText()).toBe("@/repo/a.ts "));
    const lexicalEditor = getEditorPropertyFromDOMNode(editor);
    if (!isLexicalEditor(lexicalEditor)) throw new Error("expected Lexical editor");

    act(() => lexicalEditor.dispatchCommand(UNDO_COMMAND, undefined));
    await waitFor(() => expect(ref.current!.getText()).toBe(""));
    act(() => lexicalEditor.dispatchCommand(REDO_COMMAND, undefined));

    await waitFor(() => expect(ref.current!.getText()).toBe("@/repo/a.ts "));
  });

  it("applies the supported bold and list Markdown shortcuts", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} />);
    const editor = getByRole("textbox");
    insert(ref, "hello **world*");
    insert(ref, "*");
    await waitFor(() => expect(editor.querySelector("strong")).toHaveTextContent("world"));
    expect(ref.current!.getText()).toBe("hello **world**");

    act(() => ref.current!.clear());
    insert(ref, "-");
    insert(ref, " ");
    insert(ref, "item");
    await waitFor(() => expect(editor.querySelector("ul")).toHaveTextContent("item"));
    expect(ref.current!.getText()).toBe("- item");
  });

  it("without onSubmit, Enter inserts a new paragraph", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} />);
    insert(ref, "line");
    fireEvent.keyDown(getByRole("textbox"), { key: "Enter" });
    insert(ref, "two");
    await waitFor(() => expect(ref.current!.getText()).toBe("line\ntwo"));
  });

  it("with onSubmit, plain Enter submits", () => {
    const ref = createRef<PromptEditorHandle>();
    const onSubmit = vi.fn();
    const { getByRole } = render(<PromptEditor ref={ref} onSubmit={onSubmit} />);
    insert(ref, "msg");

    fireEvent.keyDown(getByRole("textbox"), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("Shift+Enter inserts a line break and never submits", async () => {
    const ref = createRef<PromptEditorHandle>();
    const onSubmit = vi.fn();
    const { getByRole } = render(<PromptEditor ref={ref} onSubmit={onSubmit} />);
    insert(ref, "msg");

    fireEvent.keyDown(getByRole("textbox"), { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(ref.current!.getText()).toBe("msg\n"));
  });

  it("does not submit an IME composition-commit Enter", () => {
    const ref = createRef<PromptEditorHandle>();
    const onSubmit = vi.fn();
    const { getByRole } = render(<PromptEditor ref={ref} onSubmit={onSubmit} />);
    insert(ref, "안녕");

    fireEvent.keyDown(getByRole("textbox"), { key: "Enter", isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(ref.current!.getText()).toBe("안녕");
  });

  it("clear empties editor state and its rendered content", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} initialText="x" />);

    act(() => ref.current!.clear());

    await waitFor(() => expect(ref.current!.getText()).toBe(""));
    expect(getByRole("textbox")).not.toHaveTextContent("x");
  });

  it("starts a fresh undo history after clear", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { getByRole } = render(<PromptEditor ref={ref} initialText="sent draft" />);
    const root = getByRole("textbox");
    const lexicalEditor = getEditorPropertyFromDOMNode(root);
    if (!isLexicalEditor(lexicalEditor)) throw new Error("expected Lexical editor");
    act(() => ref.current!.clear());
    insert(ref, "fresh");
    await waitFor(() => expect(ref.current!.getText()).toBe("fresh"));

    act(() => lexicalEditor.dispatchCommand(UNDO_COMMAND, undefined));

    await waitFor(() => expect(ref.current!.getText()).toBe(""));
    expect(ref.current!.getText()).not.toContain("sent draft");
  });
});
