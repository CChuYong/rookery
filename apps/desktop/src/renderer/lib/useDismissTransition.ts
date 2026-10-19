import { useCallback, useEffect, useRef, useState } from "react";

// child-delayed-close for the modal exit animation. A modal mounted via `{open && <Modal/>}` shows no
// exit if you just unmount it → dismiss() sets closing=true to play the exit keyframes and calls the real onClose after ms.
// The parent's open flag stays true until onClose lowers it, so the modal stays alive during that time and the exit is visible.
// With reduced-motion, onClose fires immediately with no delay. Gets enter+exit without Radix while preserving focus/Esc/autoFocus behavior.
export function useDismissTransition(onClose: () => void, ms = 140): { closing: boolean; dismiss: () => void } {
  const [closing, setClosing] = useState(false);
  // Pending delayed close. Cleared on unmount: if the modal is torn down mid-exit (parent unmounted it, or a
  // test finished), the late onClose would setState on an unmounted tree — in CI that surfaced as an
  // unhandled "window is not defined" after jsdom teardown.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const dismiss = useCallback(() => {
    const reduce =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    if (reduce) {
      onClose();
      return;
    }
    setClosing((wasClosing) => {
      // only the first dismiss schedules close (idempotent)
      if (!wasClosing && timer.current === null) {
        timer.current = setTimeout(() => {
          timer.current = null;
          onClose();
        }, ms);
      }
      return true;
    });
  }, [onClose, ms]);
  return { closing, dismiss };
}
