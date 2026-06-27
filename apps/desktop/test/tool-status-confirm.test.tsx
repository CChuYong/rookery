import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ToolBlock } from "../src/renderer/components/ToolBlock.js";
import { ToolGroup } from "../src/renderer/components/ToolGroup.js";

const dotOf = (c: HTMLElement) => c.querySelector("span.rounded-full") as HTMLElement;

describe("ToolBlock status-confirm dot", () => {
  it("eases the status dot color via transition", () => {
    const { container } = render(<ToolBlock name="Read" status="in_progress" />);
    expect(dotOf(container).className).toContain("transition");
  });

  it("settles the dot once on the in_progress→complete falling edge", () => {
    const { container, rerender } = render(<ToolBlock name="Read" status="in_progress" />);
    rerender(<ToolBlock name="Read" status="complete" />);
    expect(dotOf(container).className).toContain("dot-settle");
  });

  it("does NOT settle when mounted already complete (history replay)", () => {
    const { container } = render(<ToolBlock name="Read" status="complete" />);
    expect(dotOf(container).className).not.toContain("dot-settle");
  });
});

describe("ToolGroup aggregate dot status-confirm", () => {
  const tools = (s: "in_progress" | "complete") =>
    [
      { kind: "tool", name: "a", status: s },
      { kind: "tool", name: "b", status: "complete" },
    ] as never;

  it("eases the aggregate dot color via transition", () => {
    const { container } = render(<ToolGroup tools={tools("in_progress")} />);
    expect(dotOf(container).className).toContain("transition");
  });

  it("settles the aggregate dot once when the group stops running", () => {
    const { container, rerender } = render(<ToolGroup tools={tools("in_progress")} />);
    rerender(<ToolGroup tools={tools("complete")} />);
    expect(dotOf(container).className).toContain("dot-settle");
  });

  it("does NOT settle when mounted already settled (history replay)", () => {
    const { container } = render(<ToolGroup tools={tools("complete")} />);
    expect(dotOf(container).className).not.toContain("dot-settle");
  });
});
