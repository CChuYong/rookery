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
let lastHandle: HTMLElement | null = null; // the chevron that opened the current list, for returning focus on Escape

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
      // dockview closes its popover on any window-level Enter keydown; letting this one bubble would close the list
      // in the same event that opened it.
      e.stopPropagation();
      lastHandle = handle;
      const r = handle.getBoundingClientRect();
      handle.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left, clientY: r.bottom }));
    });
  }
}

// The list the chevron opens (dockview renders it into its popover anchor as plain divs with click listeners): give
// it menu semantics and keyboard use — focus starts on the active tab, arrows move (wrapping), Enter/Space pick,
// Escape returns focus to the chevron (dockview itself closes the popover on Escape).
export function enhanceOverflowMenus(root: HTMLElement): void {
  for (const list of root.querySelectorAll<HTMLElement>(".dv-tabs-overflow-container")) {
    if (list.dataset.rkEnhanced === "1") continue;
    list.dataset.rkEnhanced = "1";
    list.setAttribute("role", "menu");
    const items = Array.from(list.querySelectorAll<HTMLElement>(":scope > .dv-tab"));
    items.forEach((item, i) => {
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
          next?.focus();
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          item.click();
        } else if (e.key === "Escape") {
          lastHandle?.focus();
        }
      });
    });
    (items.find((it) => it.classList.contains("dv-active-tab")) ?? items[0])?.focus();
  }
}

// Which dimension a dock sash controls: a sash in a side-by-side split resizes widths, one in a stacked split heights.
export function sashAxis(target: Element): "width" | "height" | null {
  const sash = target.closest(".dv-sash");
  const split = sash?.closest(".dv-split-view-container");
  if (!split) return null;
  return split.classList.contains("dv-horizontal") ? "width" : split.classList.contains("dv-vertical") ? "height" : null;
}

// Whether any mutation happened in tab chrome (tab headers, or the popover anchor where the overflow list opens).
// The dock's content (streamed transcript, xterm, Monaco) mutates constantly and must not trigger tab work.
export function touchesTabChrome(records: readonly MutationRecord[]): boolean {
  return records.some((r) => {
    const el = r.target instanceof Element ? r.target : r.target.parentElement;
    return !!el?.closest(".dv-tabs-and-actions-container, .dv-popover-anchor");
  });
}
