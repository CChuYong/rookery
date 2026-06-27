import { useEffect, useState } from "react";

// On close (open: true→false), don't unmount immediately; keep it mounted for `ms` so the exit animation can play.
// Use it as `{mounted && <Panel open={open}/>}`, where Panel drives the enter/exit transition off `open`.
// Under reduced-motion, unmount immediately with no delay. If reopened while closing, cancel the scheduled unmount.
export function useMountTransition(open: boolean, ms = 180): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const reduce =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    if (reduce) {
      setMounted(false);
      return;
    }
    const id = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(id);
  }, [open, ms]);
  return mounted;
}
