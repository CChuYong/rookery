import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MessageList } from "../src/renderer/components/MessageList.js";

const msg = (content: string, role: "user" | "assistant") => ({ kind: "message", role, content }) as never;

// Audit #30/#31: an optimistic message renders inside the transcript as the last row, at the confirmed bubble's size;
// only its edge, opacity and badge say it is not confirmed yet. "Queued" only while a turn is running.
describe("MessageList pending bubbles", () => {
  it("renders pending messages inside the scrolling log, after the committed rows", () => {
    render(<MessageList items={[msg("answer", "assistant")]} pending={[{ clientMsgId: "c1", text: "next please" }]} />);
    const log = screen.getByRole("log");
    expect(within(log).getByText("next please")).toBeInTheDocument();
    const rows = Array.from(log.firstElementChild!.children);
    expect(rows.at(-1)!.textContent).toContain("next please");
  });

  it("uses the confirmed bubble's text size and says Sending… while idle", () => {
    render(<MessageList items={[msg("confirmed", "user")]} pending={[{ clientMsgId: "c1", text: "on its way" }]} />);
    const confirmed = screen.getByText("confirmed").closest("div.self-end")!;
    const pending = screen.getByText("on its way").closest("div.self-end")!;
    expect(pending.className).toContain("text-prose");
    expect(confirmed.className).toContain("text-prose");
    expect(within(pending as HTMLElement).getByText("보내는 중…")).toBeInTheDocument();
    expect(screen.queryByText("전송 대기")).toBeNull();
  });

  it("says Queued while a turn is running", () => {
    render(<MessageList items={[msg("x", "assistant")]} pending={[{ clientMsgId: "c1", text: "after this" }]} pendingQueued />);
    expect(screen.getByText("전송 대기")).toBeInTheDocument();
  });

  it("shows the pending first message of a fresh conversation instead of the empty hint", () => {
    render(<MessageList items={[]} pending={[{ clientMsgId: "c1", text: "first words" }]} />);
    expect(screen.getByText("first words")).toBeInTheDocument();
    expect(screen.queryByText(/대화를 시작하세요/)).toBeNull();
  });

  it("a failed input uses the same bubble size and the text-only failure copy", () => {
    render(<MessageList items={[{ kind: "failedInput", text: "lost words" } as never]} />);
    const bubble = screen.getByText("lost words").closest("div.self-end")!;
    expect(bubble.className).toContain("text-prose");
    expect(screen.getByText(/보내지 못했어요/)).toBeInTheDocument();
  });
});
