import { describe, it, expect, vi } from "vitest";
import { revealScrollLeft, revealActiveTabs, enhanceOverflowHandles } from "../../src/renderer/workspace/dock-dom.js";

describe("revealScrollLeft (audit #2)", () => {
  it("returns null when the tab is already fully visible", () => {
    expect(revealScrollLeft(100, 80, 0, 400)).toBeNull();
  });
  it("scrolls right just enough to show a tab past the right edge", () => {
    expect(revealScrollLeft(380, 80, 0, 400)).toBe(60);
  });
  it("scrolls left to a tab hidden past the left edge", () => {
    expect(revealScrollLeft(20, 80, 100, 400)).toBe(20);
  });
  it("aligns a tab wider than the strip to its start", () => {
    expect(revealScrollLeft(300, 500, 0, 400)).toBe(300);
    expect(revealScrollLeft(300, 500, 300, 400)).toBeNull();
  });
});

describe("revealActiveTabs", () => {
  it("scrolls each strip to its active tab", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="dv-tabs-container"><div class="dv-tab dv-inactive-tab"></div><div class="dv-tab dv-active-tab"></div></div>`;
    const strip = root.querySelector<HTMLElement>(".dv-tabs-container")!;
    const tab = root.querySelector<HTMLElement>(".dv-active-tab")!;
    Object.defineProperty(tab, "offsetLeft", { value: 500 });
    Object.defineProperty(tab, "offsetWidth", { value: 120 });
    Object.defineProperty(strip, "clientWidth", { value: 400 });
    revealActiveTabs(root);
    expect(strip.scrollLeft).toBe(220);
  });
});

describe("enhanceOverflowHandles (audit #71)", () => {
  // Same structure dockview-core's createDropdownElementHandle builds; the click listener sits on the parent root.
  function overflow(count: number) {
    const root = document.createElement("div");
    const dropdownRoot = document.createElement("div");
    const handle = document.createElement("div");
    handle.className = "dv-tabs-overflow-dropdown-default";
    handle.innerHTML = `<svg></svg><span>${count}</span>`;
    dropdownRoot.appendChild(handle);
    root.appendChild(dropdownRoot);
    const onClick = vi.fn();
    dropdownRoot.addEventListener("click", onClick);
    return { root, handle, onClick };
  }

  it("gives the chevron button semantics, a counted name and a tab stop", () => {
    const { root, handle } = overflow(2);
    enhanceOverflowHandles(root, (n) => `${n} hidden tabs`);
    expect(handle.getAttribute("role")).toBe("button");
    expect(handle.getAttribute("aria-haspopup")).toBe("menu");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-label")).toBe("2 hidden tabs");
  });

  it("Enter and Space open the overflow list; other keys don't", () => {
    const { root, handle, onClick } = overflow(3);
    enhanceOverflowHandles(root, (n) => `${n}`);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("re-running updates the name when the count changes without adding a second key listener", () => {
    const { root, handle, onClick } = overflow(2);
    enhanceOverflowHandles(root, (n) => `${n} hidden tabs`);
    handle.querySelector("span")!.textContent = "4";
    enhanceOverflowHandles(root, (n) => `${n} hidden tabs`);
    expect(handle.getAttribute("aria-label")).toBe("4 hidden tabs");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
