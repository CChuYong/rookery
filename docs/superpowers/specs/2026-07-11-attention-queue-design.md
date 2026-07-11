# Attention Queue (헤더 벨) — Design

Date: 2026-07-11
Status: approved, ready for implementation
Branch: `feat/attention-queue` (desktop-only; independent of feat/worker-settled-trigger)

## Goal

A single ranked surface answering "지금 나를 기다리는 게 뭐지?" across the whole app. Today that signal is scattered: binary unread dots per worker (`attention`) / session (`sessionAttention`), inline interaction cards buried in transcripts, and automation failures visible only on the Automation page. The queue **aggregates and ranks** them behind a header bell with a badge; clicking an item navigates to it.

From the 2026-07-10 competitive analysis (attention-queue, 12점 F4/D4/I4). The sibling **durable approval inbox** (daemon-fed, restart-surviving, 11점 L) is a later promotion path — this design keeps that door open by isolating the item model + list rendering from the data source.

## Decisions (user-confirmed)

1. **Renderer-derived + local acks** — every needed signal already lives in the zustand store; the queue is a pure derived selector. Acks (dismissals) persist in localStorage (zustand `persist`, the established `rookery.*` convention). No daemon/protocol change. Failure items derive from DB-backed statuses (fleet/automation lists), so they survive reloads naturally; review-pending items are session-local like the dots they mirror.
2. **Header bell + popover** — badge count (tier-0 highlighted), click → ranked list popover, item click → navigate + close. No permanent layout claim; a dockable-pane surface can reuse the same list component later.

## Item model — 3 tiers

```ts
interface AttentionItem {
  key: string;      // stable identity for ack/dedupe (see per-kind formats below)
  tier: 0 | 1 | 2;  // 0 응답 대기(턴 블로킹) · 1 실패 · 2 리뷰 대기
  kind: "interaction" | "worker-failure" | "automation-failure" | "worker-review" | "session-review";
  title: string; subtitle?: string;
  nav: { sessionId?: string; workerId?: string; overlay?: "automation" };
  dismissible: boolean; // tier 0 = false (resolves itself), others = true
}
```

| tier | kind | source (all already in the store) | key | cleared by |
|---|---|---|---|---|
| 0 | `interaction` | unresolved `interaction` LogItems across `logsBySession`, gated by `liveInteractionIds` (stale/expired cards excluded) | `interaction:<requestId>` | resolving the card (derived → vanishes) |
| 1 | `worker-failure` | `fleet` rows with status `error/failed/orphaned` | `wfail:<workerId>:<status>` | dismiss (persisted ack) · row disappears/restores |
| 1 | `automation-failure` | `automations` rows with `lastStatus === "error"` | `afail:<id>:<lastRunAt>` | dismiss — **a NEW failure re-surfaces** (lastRunAt in the key) |
| 2 | `worker-review` | existing `attention` map (settled unseen) | `wrev:<workerId>` | opening it (existing select clears the map) · dismiss |
| 2 | `session-review` | existing `sessionAttention` map | `srev:<sessionId>` | opening it · dismiss |

Ordering: tier ascending; within a tier, stable source order (interactions by transcript order, fleet/automations by list order). No numeric scoring — tiers ARE the ranking.

Badge: tier-0 present → highlighted count (accent/urgent tone); else total count in muted tone; zero → no badge.

## Files

- `apps/desktop/src/renderer/lib/attention-queue.ts` — `buildAttentionItems(inputs, acked): AttentionItem[]` pure function (unit-tested). Inputs are narrow slices (logsBySession, liveInteractionIds, fleet, automations, attention, sessionAttention, sessions for labels).
- `apps/desktop/src/renderer/store/acks.ts` — persisted ack set (`rookery.acks`, version+migrate): `acked: string[]`, `ack(key)`, `prune(validKeys)` (called from the bell render path; also caps at 300 newest to bound localStorage).
- `apps/desktop/src/renderer/components/AttentionBell.tsx` — bell button + badge + popover (existing dismiss-transition idiom, Esc/outside-click close, aria). Renders grouped list; row click → `navigate` callback + close; X → ack.
- `App.tsx` — mount in the header next to the nav buttons; wire `navigate` (session select / worker select / automation overlay). Plus the **tier-0 OS notification**: when a fresh `interaction.request` arrives and the window is unfocused, fire the existing notification channel (parity with worker-status notifications).
- i18n `attentionBell` namespace ko/en.

## Edge cases

- Reconnect: `liveInteractionIds` resets and is re-seeded by the daemon's replay — expired cards (marked by the reducer) never enter the queue.
- A worker both failed AND unread: appears once as tier-1 `worker-failure` (tier-2 review entry for the same worker is suppressed — lower tier wins).
- Ack pruning: keys whose entity no longer exists (worker deleted, automation removed) are dropped from the persisted set opportunistically.
- The bell never renders items for the currently-viewed target (mirrors the dots' "not while looking" semantics — e.g. an interaction in the active session is excluded; you're already there).

## Testing

- `attention-queue` derive: tier placement + ordering; ack filtering; automation re-failure re-surfacing; interaction resolved/expired exclusion; failed-worker suppresses its review item; active-target exclusion.
- `acks` store: persist round-trip, prune, cap.
- `AttentionBell`: badge counts (tier-0 highlight), group rendering, click → nav callback + close, dismiss → ack, empty state.

## Out of scope

Daemon-fed durable inbox (promotion path), stuck/background-too-long warnings (needs new signals), Slack surface, OS notification preferences UI.
