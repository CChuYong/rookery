// A page with unsaved edits (Settings) can hold App-level navigation until the user decides (review fix for audit #93).
// The store's navigate/back/forward consult the guard whenever the overlay would change; the guard either lets the
// move through (returns false) or keeps it and calls `proceed` later, after the user confirmed (returns true).
export type LeaveGuard = (proceed: () => void) => boolean;

let guard: LeaveGuard | null = null;

// Returns the unregister function (a no-op if another guard replaced this one meanwhile).
export function setLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => { if (guard === next) guard = null; };
}

// Runs `proceed` now unless the registered guard holds it.
export function runGuarded(proceed: () => void): void {
  if (guard && guard(proceed)) return;
  proceed();
}
