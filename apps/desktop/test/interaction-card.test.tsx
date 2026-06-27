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

  it("resolved: shows the summary and no buttons", () => {
    const item: Item = { kind: "interaction", requestId: "R4", mode: "approve", resolved: true, summary: "✅ 승인됨" };
    render(<InteractionCard item={item} />);
    expect(screen.getByText("✅ 승인됨")).toBeInTheDocument();
    expect(screen.queryByText("승인")).toBeNull();
  });
});
