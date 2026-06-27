// Models the UI "location" (where you're currently looking) as a single model. Bundles the main-area overlay
// + Sessions/Repos + the active session/worker into one Location, and routes every transition through the
// pure navigate/back/forward functions.
// (Previously this was scattered across overlay/showRepos useState + an activeSessionId/activeWorkerId store +
//  a ref stack + a 4-axis diff effect, which made back/forward and selection highlighting get out of sync —
//  this model is the single source.)

export type Overlay = "settings" | "newSession" | "automation" | null;

export interface Location {
  overlay: Overlay;
  showRepos: boolean;
  sessionId: string | null;
  subId: string | null;
}

// Navigation state including the history stacks. back=past (the end is the most recent), forward=undone future (the front is next).
export interface NavState {
  loc: Location;
  back: Location[];
  forward: Location[];
}

export const initialLocation: Location = { overlay: null, showRepos: false, sessionId: null, subId: null };
export const initialNav: NavState = { loc: initialLocation, back: [], forward: [] };

export function sameLoc(a: Location, b: Location): boolean {
  return a.overlay === b.overlay && a.showRepos === b.showRepos && a.sessionId === b.sessionId && a.subId === b.subId;
}

// Update the current location with a patch. If the location actually changes, push the current one onto back and clear forward (browser-style).
export function navigate(st: NavState, patch: Partial<Location>): NavState {
  const next: Location = { ...st.loc, ...patch };
  if (sameLoc(next, st.loc)) return st; // same location → no-op (avoids polluting history)
  return { loc: next, back: [...st.back, st.loc], forward: [] }; // new transition → discard forward (the future we had undone)
}

export function back(st: NavState): NavState {
  if (st.back.length === 0) return st;
  const prev = st.back[st.back.length - 1]!;
  return { loc: prev, back: st.back.slice(0, -1), forward: [st.loc, ...st.forward] };
}

export function forward(st: NavState): NavState {
  if (st.forward.length === 0) return st;
  const next = st.forward[0]!;
  return { loc: next, back: [...st.back, st.loc], forward: st.forward.slice(1) };
}

// Set only the location without history (e.g. for restoration — the initial entry should have nothing to go back to).
export function reset(loc: Location): NavState {
  return { loc, back: [], forward: [] };
}
