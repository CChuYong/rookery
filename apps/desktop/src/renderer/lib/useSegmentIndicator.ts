import { useLayoutEffect, useRef, useState, type DependencyList, type RefObject } from "react";

// Tracks the left/width of the element with data-seg=activeKey inside the container → indicator coordinates that slide to the active position.
// Shared by tab underline and segment pill (a lightweight version of FLIP: move a single indicator via left/width transitions).
// Re-measures on container size changes (window/sidebar resize, tab text) via ResizeObserver. Guarded since jsdom may not have it.
export function useSegmentIndicator(
  activeKey: string | number | null,
  deps: DependencyList = [],
): { containerRef: RefObject<HTMLDivElement>; rect: { left: number; width: number } | null } {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c || activeKey == null) {
      setRect(null);
      return;
    }
    const key = String(activeKey);
    const measure = (): void => {
      const el = Array.from(c.querySelectorAll<HTMLElement>("[data-seg]")).find((e) => e.dataset.seg === key);
      setRect(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, ...deps]);
  return { containerRef, rect };
}
