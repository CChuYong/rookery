import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
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
  // review m2: a menu opened under a button must flip to ABOVE the button (and to its left edge), not over it.
  it("with an anchor rect, flips above the trigger and right-aligns to it", () => {
    const anchor = { top: 560, bottom: 584, left: 840, right: 864 };
    expect(clampMenuPosition({ x: 840, y: 586 }, { width: 160, height: 200 }, vp, anchor)).toEqual({ left: 704, top: 360 });
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

  it("caps its height to the viewport and scrolls when taller", () => {
    render(<ContextMenu x={10} y={10} onClose={() => {}} items={[{ label: "a", onClick: () => {} }]} />);
    expect(screen.getByRole("menu").className).toMatch(/max-h-\[calc\(100vh-16px\)\]/);
    expect(screen.getByRole("menu").className).toMatch(/overflow-y-auto/);
  });

  it("renders an optional header above the items (used by the narrow-header overflow menu for metrics)", () => {
    render(<ContextMenu x={10} y={10} onClose={() => {}} header={<span>42% ctx</span>} items={[{ label: "Reset layout", onClick: () => {} }]} />);
    expect(screen.getByText("42% ctx")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  });
});

// audit #67: closing the menu dropped focus on <body>, Tab walked out of an open menu, and there was no Home/End.
describe("ContextMenu focus (audit #67)", () => {
  function Harness({ onPick }: { onPick: () => void }): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>trigger</button>
        {open && <ContextMenu x={10} y={10} onClose={() => setOpen(false)} items={[{ label: "Rename", onClick: onPick }, { label: "Fork", onClick: () => {} }, { label: "Delete…", onClick: () => {}, danger: true }]} />}
      </>
    );
  }
  const openMenu = (): HTMLElement => {
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    fireEvent.click(trigger);
    return trigger;
  };

  it("returns focus to the trigger on Escape", () => {
    render(<Harness onPick={() => {}} />);
    const trigger = openMenu();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger before an item runs (so a dialog it opens can restore it)", () => {
    let focusedDuringPick: Element | null = null;
    render(<Harness onPick={() => { focusedDuringPick = document.activeElement; }} />);
    const trigger = openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(focusedDuringPick).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Tab instead of letting focus wander out, and supports Home/End", () => {
    render(<Harness onPick={() => {}} />);
    const trigger = openMenu();
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete…" }));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.keyDown(menu, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
