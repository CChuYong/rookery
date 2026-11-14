import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Sessions } from "../src/renderer/views/Sessions.js";

const sessions = ["ui", "slack", "automation"].map((origin, i) => ({
  id: `s${i}`, cwd: "/repo", label: `Session ${i}`, origin,
  status: "active", lastActivity: new Date().toISOString(),
}));

// jsdom has no layout: model intrinsic tab widths and drive the browser resize event.
let width: number;
let observers: Set<ResizeObserverCallback>;
const props = { sessions: sessions as never, activeId: null, onSelect: vi.fn(), onFilter: vi.fn() };
beforeEach(() => {
  width = 200;
  observers = new Set();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("role") !== "tablist") return width;
    const threeSources = this.querySelectorAll('[role="tab"]').length === 4;
    const countsVisible = /\d/.test(this.textContent ?? "");
    return Math.max(width, threeSources ? (countsVisible ? 360 : 250) : 180);
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
    unobserve() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function resize(next: number) {
  act(() => {
    width = next;
    for (const callback of [...observers]) callback([], {} as ResizeObserver);
  });
}

describe("responsive session source filter", () => {
  it("keeps every source selectable when narrow and restores counts when widened", () => {
    render(<Sessions {...props} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "slack" } });
    expect(props.onFilter).toHaveBeenCalledWith({ source: "slack" });
    resize(280);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "Slack" })).toHaveAttribute("title", "Slack · 1");
    resize(400);
    expect(screen.getByRole("tab", { name: "Slack 1" })).toBeInTheDocument();
  });

  it("reconsiders the select fallback when the available sources shrink", () => {
    const { rerender } = render(<Sessions {...props} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    rerender(<Sessions {...props} sessions={sessions.slice(0, 2) as never} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("tab", { name: "Slack 1" })).toBeInTheDocument();
  });

  it("keeps compact mode as a select even when there is room for tabs", () => {
    render(<Sessions {...props} compact />);
    resize(500);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
