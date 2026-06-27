import { useEffect } from "react";
import type { RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Trap Tab focus within `ref` while mounted, and restore focus to the previously-focused element on unmount. On mount it
// focuses the first focusable (preferring [data-autofocus]) UNLESS something inside is already focused (so a React autoFocus
// prop wins). Completes the modal a11y contract together with useModalKeys (Escape) + role=dialog/aria-modal on the panel.
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));

    // Focus into the dialog on open — but don't steal focus from an element that autoFocus already claimed.
    if (!el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus();
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
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
      if (prev && prev.isConnected) prev.focus();
    };
  }, [ref]);
}
