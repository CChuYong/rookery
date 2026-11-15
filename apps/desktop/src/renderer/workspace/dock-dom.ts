// DOM touch-ups for dockview's own tab chrome that its API doesn't expose: keeping the active tab scrolled into view
// after a resize (audit #2) and making the tab-overflow chevron a real keyboard-operable button (audit #71).

// scrollLeft that brings a tab fully into view with the least movement, or null when it is already visible. A tab
// wider than the strip is aligned to its left edge so its label start stays readable.
export function revealScrollLeft(tabLeft: number, tabWidth: number, scrollLeft: number, clientWidth: number): number | null {
  const tabRight = tabLeft + tabWidth;
  if (tabLeft < scrollLeft || tabWidth >= clientWidth) return tabLeft === scrollLeft ? null : tabLeft;
  if (tabRight > scrollLeft + clientWidth) return tabRight - clientWidth;
  return null;
}

// dockview scrolls the active tab into view only when the tab is activated; shrinking the window afterwards can push
// the tab you are editing into the overflow list. Re-run after every resize/layout change. Setting scrollLeft fires
// the strip's scroll event, which makes dockview recompute its overflow list.
export function revealActiveTabs(root: HTMLElement): void {
  for (const strip of root.querySelectorAll<HTMLElement>(".dv-tabs-container")) {
    const tab = strip.querySelector<HTMLElement>(":scope > .dv-tab.dv-active-tab");
    if (!tab) continue;
    const next = revealScrollLeft(tab.offsetLeft, tab.offsetWidth, strip.scrollLeft, strip.clientWidth);
    if (next !== null) strip.scrollLeft = next;
  }
}

const HANDLE = ".dv-tabs-overflow-dropdown-default";

// dockview's overflow handle is a bare div with a click listener: no focus, no name (a screen reader hears "2").
// Give it button semantics and a name, and open it from the keyboard. dockview positions its popover from the click
// coordinates, so the synthetic click carries the handle's own position.
export function enhanceOverflowHandles(root: HTMLElement, label: (count: number) => string): void {
  for (const handle of root.querySelectorAll<HTMLElement>(HANDLE)) {
    const count = Number.parseInt(handle.textContent ?? "", 10) || 0;
    const name = label(count);
    if (handle.getAttribute("aria-label") !== name) handle.setAttribute("aria-label", name);
    if (handle.dataset.rkEnhanced === "1") continue;
    handle.dataset.rkEnhanced = "1";
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-haspopup", "menu");
    handle.tabIndex = 0;
    handle.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const r = handle.getBoundingClientRect();
      handle.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left, clientY: r.bottom }));
    });
  }
}
