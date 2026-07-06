# 2026-07-06 — P3: codex master fork + automation-origin codex (spec)

> Status: **implemented 2026-07-06.** Live smoke (controller): a real codex master session ran a turn storing a fact, was forked via `SessionManager.fork` → the fork's `CODEX_HOME` was seeded from the source session's `sessions/` rollout tree → a turn on the fork recalled the stored fact, confirming context was preserved through the real fork + seeding stack (not just the earlier spike script). The P2.5 fork guard (`docs/2026-07-06-p25-codex-hardening.md`'s "codex master session fork is not supported yet") is removed — fork now routes to the codex fork-and-seed path instead of throwing.

The two bundled P3 backlog items (user pick): **#1 make codex master session fork actually work** (P2.5 guarded it with a not-supported error) + **#8 let automations run on codex** (deferred from P2.5). Both touch the session-provider seam.

## Track A — codex master fork (#1)

### Problem
P2.5 moved codex master turns into a **per-session `CODEX_HOME`** (`~/.rookery/codex-homes/<sessionId>/`) where the thread's rollout files live (needed for `thread/resume` across turns). But `SessionManager.fork` → the `forkSession(provider, sdkSessionId)` router routes codex to `CodexBackend.forkSession`, whose ephemeral child spawns with the SHARED home (`deps.env`) — so `thread/fork` can't find the source thread. P2.5 shipped a clean guard; this makes it work.

### Live-spiked mechanism (`.superpowers/sdd/probe-fork-home2.mjs`)
- `thread/fork` writes the forked thread's rollout into the CODEX_HOME the fork child runs in.
- The **forked rollout is a delta that references the parent** — copying just that one file into another home resumes the thread but **loses conversation context** (verified: empty answer).
- Copying the **entire `sessions/` tree** (parent + forked rollouts) into the new home → `thread/resume` works **and context is preserved** (verified: the forked+resumed model recalled "MANGO").

### Design
Codex fork = run `thread/fork` in the SOURCE session's home, then seed the NEW session's home with a copy of the source home's `sessions/` tree.

- **Widen `ForkFn`**: `(provider, sdkSessionId, opts?: { title?; sourceSessionId?; newSessionId? }) => Promise<{ sessionId }>`. The claude router ignores the new opts; the codex router uses them.
- **`SessionManager.fork` restructure**: generate `newId = this.idgen()` FIRST, then `forkSession(provider, row.sdk_session_id, { title, sourceSessionId: sessionId, newSessionId: newId })`; then `createSession({ id: newId, ..., provider })` (inherit source provider — already the case), `setSdkSessionId(newId, forkedUuid)`, `copySessionEvents` (rookery transcript, unchanged). Remove the P2.5 codex guard.
- **Codex fork router (daemon, server.ts)**: a `forkCodexSession(sourceSessionId, newSessionId, sourceThreadId, title)` helper (in server.ts or codex-home.ts):
  1. locate `sourceHome = <home>/codex-homes/<sourceSessionId>` (must exist — fork requires a completed turn); if absent → throw a clear error.
  2. `CodexBackend.forkSession(sourceThreadId, { env: { CODEX_HOME: sourceHome } })` — widen `forkSession` to accept an optional env override so the ephemeral child runs in the source home. Returns `forkedUuid` (forked rollout now in `sourceHome/sessions/`).
  3. seed the new home: `mkdirSync(<home>/codex-homes/<newSessionId>, {recursive})` then `cpSync(sourceHome/sessions, newHome/sessions, {recursive})` (the whole tree, so parent+forked rollouts are present).
  4. return `{ sessionId: forkedUuid }`.
  The new home's `config.toml`/`auth` are added lazily at the new session's first turn by `materializeCodexHome` (which only writes config.toml+auth, never touches `sessions/`, so the pre-seeded rollouts survive). Layering: all CODEX_HOME/fs knowledge stays in the daemon router; `SessionManager` only passes ids.
- **`CodexBackend.forkSession(threadId, opts?: { env? })`**: spread the env override into the ephemeral child spawn (defaults to `deps.env?.()` when absent — worker/claude paths unchanged).
- Edge: source home missing (e.g. a codex session whose home was GC'd) → clear error, fork rejected (no corruption). Non-codex fork unchanged.

## Track B — automation-origin codex (#8)

### Problem
Automations (cron/slack-event triggers → master/worker actions) always create claude sessions/workers; P2.5 deferred codex here because automations run unattended `bypassPermissions`. The session-provider routing is already provider-agnostic (P2 masters, P1 workers) — only the automation config surface was missing.

### Design
- **Migration (append-only)**: `ALTER TABLE automations ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`.
- **Types + CRUD** (`repositories.ts`): `Automation`/`AutomationInput` gain `provider: string` (default "claude"); read/write paths carry it (mirror `model`/`effort`/`permission_mode`).
- **Protocol** (`messages.ts`): `automationInputSchema` gains `provider: z.enum(["claude","codex"]).optional()` (default claude on create).
- **Action** (`automation-action.ts`): the **master** action passes `provider` to session creation — `getOrCreateByKey("automation:"+id, cwd, a.provider)` (reuse) / `create(cwd, { origin, originRef, provider })` (fresh); the **worker** action passes `provider` to `fleet.spawn({ ..., provider: a.provider })` (fleet already supports it, P1). Self-wakeup (`targetSessionId`) reuses the existing session as-is (provider already fixed) — no change. `provider` is a creation attribute, NOT a turn override (do not add it to the `opts` passed to `runTurn`).
- **Desktop AutomationForm**: a `claude | codex` selector (mirror the worker-spawn provider select), wired into the automation create/update payload; default claude.
- ⚠️ **bypassPermissions-only**: codex masters reject non-bypass permission modes at turn start (P2 guard). An automation with `provider:"codex"` + a non-bypass `permission_mode` will fail its run with a clear error (surfaced in `last_error`/status). Automations default to bypass, so this is only a mis-config. Document. Codex workers are unaffected (workers aren't bypass-guarded).
- ⚠️ **Unattended cost**: a codex automation master spins a per-turn child + bridge, unattended — same trust posture as any automation (already `bypassPermissions`, no budget guard beyond `max_turns`). No NEW risk vs a claude automation; the bridge is loopback+token. Note it.

## Non-goals

Persistent child pool; the other P3 hardening items (#2 handshake timeout, #3 delete-hook relocation, #4 sub-table strip, #6 desktop fields for the two settings, #7 orphan GC); Claude cost audit. Automations selecting a codex MASTER model (they use the global `codexMasterModel`; a per-automation codex model can piggyback on the existing `model` column — the `model` field already flows to runTurn/spawn as an override, so it works for codex too with no extra work; verify).

## Testing

- Track A: unit — widened ForkFn signature; codex fork router seeds new home from source `sessions/` (temp-dir fs test: create a fake source home with a sessions/ tree → fork → new home has the copied tree); `CodexBackend.forkSession` env override reaches the spawn; `SessionManager.fork` for codex generates newId first, calls the router, inherits provider, removes the guard (the P2.5 guard test flips to an expect-success with a fake forkSession). Live smoke (controller): a real codex master session, run a turn (store a fact), fork it, run a turn on the fork recalling the fact → context preserved (the spike, through the real stack).
- Track B: migration + Automation provider round-trip (default claude); automationInputSchema accepts provider; automation-action master/worker pass provider to create/spawn (recording fakes); dual gates for the protocol/desktop change (AutomationForm fixture/test). A codex automation whose action is master reuses on the codex backend (fake backend records).

## Risks
- Fork rollout copy size: `sessions/` for one session is small (a few JSONL files); `cpSync` is fine. If a session accumulates many turns the tree grows — acceptable (bounded by one session's history).
- The forked rollout in the SOURCE home (step 2) is a harmless artifact of the source session (it shares the tree we copy). No cleanup needed; it rides the source session's home lifecycle.
- Automation codex + slackProvider codex both now exist — a slack-triggered automation is still claude unless the automation itself is codex (automation provider is independent of slackProvider; document the precedence: automation.provider wins for automation-created sessions).
