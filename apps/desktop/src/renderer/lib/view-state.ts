export interface ViewState { showRepos: boolean; sessionId: string | null; subId: string | null }

const KEY = "rookery.view";

// Last viewed location (tab/session/worker). Restoration is validated by App against the session and fleet lists before being applied.
export function readViewState(): ViewState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      showRepos: Boolean(o.showRepos),
      sessionId: typeof o.sessionId === "string" ? o.sessionId : null,
      subId: typeof o.subId === "string" ? o.subId : null,
    };
  } catch {
    return null;
  }
}

export function writeViewState(v: ViewState): void {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore — only persistence failed */ }
}
