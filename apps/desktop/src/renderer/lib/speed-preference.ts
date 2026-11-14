import type { SpeedPreference } from "@daemon/core/speed.js";
import type { WsClient } from "../ws/client.js";
import { useStore } from "../store/store.js";

export interface SpeedWriteState {
  version: number;
  confirmedVersion: number;
  confirmed: SpeedPreference | null;
  pending: number;
}

// Only desired intent is optimistic. The preference-only route never runs a turn; authoritative rows confirm it.
export async function persistSpeedPreference(
  client: Pick<WsClient, "request">,
  kind: "master" | "worker",
  id: string,
  speed: SpeedPreference | null,
  writes: Map<string, SpeedWriteState>,
): Promise<void> {
  const key = `${kind}:${id}`;
  const state = useStore.getState();
  const previous = kind === "master" ? state.sessions.find((row) => row.id === id)?.speed : state.fleet[id]?.speed;
  const write = writes.get(key) ?? { version: 0, confirmedVersion: 0, confirmed: previous ?? null, pending: 0 };
  const version = ++write.version;
  write.pending++;
  writes.set(key, write);
  state.setSpeedIntent(kind, id, speed);
  try {
    if (kind === "master") await client.request({ type: "session.setSpeed", sessionId: id, speed });
    else await client.request({ type: "worker.setSpeed", id, speed });
    // An acknowledged preference remains persisted even if refreshing its row later fails.
    if (version > write.confirmedVersion) { write.confirmed = speed; write.confirmedVersion = version; }
    if (kind === "master") {
      const result = await client.request({ type: "session.list" });
      const target = result.sessions.find((row) => row.id === id);
      if (write.version === version && target) {
        const confirmed = target.speed ?? null;
        write.confirmed = confirmed;
        // The list snapshot may predate another target's optimistic mutation. Reconcile this preference only.
        useStore.setState((current) => ({ sessions: current.sessions.map((row) => row.id === id ? { ...row, speed: confirmed } : row) }));
      }
    } else {
      const result = await client.request({ type: "fleet.list" });
      const target = result.fleet.find((row) => row.id === id);
      if (write.version === version && target) {
        const confirmed = target.speed ?? null;
        write.confirmed = confirmed;
        useStore.setState((current) => current.fleet[id]
          ? { fleet: { ...current.fleet, [id]: { ...current.fleet[id], speed: confirmed } } }
          : {});
      }
    }
  } finally {
    if (--write.pending === 0) {
      const current = useStore.getState();
      const selected = kind === "master" ? current.sessions.find((row) => row.id === id)?.speed : current.fleet[id]?.speed;
      if (selected !== write.confirmed) current.setSpeedIntent(kind, id, write.confirmed);
      writes.delete(key);
    }
  }
}
