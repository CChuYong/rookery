import type { LogItem, FleetRow } from "../store/reduce.js";
import type { Automation } from "@daemon/persistence/repositories.js";
import { statusLabelKey } from "./status.js";

// Attention queue derivation (docs/superpowers/specs/2026-07-11-attention-queue-design.md): a pure
// function that ranks "what needs the human NOW" from state the store already tracks. Tier IS the
// ranking (no scoring): 0 = a turn is BLOCKED on a human answer · 1 = failures · 2 = review-pending.

export type AttentionKind = "interaction" | "worker-failure" | "automation-failure" | "worker-review" | "session-review";

export interface AttentionNav {
  sessionId?: string;
  workerId?: string;
  overlay?: "automation";
}

export interface AttentionItem {
  key: string; // stable ack/dedupe identity — see the spec's per-kind key formats
  tier: 0 | 1 | 2;
  kind: AttentionKind;
  label: string; // entity display name (session/worker label, automation name)
  detail?: string; // secondary context as literal text (tool name / question / automation error) — rendered verbatim
  detailKey?: string; // secondary context as an i18n key (worker status) — rendered through t() so it localizes; mutually exclusive with detail
  nav: AttentionNav;
  dismissible: boolean; // tier 0 resolves itself (answer the card) — no X
}

export interface AttentionInputs {
  logsBySession: Record<string, LogItem[]>;
  liveInteractionIds: ReadonlySet<string>;
  fleet: Record<string, FleetRow>;
  automations: Automation[];
  attention: Record<string, boolean>; // workers settled unseen (existing unread map)
  sessionAttention: Record<string, boolean>; // sessions whose turn ended unseen
  sessions: Array<{ id: string; label?: string | null }>;
  // Current location — items for what the user is ALREADY looking at are excluded (mirrors the dots'
  // "not while viewing" semantics). overlay non-null means neither session nor worker is in view.
  active: { sessionId: string | null; workerId: string | null; overlay: string | null };
}

const WORKER_FAILURE = new Set(["error", "failed"]);

export function buildAttentionItems(
  inputs: AttentionInputs,
  acked: ReadonlySet<string>,
): { items: AttentionItem[]; candidateKeys: Set<string> } {
  const items: AttentionItem[] = [];
  // Only PERSISTED-ack keys (tier-1 failures) — tier-0 resolves itself and tier-2 dismissals flip the
  // live unread maps instead (so the same worker settling again re-surfaces naturally). Feeds ack pruning.
  const candidateKeys = new Set<string>();
  const sessionLabel = (id: string): string => inputs.sessions.find((s) => s.id === id)?.label ?? id.slice(0, 8);
  const viewingSession = (id: string): boolean => inputs.active.overlay === null && inputs.active.sessionId === id && inputs.active.workerId === null;
  const viewingWorker = (id: string): boolean => inputs.active.overlay === null && inputs.active.workerId === id;

  // ── tier 0: unresolved interactions (AskUserQuestion / approvals) — a master turn is waiting on YOU.
  for (const [sessionId, log] of Object.entries(inputs.logsBySession)) {
    for (const it of log) {
      if (it.kind !== "interaction" || it.resolved) continue;
      if (!inputs.liveInteractionIds.has(it.requestId)) continue; // stale/expired card (reconnect reconciliation)
      const key = `interaction:${it.requestId}`;
      if (viewingSession(sessionId)) continue; // already looking at it
      items.push({
        key,
        tier: 0,
        kind: "interaction",
        label: sessionLabel(sessionId),
        detail: it.toolName ?? it.questions?.[0]?.question,
        nav: { sessionId },
        dismissible: false,
      });
    }
  }

  // ── tier 1: worker failures. A failed worker also suppresses its own tier-2 review entry (lower tier wins).
  const failedWorkers = new Set<string>();
  for (const w of Object.values(inputs.fleet)) {
    if (!WORKER_FAILURE.has(w.status) || w.archived) continue;
    failedWorkers.add(w.id);
    const key = `wfail:${w.id}:${w.status}`;
    candidateKeys.add(key);
    if (acked.has(key) || viewingWorker(w.id)) continue;
    items.push({ key, tier: 1, kind: "worker-failure", label: w.label, detailKey: statusLabelKey(w.status), nav: { workerId: w.id }, dismissible: true });
  }

  // ── tier 1: automation failures — lastRunAt in the key so a NEW failure re-surfaces past an old dismissal.
  for (const a of inputs.automations) {
    if (a.lastStatus !== "error") continue;
    const key = `afail:${a.id}:${a.lastRunAt ?? ""}`;
    candidateKeys.add(key);
    if (acked.has(key) || inputs.active.overlay === "automation") continue;
    items.push({ key, tier: 1, kind: "automation-failure", label: a.name, detail: a.lastError ?? undefined, nav: { overlay: "automation" }, dismissible: true });
  }

  // ── tier 2: review-pending (the existing unread maps, promoted with context).
  for (const [workerId, unread] of Object.entries(inputs.attention)) {
    if (!unread || failedWorkers.has(workerId)) continue;
    const w = inputs.fleet[workerId];
    if (!w) continue;
    // Orphaned is recovery metadata, not actionable attention. A stale unread bit from an earlier
    // idle transition must not re-introduce it as a review item after excluding it from failures.
    if (w.status === "orphaned") continue;
    if (viewingWorker(workerId)) continue;
    items.push({ key: `wrev:${workerId}`, tier: 2, kind: "worker-review", label: w.label, detailKey: statusLabelKey(w.status), nav: { workerId }, dismissible: true });
  }
  for (const [sessionId, unread] of Object.entries(inputs.sessionAttention)) {
    if (!unread) continue;
    if (viewingSession(sessionId)) continue;
    items.push({ key: `srev:${sessionId}`, tier: 2, kind: "session-review", label: sessionLabel(sessionId), nav: { sessionId }, dismissible: true });
  }

  items.sort((a, b) => a.tier - b.tier);
  return { items, candidateKeys };
}
