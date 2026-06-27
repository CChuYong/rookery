import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MessageList } from "../src/renderer/components/MessageList.js";

const msg = (content: string, role: "user" | "assistant") => ({ kind: "message", role, content }) as never;

describe("MessageList new-row entrance (rise-in on the last row only)", () => {
  it("marks the last committed row with rise-in, not earlier rows", () => {
    const { container } = render(<MessageList items={[msg("first", "assistant"), msg("second", "assistant")]} />);
    const scroll = container.querySelector(".overflow-y-auto")!;
    const rows = Array.from(scroll.children);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[rows.length - 1].className).toContain("rise-in");
    expect(rows[0].className).not.toContain("rise-in");
  });

  it("rises the waiting (thinking) bubble in during the handoff", () => {
    const { getByText } = render(<MessageList items={[msg("hello", "user")]} />);
    const bubble = getByText("생각하는 중…").closest("div")!;
    expect(bubble.className).toContain("rise-in");
  });
});

describe("MessageList screen-reader live region", () => {
  it("exposes the transcript as a polite live log", () => {
    const { getByRole } = render(<MessageList items={[msg("hi", "assistant")]} />);
    const log = getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
  });

  it("marks the waiting bubble as a status region", () => {
    const { getByText } = render(<MessageList items={[msg("hello", "user")]} />);
    expect(getByText("생각하는 중…").closest("[role='status']")).not.toBeNull();
  });
});
