import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { useFocusTrap } from "../src/renderer/lib/useFocusTrap.js";

function Harness(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div ref={ref}>
      <button>a</button>
      <button>b</button>
      <button>c</button>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("focuses the first focusable on mount", () => {
    const { getByText } = render(<Harness />);
    expect(document.activeElement).toBe(getByText("a"));
  });

  it("wraps Tab from the last focusable back to the first", () => {
    const { getByText } = render(<Harness />);
    const c = getByText("c");
    c.focus();
    fireEvent.keyDown(c, { key: "Tab" });
    expect(document.activeElement).toBe(getByText("a"));
  });

  it("wraps Shift+Tab from the first focusable to the last", () => {
    const { getByText } = render(<Harness />);
    const a = getByText("a");
    a.focus();
    fireEvent.keyDown(a, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(getByText("c"));
  });

  it("restores focus to the previously-focused element on unmount", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const { unmount, getByText } = render(<Harness />);
    expect(document.activeElement).toBe(getByText("a"));
    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
