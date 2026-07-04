import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InteractionCard } from "../src/renderer/components/InteractionCard.js";
import type { LogItem } from "../src/renderer/store/reduce.js";

type Item = Extract<LogItem, { kind: "interaction" }>;

describe("InteractionCard", () => {
  it("approve: clicking Approve calls onRespond with decision=allow", () => {
    const onRespond = vi.fn();
    const item: Item = { kind: "interaction", requestId: "R1", mode: "approve", toolName: "mcp__fleet__spawn_worker", resolved: false };
    render(<InteractionCard item={item} onRespond={onRespond} />);
    fireEvent.click(screen.getByText("승인"));
    expect(onRespond).toHaveBeenCalledWith("R1", { decision: "allow" });
  });

  it("approve: clicking Deny calls onRespond with decision=deny", () => {
    const onRespond = vi.fn();
    const item: Item = { kind: "interaction", requestId: "R2", mode: "approve", resolved: false };
    render(<InteractionCard item={item} onRespond={onRespond} />);
    fireEvent.click(screen.getByText("거부"));
    expect(onRespond).toHaveBeenCalledWith("R2", { decision: "deny" });
  });

  it("ask: submit is disabled until every question is answered, then returns answers", () => {
    const onRespond = vi.fn();
    const item: Item = {
      kind: "interaction", requestId: "R3", mode: "ask", resolved: false,
      questions: [
        { question: "Format?", header: "Fmt", options: [{ label: "Summary" }, { label: "Detailed" }] },
        { question: "Lang?", header: "Lang", options: [{ label: "KO" }, { label: "EN" }] },
      ],
    };
    render(<InteractionCard item={item} onRespond={onRespond} />);
    const submit = screen.getByText("제출");
    expect(submit).toBeDisabled(); // nothing selected yet
    fireEvent.click(screen.getByText("Summary"));
    expect(submit).toBeDisabled(); // only one question answered
    fireEvent.click(screen.getByText("EN"));
    expect(submit).not.toBeDisabled(); // all answered
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenCalledWith("R3", { answers: { "Format?": "Summary", "Lang?": "EN" } });
  });

  it("ask: Skip is enabled with no options selected, calls onRespond with empty answers, and locks the card", () => {
    const onRespond = vi.fn();
    const item: Item = {
      kind: "interaction", requestId: "R7", mode: "ask", resolved: false,
      questions: [
        { question: "Format?", header: "Fmt", options: [{ label: "Summary" }, { label: "Detailed" }] },
        { question: "Lang?", header: "Lang", options: [{ label: "KO" }, { label: "EN" }] },
      ],
    };
    render(<InteractionCard item={item} onRespond={onRespond} />);
    const submit = screen.getByText("제출");
    const skip = screen.getByText("건너뛰기").closest("button")!;
    expect(submit).toBeDisabled(); // nothing selected
    expect(skip).not.toBeDisabled(); // Skip is never gated on allAnswered
    fireEvent.click(skip);
    expect(onRespond).toHaveBeenCalledWith("R7", { answers: {} });
    expect(skip).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(screen.getByText("응답 전송 중…")).toBeInTheDocument();
    // Clicking again while sent must not fire a second respond.
    fireEvent.click(skip);
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it("resolved: shows the summary and no buttons", () => {
    const item: Item = { kind: "interaction", requestId: "R4", mode: "approve", resolved: true, summary: "✅ 승인됨" };
    render(<InteractionCard item={item} />);
    expect(screen.getByText("✅ 승인됨")).toBeInTheDocument();
    expect(screen.queryByText("승인")).toBeNull();
  });

  it("approve: after clicking Approve, both buttons disable and the sending hint appears", () => {
    const onRespond = vi.fn();
    const item: Item = { kind: "interaction", requestId: "R5", mode: "approve", resolved: false };
    render(<InteractionCard item={item} onRespond={onRespond} />);
    // Grab the button elements before clicking — the clicked one swaps its label for a loading spinner (Button's `loading` prop).
    const approveBtn = screen.getByText("승인").closest("button")!;
    const denyBtn = screen.getByText("거부").closest("button")!;
    fireEvent.click(approveBtn);
    expect(approveBtn).toBeDisabled();
    expect(denyBtn).toBeDisabled();
    expect(screen.getByText("응답 전송 중…")).toBeInTheDocument();
    // Clicking again while sent must not fire a second respond (button is disabled).
    fireEvent.click(approveBtn);
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it("ask: after clicking Submit, option pills and Submit disable and the sending hint appears", () => {
    const onRespond = vi.fn();
    const item: Item = {
      kind: "interaction", requestId: "R6", mode: "ask", resolved: false,
      questions: [{ question: "Format?", header: "Fmt", options: [{ label: "Summary" }, { label: "Detailed" }] }],
    };
    render(<InteractionCard item={item} onRespond={onRespond} />);
    const summaryOption = screen.getByText("Summary").closest("button")!;
    fireEvent.click(summaryOption);
    // Grab the Submit button before clicking — it swaps its label for a loading spinner once sent.
    const submit = screen.getByText("제출").closest("button")!;
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    expect(summaryOption).toBeDisabled();
    expect(screen.getByText("응답 전송 중…")).toBeInTheDocument();
  });
});
