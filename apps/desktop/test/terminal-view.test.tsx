import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

// Review fix 2: the dock hides a terminal by giving its group 0 size (no display:none). Fitting a 0×0 host makes
// xterm report 1 row, and resizing the PTY to it makes vim/less/htop redraw into one line. The view must skip
// fit+resize while its host has no room, and resize again once it does.
const fit = vi.fn();
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    onData(): void {}
    focus(): void {}
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = fit; } }));

let roCallback: () => void = () => {};
class FakeRO { constructor(cb: () => void) { roCallback = cb; } observe(): void {} disconnect(): void {} }

let size = { w: 0, h: 0 };
const resize = vi.fn();

beforeEach(() => {
  fit.mockClear();
  resize.mockClear();
  vi.stubGlobal("ResizeObserver", FakeRO);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => size.w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => size.h });
  (window as unknown as { rookery: unknown }).rookery = {
    term: { onData: () => () => {}, onExit: () => () => {}, write: vi.fn(), attach: vi.fn(async () => ({ scrollback: "" })), resize, detach: vi.fn() },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

describe("TerminalView in a hidden (0×0) host (review fix 2)", () => {
  it("does not fit or resize the PTY while hidden, and does once it has room again", async () => {
    const { TerminalView } = await import("../src/renderer/components/TerminalView.js");
    size = { w: 600, h: 300 };
    render(<TerminalView id="t1" onExit={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    fit.mockClear();
    resize.mockClear();
    size = { w: 600, h: 0 }; // the dock hid the terminal group
    act(() => roCallback());
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    size = { w: 600, h: 300 }; // shown again
    act(() => roCallback());
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith("t1", 80, 24);
  });
});
