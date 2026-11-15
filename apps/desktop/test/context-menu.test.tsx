import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextMenu, clampMenuPosition } from "../src/renderer/components/ContextMenu.js";

// audit #26: a tall menu opened near the bottom/right edge used to run off-screen (the last "Delete…" item was
// unreachable in a 920x600 window). The menu now flips above / to the left of the anchor when it would overflow.
describe("clampMenuPosition", () => {
  const vp = { width: 920, height: 600 };
  it("keeps the anchor when the menu fits", () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, { width: 160, height: 120 }, vp)).toEqual({ left: 100, top: 100 });
  });
  it("flips above the anchor when it would run past the bottom edge", () => {
    expect(clampMenuPosition({ x: 100, y: 550 }, { width: 160, height: 200 }, vp)).toEqual({ left: 100, top: 350 });
  });
  it("flips left of the anchor when it would run past the right edge", () => {
    expect(clampMenuPosition({ x: 850, y: 100 }, { width: 160, height: 100 }, vp)).toEqual({ left: 690, top: 100 });
  });
  it("never goes past the top/left gutter when the menu is taller/wider than the space on either side", () => {
    expect(clampMenuPosition({ x: 100, y: 300 }, { width: 160, height: 590 }, vp)).toEqual({ left: 100, top: 8 });
    expect(clampMenuPosition({ x: 100, y: 100 }, { width: 960, height: 100 }, vp).left).toBe(8);
  });
});

describe("ContextMenu viewport clamp (audit #26)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("moves the rendered menu up when it would overflow the bottom of the window", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 920 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 160, bottom: 200, width: 160, height: 200, toJSON: () => ({}) });
    render(<ContextMenu x={100} y={550} onClose={() => {}} items={[{ label: "Rename", onClick: () => {} }, { label: "Delete…", onClick: () => {}, danger: true }]} />);
    expect(screen.getByRole("menu")).toHaveStyle({ left: "100px", top: "350px" });
  });

  it("renders an optional header above the items (used by the narrow-header overflow menu for metrics)", () => {
    render(<ContextMenu x={10} y={10} onClose={() => {}} header={<span>42% ctx</span>} items={[{ label: "Reset layout", onClick: () => {} }]} />);
    expect(screen.getByText("42% ctx")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  });
});
