import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { widthForKey, useResizableWidth } from "../../src/renderer/lib/useResizableWidth.js";
import { ResizeHandle } from "../../src/renderer/components/ResizeHandle.js";

// audit #106: separators are operable from the keyboard and double-click restores the default width.
describe("widthForKey", () => {
  const left = { min: 220, max: 440, side: "left" as const };
  const right = { min: 200, max: 560, side: "right" as const };
  it("arrows move 16px toward the arrow, clamped", () => {
    expect(widthForKey("ArrowRight", 300, left)).toBe(316);
    expect(widthForKey("ArrowLeft", 300, left)).toBe(284);
    expect(widthForKey("ArrowLeft", 300, right)).toBe(316); // right-hand panel: dragging left widens it
    expect(widthForKey("ArrowRight", 430, left)).toBe(440);
  });
  it("Home/End jump to the limits; other keys are ignored", () => {
    expect(widthForKey("Home", 300, left)).toBe(220);
    expect(widthForKey("End", 300, left)).toBe(440);
    expect(widthForKey("a", 300, left)).toBeNull();
  });
});

function Host(): JSX.Element {
  const panel = useResizableWidth("test.width", 252, { min: 220, max: 440, side: "left" });
  return <><div data-testid="w">{panel.width}</div><ResizeHandle onPointerDown={panel.startDrag} handle={panel.handle} label="Resize" /></>;
}

describe("ResizeHandle with bindings", () => {
  beforeEach(() => localStorage.removeItem("test.width"));
  it("is a focusable separator with values, resizes by keyboard and resets on double-click", () => {
    render(<Host />);
    const sep = screen.getByRole("separator", { name: "Resize" });
    expect(sep).toHaveAttribute("tabindex", "0");
    expect(sep).toHaveAttribute("aria-valuenow", "252");
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(screen.getByTestId("w").textContent).toBe("268");
    expect(localStorage.getItem("test.width")).toBe("268");
    fireEvent.keyDown(sep, { key: "End" });
    expect(screen.getByTestId("w").textContent).toBe("440");
    fireEvent.doubleClick(sep);
    expect(screen.getByTestId("w").textContent).toBe("252");
  });
});
