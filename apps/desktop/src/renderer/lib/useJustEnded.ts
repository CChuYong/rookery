import { useEffect, useRef } from "react";

// Returns true exactly once, only on the falling edge of a state transition (active: true→false).
// Purpose: fire a 1-shot motion (dot-settle/status-flash) for a persistent node like 'in progress → done'
// only on an actual transition, and not on history replay (mounted already in the done state).
// On mount, prev = the first active value, so mounting directly with active=false yields just=false (no flicker).
export function useJustEnded(active: boolean): boolean {
  const prev = useRef(active);
  const just = prev.current && !active;
  useEffect(() => {
    prev.current = active;
  });
  return just;
}
