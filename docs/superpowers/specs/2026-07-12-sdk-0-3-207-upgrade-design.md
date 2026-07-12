# SDK 0.3.195 → 0.3.207 Upgrade + Feature Adoption — Design

Date: 2026-07-12
Status: approved (user, 2026-07-12)

## Goal

Bump `@anthropic-ai/claude-agent-sdk` from 0.3.195 (locked) to 0.3.207 and adopt the
new SDK capabilities that improve rookery's worker fleet: terminal_reason consumption,
level-based background-task tracking, interrupt receipts, and (exploratory) depth-2+
nested agent trees.

## Changelog analysis (0.3.196–0.3.207) — what matters to rookery

| Version | Change | Impact on rookery |
|---|---|---|
| 0.3.207 | `canUseTool` returning `{behavior:'allow'}` without `updatedInput` no longer rejected as deny | **Beneficiary**: `interaction-registry.ts:66` returns exactly this shape (Slack tool approvals) |
| 0.3.206 | `command_lifecycle` frames added | Unknown top-level types are silently ignored by `translate()` — safe; not consumed |
| 0.3.205 | `Query.interrupt()` returns typed receipt with `still_queued` | Adopted (Phase 2-C) |
| 0.3.204 | New `terminal_reason` values (`api_error`, `budget_exhausted`, `malformed_tool_use_exhausted`, `structured_output_retry_exhausted`, `tool_deferred_unavailable`, `turn_setup_failed`); exhausted-retry turns no longer report `completed` | Adopted (Phase 2-A); behavior change to watch in live e2e |
| 0.3.203 | `background_tasks_changed` system message (full live-task set per membership change) | **Required handling**: unknown system subtypes leak into transcripts as `system_text` rows (same as the old `task_progress` leak). Drop in Phase 1, consume in Phase 2-B |
| 0.3.203 | stable `sdk.d.ts` unresolved type refs fixed | Typecheck stability |
| 0.3.202 | `parent_agent_id` on subagent session messages | Adopted exploratorily (Phase 2-D) |
| 0.3.200 | `set_model` rejects unrecognized model strings | Bad model strings from resolvers now fail explicitly |
| 0.3.198 | Runtime warning when `canUseTool` + `allowedTools`/`bypassPermissions` coexist | rookery masters use exactly this combo — verify where the warning lands and that AskUserQuestion/Slack approvals still work |
| 0.3.198 | `isSynthetic` → `isMeta` mapping fix | SDK-internal; no rookery references |
| 0.3.196 | tool-use ID dedup no longer drops after 1000 resolutions | **Beneficiary**: long-lived daemon sessions |

## Approach (decided: two-phase, bump-first)

Phase 1 lands the bump with minimal compat changes and its own live verification, so
any regression found later attributes cleanly to either the SDK behavior change or our
feature work. Phase 2 adopts features in four independent commits. Alternative
(single combined wave) rejected: the 0.3.204 termination-classification change and our
terminal_reason refactor would be indistinguishable when debugging.

## Phase 1 — bump + minimal compat (1 commit)

- `package.json` → `^0.3.207`, `npm install` under Node 22.
- `claude-backend.ts translate()`: add `background_tasks_changed` to the task-frame
  subtype branch and **drop it** (no event) — prevents `system_text` transcript noise.
  Phase 2-B replaces the drop with consumption.
- Verify the 0.3.198 warning path live: where does the canUseTool+bypassPermissions
  warning surface (stderr vs stream system message)? If it lands in the stream, decide
  drop-vs-surface. Confirm AskUserQuestion + Slack approval flows still work, and that
  the `{behavior:"allow"}` (no `updatedInput`) path benefits from the 0.3.207 fix.
- Gates: `npm run typecheck && npm test`, desktop typecheck + test, live smoke
  (daemon boot → master turn → worker spawn/stop).

## Phase 2-A — terminal_reason consumption (1 commit)

Today `turn_end.terminalReason` is decoded (`claude-backend.ts:124`) and discarded.

- Add `terminalReason?: string` to the worker `result` event (`src/core/events.ts:10`)
  → `worker.ts` passes it through at turn_end → persisted naturally in `worker_events`.
- Dead-turn reasons (`api_error`, `budget_exhausted`, `malformed_tool_use_exhausted`,
  `structured_output_retry_exhausted`, `tool_deferred_unavailable`, `turn_setup_failed`)
  additionally record a structured **notice** (new `notice.*` code in BOTH the daemon
  catalog `src/core/i18n.ts` and the desktop renderer catalog, matching param names).
- Desktop transcript metrics line shows terminalReason when present.
- **No state-transition changes**: the stream stays alive and can take follow-ups, so
  worker state is untouched; the worker-settled trigger's failure bucket stays
  status-based. This phase only enriches the recorded *reason*.
- Master side: out of scope (master turn_end handling unchanged) — keeps the commit
  narrow; can be a follow-up if desired.

## Phase 2-B — level-based background-task tracking (1 commit)

- New `AgentEvent` kind: `{ kind: "background_tasks", taskIds: string[] }` mapped from
  the `background_tasks_changed` system message in `translate()` (replacing Phase 1's
  drop).
- `worker.ts`: on snapshot, **replace** the `bgTasks` set wholesale. The existing
  settle-grace rule applies identically: last task gone + `!turnActive` →
  `armIdleGrace()`; otherwise `reconcile()`.
- Edge frames (`task_started`/`task_updated`/`task_notification`) **remain handled** —
  the snapshot is authoritative and set-replacement always wins regardless of frame
  ordering; edges are a compatibility aid (finite fakes, potential older servers).
- Live probe first (reuse `probe-turn-lifecycle.mjs` approach) to confirm the actual
  frame shape/timing; add snapshot frames to fake-query test scripts.

**Refinement (implementation):** per SDK guidance ("do not correlate the level with
the edge stream"), the worker latches to level-only mode on the first snapshot
instead of merging both signals — a `bgLevel` flag flips true on the first
`background_tasks` event, and the edge branch (`background_task`) is skipped
entirely once latched, rather than continuing to process edge frames alongside
snapshots.

## Phase 2-C — interrupt receipt (1 commit)

- `AgentStream.interrupt()` return widens to `Promise<InterruptReceipt | undefined>`
  with `InterruptReceipt = { stillQueued: string[] }`. `ClaudeStream` maps the SDK's
  typed receipt; the Codex backend keeps returning `undefined`.
- `Worker.interruptTurn()` records a notice when `stillQueued` is non-empty;
  `interrupt_worker` (fleet-tools) includes "N queued messages will still run" in its
  result text → better master-side interrupt→send redirect decisions.
- Explicit boundary: the worker's `deferred` FIFO is OUR layer's queue; `still_queued`
  is the SDK's internal queue. They are distinct and must not be conflated (the
  interrupt path already drops `deferred` entries with their own notice —
  `worker.ts:273`).

## Phase 2-D — parent_agent_id nested trees (1 commit, exploratory)

- Changelog wording says "disk-persisted metadata", so **probe first**: drive a worker
  to spawn a depth-2 subagent (Task inside Task) and check whether live stream messages
  carry `parent_agent_id`.
- If present live: pass through in `translate()` → add `agentId`/`parentAgentId` to
  `worker.nested` events → desktop `NestedAgents` panel groups as a tree instead of a
  flat `parentToolUseId`-keyed list.
- **Fallback (explicit)**: if the field is disk-only, do not implement; record the
  limitation in this spec's addendum and close the phase as investigated-not-adopted.

## Verification & branch strategy

- One branch (`sdk-0.3.207`), one commit per phase, FF-merge to main at the end
  (repo convention, including the commit trailer convention).
- Per-phase gates: `npm run typecheck && npm test`; phases touching renderer-consumed
  types (`notice.*` codes, worker event shapes) also run
  `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- Live e2e twice: after Phase 1 (observe pure SDK behavior changes) and after Phase 2
  (full flow: spawn → bg task → interrupt → settle → worker-settled trigger).
- Known risk to watch live: 0.3.204 reclassifies previously-`completed` dead turns —
  confirm worker settle paths and the worker-settled trigger buckets behave as before.

## Out of scope

- `command_lifecycle` consumption (0.3.206) — concept overlaps the worker's deferred
  echo, but no consumer need today.
- `canUseTool` `requestId`/`null` suppression (0.3.199) — useful for out-of-band Slack
  button approvals later; not now.
- Sandbox credential masking, workflow_agent `blocked` (0.3.199) — unused surfaces.
- Master-side terminal_reason surfacing (see Phase 2-A).
