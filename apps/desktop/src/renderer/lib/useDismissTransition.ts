import { useCallback, useState } from "react";

// child-delayed-close for the modal exit animation. A modal mounted via `{open && <Modal/>}` shows no
// exit if you just unmount it → dismiss() sets closing=true to play the exit keyframes and calls the real onClose after ms.
// The parent's open flag stays true until onClose lowers it, so the modal stays alive during that time and the exit is visible.
// With reduced-motion, onClose fires immediately with no delay. Gets enter+exit without Radix while preserving focus/Esc/autoFocus behavior.
export function useDismissTransition(onClose: () => void, ms = 140): { closing: boolean; dismiss: () => void } {
  const [closing, setClosing] = useState(false);
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
      if (!wasClosing) setTimeout(onClose, ms); // only the first dismiss schedules close (idempotent)
      return true;
    });
  }, [onClose, ms]);
  return { closing, dismiss };
}
