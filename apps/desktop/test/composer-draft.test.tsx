import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CommandAction } from "@daemon/core/capabilities/commands.js";
import { Composer, matchCommandAction } from "../src/renderer/components/Composer.js";
import { setPromptEditorText } from "./prompt-editor-helpers.js";

const SIDE_COMMANDS = [
  { id: "btw", name: "btw", description: "side", argumentHint: "<question>", action: { type: "open-panel" as const, panel: "btw" as const } },
  { id: "side", name: "side", description: "side", argumentHint: "<question>", action: { type: "open-panel" as const, panel: "side" as const } },
];

describe("matchCommandAction", () => {
  it("matches registry names and aliases only as a leading whole command", () => {
    expect(matchCommandAction("/btw why?", SIDE_COMMANDS)).toEqual({ candidate: SIDE_COMMANDS[0], argument: "why?" });
    expect(matchCommandAction(" /side explain this ", SIDE_COMMANDS)).toEqual({ candidate: SIDE_COMMANDS[1], argument: "explain this" });
    expect(matchCommandAction("/sideways hello", SIDE_COMMANDS)).toBeNull();
    expect(matchCommandAction("hello /btw why", SIDE_COMMANDS)).toBeNull();
  });
});

describe("Composer draft persistence (initialText / onDraftChange)", () => {
  it("seeds the editor from initialText on mount", () => {
    render(<Composer onSend={() => {}} initialText="restored draft" />);
    const ed = screen.getByRole("textbox");
    expect(ed.textContent).toBe("restored draft");
  });

  it("does not fire onDraftChange just for mounting (no spurious write)", () => {
    const onDraftChange = vi.fn();
    render(<Composer onSend={() => {}} initialText="restored draft" onDraftChange={onDraftChange} />);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("calls onDraftChange with the serialized text as the user types", () => {
    const onDraftChange = vi.fn();
    render(<Composer onSend={() => {}} onDraftChange={onDraftChange} />);
    const ed = screen.getByRole("textbox");
    setPromptEditorText(ed, "hello");
    expect(onDraftChange).toHaveBeenLastCalledWith("hello");
  });

  it("clears the draft on submit (onDraftChange called with empty string)", () => {
    const onSend = vi.fn();
    const onDraftChange = vi.fn();
    render(<Composer onSend={onSend} onDraftChange={onDraftChange} />);
    const ed = screen.getByRole("textbox");
    setPromptEditorText(ed, "send me");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("send me");
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("redirects the current draft to a Side question and clears it", () => {
    const onSend = vi.fn();
    const onSideSend = vi.fn();
    render(<Composer onSend={onSend} onSideSend={onSideSend} />);
    const ed = screen.getByRole("textbox");
    setPromptEditorText(ed, "why this approach?");
    fireEvent.click(screen.getByRole("button", { name: "별도로 질문하기" }));
    expect(onSideSend).toHaveBeenCalledWith("why this approach?");
    expect(onSend).not.toHaveBeenCalled();
    expect(ed.textContent).toBe("");
  });

  it("routes /btw and /side submissions to Side without sending the command token", () => {
    const onSend = vi.fn();
    const onSideSend = vi.fn();
    const onCommandAction = (action: CommandAction, argument?: string) => {
      if (action.type === "open-panel" && argument) onSideSend(argument);
    };
    const { unmount } = render(<Composer onSend={onSend} commands={SIDE_COMMANDS} onCommandAction={onCommandAction} />);
    let ed = screen.getByRole("textbox");
    setPromptEditorText(ed, "/btw why this approach?");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSideSend).toHaveBeenLastCalledWith("why this approach?");
    expect(onSend).not.toHaveBeenCalled();
    expect(ed.textContent).toBe("");
    unmount();

    render(<Composer onSend={onSend} commands={SIDE_COMMANDS} onCommandAction={onCommandAction} />);
    ed = screen.getByRole("textbox");
    setPromptEditorText(ed, "/side explain this");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSideSend).toHaveBeenLastCalledWith("explain this");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps a command-only draft so the user can add a question", () => {
    const onSend = vi.fn();
    const onCommandAction = vi.fn();
    render(<Composer onSend={onSend} commands={SIDE_COMMANDS} onCommandAction={onCommandAction} />);
    const ed = screen.getByRole("textbox");
    setPromptEditorText(ed, "/side ");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onCommandAction).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(ed.textContent).toBe("/side ");
  });

  it("executes a typed Capability Center action and never sends it as a prompt", () => {
    const onSend = vi.fn();
    const onCommandAction = vi.fn();
    const action = { type: "open-capability-center" as const, tab: "effective" as const, kind: "mcp" as const };
    render(<Composer onSend={onSend} onCommandAction={onCommandAction} commands={[{ id: "mcp", name: "mcp", description: "open", action }]} />);
    const ed = screen.getByRole("textbox");
    setPromptEditorText(ed, "/mcp");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onCommandAction).toHaveBeenCalledWith(action);
    expect(onSend).not.toHaveBeenCalled();
    expect(ed.textContent).toBe("");
  });

  it("continues to send unknown manual slash text as an ordinary prompt", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} commands={SIDE_COMMANDS} onCommandAction={() => {}} />);
    const ed = screen.getByRole("textbox");
    setPromptEditorText(ed, "/not-registered keep this");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/not-registered keep this");
  });
});
