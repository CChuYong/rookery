import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Collapse } from "../src/renderer/components/Collapse.js";

describe("Collapse (grid-rows disclosure with render-latch)", () => {
  it("renders children when open", () => {
    render(<Collapse open><p>body</p></Collapse>);
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("does not render children when it has never been opened (lazy)", () => {
    render(<Collapse open={false}><p>body</p></Collapse>);
    expect(screen.queryByText("body")).toBeNull();
  });

  it("keeps children mounted after closing (render-latch, so exit can animate)", () => {
    const { rerender } = render(<Collapse open><p>body</p></Collapse>);
    rerender(<Collapse open={false}><p>body</p></Collapse>);
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("drives the open/closed grid-rows track via class", () => {
    const { container, rerender } = render(<Collapse open><p>body</p></Collapse>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("grid-rows-[1fr]");
    rerender(<Collapse open={false}><p>body</p></Collapse>);
    expect(root.className).toContain("grid-rows-[0fr]");
  });
});

// audit #107 follow-on: a folded region keeps its rows mounted for the exit transition, but they must not stay
// reachable by Tab or the roving Arrow keys.
describe("Collapse inert while closed", () => {
  it("marks the closed region inert and clears it on open", () => {
    const { container, rerender } = render(<Collapse open><button>row</button></Collapse>);
    const region = container.firstElementChild!;
    expect(region).not.toHaveAttribute("inert");
    rerender(<Collapse open={false}><button>row</button></Collapse>);
    expect(region).toHaveAttribute("inert");
    rerender(<Collapse open><button>row</button></Collapse>);
    expect(region).not.toHaveAttribute("inert");
  });
});
