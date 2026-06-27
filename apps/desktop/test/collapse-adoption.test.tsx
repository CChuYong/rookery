import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolBlock } from "../src/renderer/components/ToolBlock.js";
import { ThinkingBlock } from "../src/renderer/components/ThinkingBlock.js";

// Phase 1: replace the hard mount ({open && ...}) with <Collapse> (grid-rows render-latch).
// Once expanded, the body must stay in the DOM after closing (latch) so the exit transition plays.
describe("ToolBlock detail uses Collapse (render-latch)", () => {
  it("does not render detail until first opened (lazy)", () => {
    render(<ToolBlock name="Read" status="complete" input='{"file_path":"/r/a.ts"}' result="hello" />);
    expect(screen.queryByText("result")).toBeNull();
  });

  it("keeps the detail mounted after open→close (so exit can animate)", () => {
    render(<ToolBlock name="Read" status="complete" input='{"file_path":"/r/a.ts"}' result="hello" />);
    fireEvent.click(screen.getByText("Read")); // open
    expect(screen.getByText("result")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Read")); // close
    expect(screen.getByText("result")).toBeInTheDocument(); // latched, still mounted
  });
});

describe("ThinkingBlock body uses Collapse (render-latch)", () => {
  it("does not render the body until first opened", () => {
    render(<ThinkingBlock text="deep thought" />);
    expect(screen.queryByText("deep thought")).toBeNull();
  });

  it("keeps the body mounted after open→close", () => {
    render(<ThinkingBlock text="deep thought" />);
    fireEvent.click(screen.getByText("Thinking"));
    expect(screen.getByText("deep thought")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Thinking"));
    expect(screen.getByText("deep thought")).toBeInTheDocument();
  });
});
