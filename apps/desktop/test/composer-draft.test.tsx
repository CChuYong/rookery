import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/renderer/components/Composer.js";

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
    ed.textContent = "hello";
    fireEvent.input(ed);
    expect(onDraftChange).toHaveBeenLastCalledWith("hello");
  });

  it("clears the draft on submit (onDraftChange called with empty string)", () => {
    const onSend = vi.fn();
    const onDraftChange = vi.fn();
    render(<Composer onSend={onSend} onDraftChange={onDraftChange} />);
    const ed = screen.getByRole("textbox");
    ed.textContent = "send me";
    fireEvent.input(ed);
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("send me");
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("redirects the current draft to a Side question and clears it", () => {
    const onSend = vi.fn();
    const onSideSend = vi.fn();
    render(<Composer onSend={onSend} onSideSend={onSideSend} />);
    const ed = screen.getByRole("textbox");
    ed.textContent = "why this approach?";
    fireEvent.input(ed);
    fireEvent.click(screen.getByRole("button", { name: "별도로 질문하기" }));
    expect(onSideSend).toHaveBeenCalledWith("why this approach?");
    expect(onSend).not.toHaveBeenCalled();
    expect(ed.textContent).toBe("");
  });
});
