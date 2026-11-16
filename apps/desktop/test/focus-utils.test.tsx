import { describe, it, expect } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { isImeComposing, isMidTyping, rovingIndex, useRovingTabIndex } from "../src/renderer/lib/focus.js";
import { ConfirmDialog } from "../src/renderer/ui/confirm-dialog.js";

// audit T11 — the shared focus helpers every menu/list/popup now uses.
describe("rovingIndex", () => {
  it("wraps ArrowDown/ArrowUp and jumps with Home/End", () => {
    expect(rovingIndex("ArrowDown", 2, 3)).toBe(0);
    expect(rovingIndex("ArrowUp", 0, 3)).toBe(2);
    expect(rovingIndex("ArrowDown", -1, 3)).toBe(0);
    expect(rovingIndex("Home", 2, 3)).toBe(0);
    expect(rovingIndex("End", 0, 3)).toBe(2);
    expect(rovingIndex("a", 0, 3)).toBeNull();
    expect(rovingIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("isImeComposing (audit #76)", () => {
  it("is true while composing or for the 229 keyCode the IME reports", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposing({ isComposing: true })).toBe(true);
    expect(isImeComposing({ keyCode: 229 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
  });
});

describe("isMidTyping", () => {
  it("counts only a typing target that already holds text", () => {
    const input = document.createElement("input");
    expect(isMidTyping(input)).toBe(false);
    input.value = "half";
    expect(isMidTyping(input)).toBe(true);
    expect(isMidTyping(document.createElement("button"))).toBe(false);
    expect(isMidTyping(null)).toBe(false);
  });
});

function List(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useRovingTabIndex(ref);
  return (
    <div ref={ref}>
      <button data-roving-item>one</button>
      <button data-roving-item aria-current="page">two</button>
      <button data-roving-item>three</button>
    </div>
  );
}

describe("useRovingTabIndex (audit #107)", () => {
  it("makes the list one tab stop (the current row) and moves with the arrow keys", () => {
    render(<List />);
    const [one, two, three] = ["one", "two", "three"].map((n) => screen.getByRole("button", { name: n }));
    expect(two).toHaveAttribute("tabindex", "0");
    expect(one).toHaveAttribute("tabindex", "-1");
    expect(three).toHaveAttribute("tabindex", "-1");
    two!.focus();
    fireEvent.keyDown(two!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(three);
    expect(three).toHaveAttribute("tabindex", "0");
    expect(two).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(three!, { key: "Home" });
    expect(document.activeElement).toBe(one);
  });
});

// Task 2 carry-over: the confirm's autofocused Cancel took focus before any effect ran, so the dialog "restored" focus
// to its own (now removed) button and the trigger was lost.
function ConfirmHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && <ConfirmDialog title="Delete?" body="sure" confirmLabel="Delete" onConfirm={() => {}} onCancel={() => setOpen(false)} />}
    </>
  );
}

describe("ConfirmDialog focus return", () => {
  it("gives focus back to the trigger after it closes", async () => {
    render(<ConfirmHarness />);
    const trigger = screen.getByRole("button", { name: "open" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "취소" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
