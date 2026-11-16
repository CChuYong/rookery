import { useEffect } from "react";
import type { RefObject } from "react";
import { focusablesIn, useFocusReturn } from "./focus.js";

export type FocusTrapOptions = {
  // Trap Tab only while this returns true (e.g. a drawer that is modal only in its overlay layout). Default: always.
  trapWhen?: () => boolean;
  // Element to focus on open instead of the [data-autofocus] / first-focusable default.
  initialFocus?: () => HTMLElement | null | undefined;
};

// Trap Tab focus within `ref` while mounted, and restore focus to the previously-focused element on unmount. On mount it
// focuses the first focusable (preferring [data-autofocus]) UNLESS something inside is already focused (so a React autoFocus
// prop wins). Completes the modal a11y contract together with useModalKeys (Escape) + role=dialog/aria-modal on the panel.
// The element to restore is captured during the first render (useFocusReturn) — an autoFocus child has already taken
// focus by the time any effect runs, which used to make a closed confirm drop focus to <body> instead of its trigger.
export function useFocusTrap(ref: RefObject<HTMLElement | null>, options: FocusTrapOptions = {}): void {
  const ret = useFocusReturn();
  const { trapWhen, initialFocus } = options;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focusables = (): HTMLElement[] => focusablesIn(el);

    // Focus into the dialog on open — but don't steal focus from an element that autoFocus already claimed.
    if (!el.contains(document.activeElement)) {
      (initialFocus?.() ?? el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus();
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      if (trapWhen && !trapWhen()) return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      else if (!el.contains(active)) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      // Restore focus to where it was before the modal opened (if that element is still in the document).
      ret.restore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options are read once per mount, like the original hook
  }, [ref]);
}
