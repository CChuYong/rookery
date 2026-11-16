import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

// Shared keyboard/focus helpers (audit T11): focus return when an overlay closes, roving tab stops in lists, scrolling
// the active option of a popup into view, and the IME / typing-target guards every shortcut needs. One place, so each
// menu, popover and list behaves the same instead of each re-inventing a slightly different contract.

export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("hidden") && !el.closest("[hidden]"));
}

// True while an IME (Korean/Japanese/Chinese input) is composing: the Enter that commits the last syllable must not
// also submit, rename or pick a highlighted option. Accepts a React synthetic event or a native KeyboardEvent.
export function isImeComposing(e: { nativeEvent?: { isComposing?: boolean }; isComposing?: boolean; keyCode?: number }): boolean {
  return !!(e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229);
}

// Text-entry targets keep their keys: inputs, textareas, selects, contenteditable (the Lexical composer), Monaco and
// xterm (both type into a hidden textarea, covered by `textarea`).
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .monaco-editor");
}

// "The user is in the middle of typing something": a typing target that already holds text (or Monaco/xterm, which
// always count). Used to decide whether a newly surfaced control may take focus without stealing a half-typed draft.
export function isMidTyping(el: Element | null): boolean {
  if (!el || !isTypingTarget(el)) return false;
  const h = el as HTMLElement;
  if (h.closest(".monaco-editor, .xterm")) return true;
  if (h instanceof HTMLInputElement || h instanceof HTMLTextAreaElement) return h.value.length > 0;
  if (h instanceof HTMLSelectElement) return false;
  const editable = h.closest<HTMLElement>("[contenteditable='true'], [contenteditable='']");
  return (editable?.textContent ?? "").trim().length > 0;
}

// Next index for a vertical list on ArrowDown/ArrowUp (wrapping) and Home/End; null for any other key.
export function rovingIndex(key: string, idx: number, len: number): number | null {
  if (len <= 0) return null;
  if (key === "ArrowDown") return idx < 0 ? 0 : (idx + 1) % len;
  if (key === "ArrowUp") return idx < 0 ? len - 1 : (idx - 1 + len) % len;
  if (key === "Home") return 0;
  if (key === "End") return len - 1;
  return null;
}

// Move focus back to `el` when it is still in the document and focusable; returns whether it did.
export function restoreFocusTo(el: Element | null | undefined): boolean {
  if (!el || !(el instanceof HTMLElement) || !el.isConnected || el === document.body) return false;
  el.focus();
  return document.activeElement === el;
}

// Remembers the element that had focus when the component FIRST RENDERED — before any child autoFocus or effect moved
// it — and returns a function that puts focus back there. Captured during render on purpose: React applies `autoFocus`
// during commit, ahead of every effect, so reading document.activeElement in an effect already sees the dialog's own
// button (the reason a confirm used to drop focus to <body> when it closed).
export function useFocusReturn(): { readonly element: HTMLElement | null; restore: () => boolean } {
  const ref = useRef<{ element: HTMLElement | null; restore: () => boolean } | null>(null);
  if (ref.current === null) {
    const element = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    ref.current = { element, restore: () => restoreFocusTo(element) };
  }
  return ref.current;
}

// For a popover/menu that stays mounted (or a toggled one): when `open` goes true → false and focus was inside the panel
// (or fell to <body> because the panel unmounted), give it back to the trigger.
export function useReturnFocusOnClose(open: boolean, triggerRef: RefObject<HTMLElement | null>, panelRef: RefObject<HTMLElement | null>): void {
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (!active || active === document.body || panelRef.current?.contains(active)) triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, triggerRef, panelRef]);
}

// Keep the highlighted option of a listbox-style popup visible while the arrow keys move it (audit #70): the selection
// used to walk out of the scroll area, so Enter picked something the user could not see.
export function useScrollActiveIntoView(listRef: RefObject<HTMLElement | null>, activeIndex: number, itemSelector = '[role="option"]'): void {
  useEffect(() => {
    if (activeIndex < 0) return;
    const item = listRef.current?.querySelectorAll<HTMLElement>(itemSelector)[activeIndex];
    item?.scrollIntoView?.({ block: "nearest" });
  }, [listRef, activeIndex, itemSelector]);
}

// Roving tabindex for a list of rows (audit #107): the whole list is ONE tab stop — the row marked aria-current (else the
// last focused row, else the first) — and ArrowUp/ArrowDown/Home/End move between rows. Tab stops are managed on the
// DOM (not via props) so rows rendered by memoised children or added later are covered too; a MutationObserver
// re-applies them when rows come and go. Typing targets inside the list (a rename input) keep their keys.
export function useRovingTabIndex(containerRef: RefObject<HTMLElement | null>, itemSelector = "[data-roving-item]"): void {
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    let last: HTMLElement | null = null;
    // Rows inside a folded (inert) group are skipped.
    const items = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(itemSelector)).filter((el) => !el.closest("[inert]"));
    const apply = (): void => {
      const all = items();
      if (all.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const stop =
        all.find((el) => el === active) ??
        (last && all.includes(last) ? last : undefined) ??
        all.find((el) => el.getAttribute("aria-current") === "page" || el.getAttribute("aria-current") === "true") ??
        all[0]!;
      for (const el of all) {
        const want = el === stop ? "0" : "-1";
        if (el.getAttribute("tabindex") !== want) el.setAttribute("tabindex", want);
      }
    };
    const onFocusIn = (e: FocusEvent): void => {
      const item = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(itemSelector);
      if (item && root.contains(item)) { last = item; apply(); }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || isTypingTarget(e.target)) return;
      const all = items();
      const current = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(itemSelector) ?? null;
      if (!current) return;
      const next = rovingIndex(e.key, all.indexOf(current), all.length);
      if (next === null) return;
      e.preventDefault();
      all[next]?.focus();
      all[next]?.scrollIntoView?.({ block: "nearest" });
    };
    apply();
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("keydown", onKeyDown);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(apply) : null;
    mo?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current", "inert"] });
    return () => {
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("keydown", onKeyDown);
      mo?.disconnect();
    };
  }, [containerRef, itemSelector]);
}

// Escape closes a full page (Settings, the Automation list) the way it closes New session (audit #129) — but only when
// nothing else owns the key: a modal dialog, a focused menu/popover/listbox, or a control that already handled it.
export function usePageEscape(onEscape: (() => void) | undefined): void {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  const enabled = !!onEscape;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.('[role="dialog"], [role="menu"], [role="listbox"], [aria-expanded="true"]')) return;
      cb.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
