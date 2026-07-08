# Cross-provider fork (provider handoff) — Design

> Strategic bet #1 from the 2026-07-08 Codex↔Claude interop exploration ([[codex-claude-interop]]). Today `fork` copies a session/worker onto the **same** provider (SDK `forkSession` / codex `thread/fork`). This adds forking onto the **other** provider — "I've been on Claude, continue this conversation on Codex" (and vice-versa). The [[codex-parity-audit]] auth probe (shipped `feat/codex-auth-probe`) is the prerequisite that gates "Fork to Codex" on codex being authenticated.

## Intent (decided)

- **Use case: provider handoff / switch**, not A/B compare. The fork continues the conversation on the new backend; the original is left untouched (a record the user can archive/delete manually).
- **Scope: masters AND workers.**
- **Context fidelity: full verbatim transcript**, size-capped (newest-first, like `formatTranscript`).
- **Seed durability: baked into the target's turn-1 conversation** (see below), not re-injected every turn.
- **Model/effort: chosen in a Fork dialog** (the right-click "Fork" is promoted from an instant action to a modal).

## Why native fork can't cross providers

`fork` relies on a provider-native resume handle: Claude's `sdk_session_id` (SDK `forkSession`) or Codex's thread rollout (`thread/fork` + rollout-tree copy). **A handle from one provider cannot be resumed by the other.** Codex's `thread/start` also has **no "seed prior messages" parameter** (`cwd/model/approvalPolicy/sandbox/developerInstructions` only). So a cross-provider fork must start a **fresh** target session/worker with **no native handle** and carry context by other means.

## Core mechanism — "fork variant + seed baked into turn 1"

A cross-provider fork reuses **all** of the existing fork machinery (`SessionManager.fork` / `FleetOrchestrator.fork` — new session/worker, `copy*Events` for UI history, and for workers the new-worktree checkpoint-snapshot overlay) with exactly **two** changes:

1. **`provider = target`** (not inherited from the source), and the **native `forkSession` call is skipped** (no handle to copy) → the new session/worker starts with `sdk_session_id = null`.
2. A **pending-seed marker** is set. On the user's **first turn** in the target, the source transcript is prepended to the **provider prompt only** (not the UI echo), so it becomes part of the target's **turn-1 user message** — and therefore part of the target's native conversation, replayed on every subsequent resume.

### What "baked into turn 1" means concretely

A provider stores a conversation as a turn sequence `[user→assistant, user→assistant, …]` and replays it on resume. A fresh target has an empty sequence. We make the prior transcript part of **turn-1's user message**:

```
turn1 user  = "<fenced prior transcript>\n\n<the user's actual first message>"
turn1 asst  = …
turn2 user  = …
```

Because the transcript lives inside turn-1 (a real conversation turn), every future resume replays it for free — one write, durable. This is strictly more durable than putting it in turn-1's *system prompt* (which is re-assembled each turn and is not part of the replayed message history, so it would be "forgotten" after turn 1).

**Invisible in chat:** the master already sends `userText` to the backend AND echoes `userText` to the UI at separate call sites (`master-agent.ts` `doTurn`: echo at the `addMessage`/`persistEvent`/`bus.emit` block, send at `backend.startTurn(userText, …)`). We compute a separate `promptText = seed + userText` for the backend while echoing only `userText`. Combined with the `copy*Events` history bubbles rendered above, the target reads as a seamless continuation. Codex is identical (`turn/start({ text: promptText })`).

## Components / units

### U1 — Handoff seed builder (`src/core/handoff.ts`)
`buildHandoffSeed(events, sourceProvider, maxBytes): string` — flattens copied transcript events (master `session_events` or worker `worker_events`) newest-first within a byte cap (same discipline as `fleet-tools.ts formatTranscript`), wrapped in a fence:
```
<prior-conversation from="claude">
… capped transcript …
</prior-conversation>
You are continuing the above conversation, which happened on a different assistant backend. Treat it as your own prior context. The user's next message follows.
```
Pure, unit-testable. Rendering of tool/thinking events → compact text lines (best-effort; the goal is context, not perfect replay).

### U2 — Core fork extension (masters: `SessionManager.fork`; workers: `FleetOrchestrator.fork`)
Both grow an optional `target?: { provider?: string; model?: string; effort?: string }`:
- **`target.provider` absent or === source provider →** current native fork, unchanged (backward compatible).
- **`target.provider !== source provider` → handoff path:** create the new session/worker with `provider = target.provider` (+ `model`/`effort` when supplied), `copy*Events`, set `handoff_from_provider = <sourceProvider>`, **do not** call `forkSession`, **do not** set `sdk_session_id`. Workers still do the worktree checkpoint→snapshot overlay (same as native fork — source untouched, new worktree). The new entry is registered lazy-resumable/idle exactly like today, just with no `resumeSessionId`.
- **Codex target specifics:** none needed for the home — the per-session `CODEX_HOME` is materialized lazily on the first turn by `bridge.ensureSession` (same as any fresh codex master); `seedCodexHomeFromSource` is **not** used (that's native codex-fork only). A codex **master** target runs bypassPermissions (the existing codex-master constraint; the fork creates a fresh session whose default permission mode is bypass).

### U3 — First-turn seed injection + marker clear
- **Master (`master-agent.ts` `doTurn`):** at the very start (before the user-echo), if `repos.getSession(id).handoff_from_provider` is set, build the seed from the copied `session_events` and set `promptText = seed + "\n\n" + userText`; echo only `userText`; `startTurn(promptText, …)`. After the turn completes (once `sdk_session_id` is assigned), clear `handoff_from_provider`. Build the seed **before** appending the current user echo so it isn't included in its own seed.
- **Worker (`worker.ts`):** the symmetric injection on the worker's first turn (materialize/first-send). Build from copied `worker_events`; echo only the user text (the existing deferred-echo path is unchanged); clear the marker after the first turn.

### U4 — Data model (append-only migrations)
- `sessions.handoff_from_provider TEXT` (nullable) — non-null ⇒ seed pending; its value is the source provider name (for the fence `from="…"`). Cleared to null after the first turn injects.
- `workers.handoff_from_provider TEXT` (nullable) — same, for worker handoff.
- `Repositories`: `setSessionHandoffFrom(id, provider|null)` + `setWorkerHandoffFrom(id, provider|null)`; the existing `getSession`/`getWorker` rows expose the column.

### U5 — Protocol
- `session.fork` gains optional `provider?`, `model?`, `effort?` (absent = today's same-provider fork).
- `worker.fork` gains the same optional fields.
- Connection passes them through to `sessions.fork(id, target)` / `fleet.fork(id, target)`. Responses unchanged (`session.created` / `fleet.spawn.result`).

### U6 — Fork dialog (desktop)
The right-click "Fork" opens a modal (replacing the instant fork) — one component parameterized for master vs worker:
- Source summary + **target provider** toggle (default = the *other* provider) + **model/effort** pickers (reuse the Claude models list + codex catalog + effort selector already used by WorkerSpawnModal / NewSessionPage).
- **Auth-probe tie-in:** when target = codex and the store's `codexAuthStatus` is not `ready` (or `"unavailable"`), show a warning and disable the Fork button (with a link to Settings → Codex). This is the concrete payoff of `feat/codex-auth-probe`.
- Same-provider selection routes to the native fork (no seed); cross-provider routes to the handoff path.
- New i18n keys (ko/en) for the dialog + the codex-not-ready warning.

## Data flow (master, claude → codex)

1. User right-clicks a Claude session → **Fork dialog** → picks Codex + a model → Fork.
2. `session.fork {provider:"codex", model}` → `SessionManager.fork` handoff path: new codex session, `copySessionEvents`, `handoff_from_provider="claude"`, no `sdk_session_id`. Client navigates to it; it shows the copied history (read-only) + a "(→ codex)" label.
3. User types their first message. `doTurn`: seed built from copied events → `startTurn(seed + text)` on the codex backend (first turn materializes the per-session CODEX_HOME + `thread/start`); UI echoes only `text`. Turn completes → `sdk_session_id` (codex thread id) set, `handoff_from_provider` cleared.
4. Subsequent turns resume the codex thread normally; the baked transcript rides along in turn-1 on every replay.

Worker flow is identical except the new worktree is snapshot-overlaid from the source (existing fork behavior) and injection happens on the worker's first turn.

## Error handling / edge cases

- **No transcript to hand off:** source has no completed turn / no events → reject (`"nothing to hand off — this session has no conversation yet"`). (Native fork already requires `sdk_session_id`; handoff requires copied events.)
- **Codex target not authenticated:** dialog warns + disables (U6); if somehow attempted, the first turn fails via the existing codex auth/turn error handling (no special path).
- **Seed cap overflow:** oldest events truncated (newest-first fill), with a `…(N older events truncated)` marker — same as `formatTranscript`.
- **Restart between fork and first turn:** the marker + copied events are persisted, so the seed is rebuilt on the first post-restart turn (no in-memory-only state).
- **Marker set but first turn aborted/failed before `sdk_session_id`:** marker stays set → the next attempt re-injects (idempotent; the seed is rebuilt from the still-unchanged copied events). Safe because clearing is tied to a successful first turn.
- **Source untouched:** never auto-archived/stopped/deleted (decided). Worker source keeps its own worktree (the handoff made a separate snapshot worktree).

## Testing

- **U1** `buildHandoffSeed`: newest-first cap + truncation marker + fence with the source provider; empty events → minimal/empty.
- **U2** master handoff: claude→codex fork → new session `provider="codex"`, `sdk_session_id` null, events copied, `handoff_from_provider="claude"`; same-provider target → native `forkSession` path still taken (no marker). Worker handoff: worktree snapshot carried + `provider` swapped + marker set + no `resumeSessionId`.
- **U3** first-turn injection: with the marker set, `backend.startTurn` receives `seed + userText` while the persisted/echoed user event is `userText` only; marker cleared after the turn; a second turn sends `userText` alone. Abort-before-completion leaves the marker set.
- **U5** protocol: `session.fork`/`worker.fork` with `provider/model/effort` reach the core with those values; without them, unchanged.
- **U6** dialog (desktop): provider/model/effort selection; codex-not-ready (`codexAuthStatus` null/`"unavailable"`/`ready:false`) disables Fork with the warning; same-provider selection calls fork without a `provider` override. i18n parity.

## Out of scope (later)

- A/B compare (keeping both sessions live side-by-side for the same next prompt).
- LLM-summary handoff (compact alternative to verbatim).
- Forking automations, or cross-provider fork of Slack-origin sessions (read-only in the UI anyway).
- Perfect tool/thinking-event replay fidelity (seed is best-effort text).
