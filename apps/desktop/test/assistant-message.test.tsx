import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// react-markdown is heavy, so stub Markdown with a dummy — we only verify the copy behavior.
vi.mock("../src/renderer/components/Markdown.js", () => ({
  Markdown: (p: { children: string }) => <div data-testid="md">{p.children}</div>,
  StreamingMarkdown: (p: { content: string }) => <div data-testid="streaming">{p.content}</div>,
}));

import { AssistantMessage } from "../src/renderer/components/AssistantMessage.js";

describe("AssistantMessage copy", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("clicking the copy button copies the original content to the clipboard + shows ✓ feedback", async () => {
    render(<AssistantMessage content={"에이전트 답변 **md**"} />);
    const btn = screen.getByLabelText("에이전트 메시지 복사");
    expect(btn.title).toBe("복사"); // initial
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith("에이전트 답변 **md**"); // the raw markdown as-is
    await waitFor(() => expect(screen.getByLabelText("에이전트 메시지 복사").title).toBe("복사됨")); // ✓
  });

  it("hides the copy button while streaming (incomplete)", () => {
    render(<AssistantMessage content={"…"} streaming />);
    expect(screen.queryByLabelText("에이전트 메시지 복사")).toBeNull();
    expect(screen.getByTestId("streaming")).toBeInTheDocument();
  });
});

describe("AssistantMessage relative time", () => {
  const DAY = 86_400_000;

  it("displays the relative time next to the copy button when ts is given (ko fallback)", () => {
    const { container } = render(<AssistantMessage content="hi" ts={Date.now() - 3 * DAY} />);
    const time = container.querySelector("time");
    expect(time?.textContent).toBe("3일 전");
  });

  it("shows a just-arrived message as '방금'", () => {
    const { container } = render(<AssistantMessage content="hi" ts={Date.now() - 5000} />);
    expect(container.querySelector("time")?.textContent).toBe("방금");
  });

  it("does not render the time element when ts is absent", () => {
    const { container } = render(<AssistantMessage content="hi" />);
    expect(container.querySelector("time")).toBeNull();
  });

  it("hides the time too while streaming", () => {
    const { container } = render(<AssistantMessage content="…" streaming ts={Date.now()} />);
    expect(container.querySelector("time")).toBeNull();
  });
});
