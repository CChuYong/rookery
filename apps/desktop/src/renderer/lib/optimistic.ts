import { useStore } from "../store/store.js";

// Optimistic row flags (audit #56): Pin/Archive flip the row in the store at once and put it back if the daemon
// rejects the request, the same way Delete already removed its row up front. Each patch returns its own rollback,
// which restores only the fields it changed, so a concurrent change to another field of the same row survives.

type SessionFlags = { pinned?: boolean; archived?: boolean };
type WorkerFlags = { archived?: boolean };

export function patchSession(id: string, patch: SessionFlags): () => void {
  const row = useStore.getState().sessions.find((x) => x.id === id);
  if (!row) return () => {};
  const prev: SessionFlags = {};
  for (const k of Object.keys(patch) as Array<keyof SessionFlags>) prev[k] = row[k];
  const apply = (p: SessionFlags): void => useStore.setState((st) => ({ sessions: st.sessions.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  apply(patch);
  return () => apply(prev);
}

export function patchWorker(id: string, patch: WorkerFlags): () => void {
  const row = useStore.getState().fleet[id];
  if (!row) return () => {};
  const prev: WorkerFlags = {};
  for (const k of Object.keys(patch) as Array<keyof WorkerFlags>) prev[k] = row[k];
  const apply = (p: WorkerFlags): void => useStore.setState((st) => {
    const cur = st.fleet[id];
    return cur ? { fleet: { ...st.fleet, [id]: { ...cur, ...p } } } : {};
  });
  apply(patch);
  return () => apply(prev);
}

// Apply now, send, and undo on failure. `apply` returns the rollback (patchSession / patchWorker above).
export async function optimistic(
  apply: () => () => void,
  request: () => Promise<unknown>,
  handlers: { onSuccess?: () => void; onError: (e: unknown) => void },
): Promise<void> {
  const rollback = apply();
  try {
    await request();
  } catch (e) {
    rollback();
    handlers.onError(e);
    return;
  }
  handlers.onSuccess?.();
}
