import { describe, it, expect, vi } from "vitest";
import { revealScrollLeft, revealActiveTabs, enhanceOverflowHandles, enhanceOverflowMenus, sashAxis, touchesTabChrome } from "../../src/renderer/workspace/dock-dom.js";

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

describe("chevron Enter does not reach dockview's window-level Enter-closes-popover listener (review fix 5)", () => {
  it("stops propagation of the keys it handles", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div><div class="dv-tabs-overflow-dropdown-default"><svg></svg><span>2</span></div></div>`;
    document.body.appendChild(root);
    enhanceOverflowHandles(root, (n) => `${n}`);
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    root.querySelector<HTMLElement>(".dv-tabs-overflow-dropdown-default")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    window.removeEventListener("keydown", onWindowKey);
    root.remove();
    expect(onWindowKey).not.toHaveBeenCalled();
  });
});

describe("enhanceOverflowMenus (review fix 5)", () => {
  function menu() {
    const root = document.createElement("div");
    root.innerHTML = `<div class="dv-tabs-overflow-container"><div class="dv-tab dv-inactive-tab">a</div><div class="dv-tab dv-active-tab">b</div><div class="dv-tab dv-inactive-tab">c</div></div>`;
    document.body.appendChild(root);
    const items = Array.from(root.querySelectorAll<HTMLElement>(".dv-tab"));
    const clicks = items.map((it) => { const f = vi.fn(); it.addEventListener("click", f); return f; });
    return { root, items, clicks };
  }
  it("turns the list into a menu, focuses the active item, arrows move, Enter picks", () => {
    const { root, items, clicks } = menu();
    enhanceOverflowMenus(root);
    expect(root.querySelector(".dv-tabs-overflow-container")!.getAttribute("role")).toBe("menu");
    expect(items.every((it) => it.getAttribute("role") === "menuitem")).toBe(true);
    expect(document.activeElement).toBe(items[1]);
    items[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[2]);
    items[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[0]); // wraps
    items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(clicks[0]).toHaveBeenCalledTimes(1);
    root.remove();
  });
});

describe("sashAxis (review fix 6)", () => {
  it("a sash between columns resets width, between rows resets height", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="dv-split-view-container dv-horizontal"><div class="dv-sash-container"><div class="dv-sash" id="a"></div></div><div class="dv-split-view-container dv-vertical"><div class="dv-sash-container"><div class="dv-sash" id="b"></div></div></div></div><div id="c"></div>`;
    expect(sashAxis(root.querySelector("#a")!)).toBe("width");
    expect(sashAxis(root.querySelector("#b")!)).toBe("height");
    expect(sashAxis(root.querySelector("#c")!)).toBeNull();
  });
});

describe("touchesTabChrome (review fix 5)", () => {
  it("only reacts to mutations inside tab headers or dockview's popover anchor", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="dv-tabs-and-actions-container"><span id="h"></span></div><div class="dv-content"><p id="msg"></p></div><div class="dv-popover-anchor"><div id="p"></div></div>`;
    const rec = (id: string) => ({ target: root.querySelector(`#${id}`)! }) as unknown as MutationRecord;
    expect(touchesTabChrome([rec("msg")])).toBe(false);
    expect(touchesTabChrome([rec("msg"), rec("h")])).toBe(true);
    expect(touchesTabChrome([rec("p")])).toBe(true);
  });
});
