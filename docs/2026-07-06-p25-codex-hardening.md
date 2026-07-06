# 2026-07-06 — P2.5: Codex hardening & finish (spec)

> Status: **implemented 2026-07-06** — Track A (argv-token → per-session `CODEX_HOME` `config.toml`), Track B (per-turn inactivity watchdog), Track C (slack-thread defs + `slackProvider`), Track D (desktop new-session provider selector + `codexMasterModel`) all landed. Live smoke (controller): a real codex master turn with the bridge token present ONLY in `config.toml` (child argv verified clean) still round-tripped a bridge tool call. Remaining: automation-origin codex (P3), persistent child pool (item 5, out of scope by user decision).

Follow-up to P2 (`docs/2026-07-06-p2-codex-master.md`). Scope = the P2 final-review backlog. User decision: **items 1,2,3,4,6,7 IN; item 5 (persistent child pool) OUT.**

## Scope

| # | Backlog item | Decision |
|---|---|---|
| 1 | argv bridge-token exposure → CODEX_HOME config.toml | **IN** — Track A (live-spiked) |
| 2 | Desktop: new-session provider selector + `codexMasterModel` field | **IN** — Track D |
| 3 | maxTurns inert on codex masters — UI treatment | **DISSOLVED (no-op)** — renderer map found NO session-level maxTurns in the renderer or protocol (`session.send` carries only model/effort/permissionMode); the only maxTurns UI is automation-level (worker-action-only). Nothing to hide. Also: codex genuinely supports effort (low..xhigh), so the effort select is correct for codex too — no special-casing. |
| 4 | Turn watchdog (bridge-stall / wedged turn) | **IN** — Track B |
| 5 | Persistent per-session child pool | **OUT** (user) |
| 6 | Bridge release placement + CODEX_HOME cleanup on delete | **IN** — folded into Track A |
| 7 | Per-source overlays for codex + slack/automation codex origin | **PARTIAL** — Track C: slack-thread as defs + `slackProvider` setting; **automation-origin-codex DEFERRED to P3** (unattended bypassPermissions + bridge wants separate review; the session-provider plumbing is already there, only the config/UI surface is deferred) |

## Track A — bridge token out of argv (security)

**Problem (P2 review I3):** the bridge URL (with its 122-bit token) rides the per-turn child's argv (`-c mcp_servers.rookery.url="…"`). On multi-user Linux `/proc/<pid>/cmdline` is world-readable, so another local user can harvest the live token during a turn and call the master's fleet tools (= code exec as the daemon user). macOS unaffected; single-user dev machines not reachable; but it bypasses the ws-token's 0600-file threat model.

**Fix (live-spiked, `.superpowers/sdd/probe-authlink.mjs`):** move the URL from argv into a **per-session rookery-managed CODEX_HOME** `config.toml` (file mode 0600), and drop the `-c` arg. Spike confirmed: a rookery CODEX_HOME containing `config.toml` with `[mcp_servers.rookery] url = "…"` + a symlinked `auth.json` → the model authenticates AND calls the bridge tool, with **zero token in argv**.

Design:
- **Per-session CODEX_HOME**: `<config.home>/codex-homes/<sessionKey>/` (dir 0700). Rollouts persist here → resume works across the session's turns.
- **config.toml** (0600): starts from the user's `~/.codex/config.toml` content **if it exists** (preserves `model_providers`/`base_url`/custom settings — otherwise a minimal rookery config would silently drop them), then appends/overrides the `[mcp_servers.rookery]` block with the bridge URL. Rewritten each turn via `ensureSession` (the token is stable per session, but the block write is idempotent; the copy is refreshed so user config edits propagate on the next turn — documented: a user config change lands on the session's next turn).
- **auth.json**: when no in-app `codexApiKey` → **symlink** `~/.codex/auth.json` into the per-session home (read-through to the user's `codex login`); when a key IS set → the existing provisioning (`account/login/start`) writes `auth.json` into this same per-session home (subsumes P1.5's single shared `codex-home`).
- **Seam**: the daemon-side `bridge.ensureSession` closure (server.ts) becomes responsible for materializing the per-session CODEX_HOME (write config.toml + auth link) and returns `{ codexHome }` instead of `{ url }`. `CodexBackendDeps.bridge.ensureSession(key, defs)` → `{ codexHome: string }`; `CodexTurnStream` spawns with `env: { ...baseEnv, CODEX_HOME: codexHome }` and **no `-c` arg**. Workers are unchanged (no bridge; codexApiKey CODEX_HOME as in P1.5).
- **Cleanup (item 6)**: on `session.delete`, `bridge.release(id)` AND `rm -rf <codex-homes>/<id>`. Move the release call out of the Connection handler into the SessionManager delete path (or a server.ts-provided `onDelete` hook) so a future second delete caller can't leak. Best-effort, never throws.
- **Residual**: the token still transits `config.toml` on disk (0600, owner-only) — strictly better than world-readable argv. Non-loopback bind (`ROOKERY_HOST`) still exposes the bridge on the network to URL-token holders — add one line to the existing plaintext-token warning.

## Track B — turn watchdog

**Problem (P2 review residual):** if the bridge is unreachable mid-turn (or any turn wedges), codex's rmcp client can silently stall — `item/started` fires, the `tools/call` never completes, no `turn/completed`. Today only a manual stop recovers; masters have no fork-style timeout.

**Fix:** a per-turn **inactivity watchdog** in the shared `CodexSessionBase` turn loop: a timer armed on `turn/start`, reset on every inbound notification (any event = progress), fires after `TURN_IDLE_TIMEOUT_MS` (default 120_000, generous — a real tool call or model step emits events well within it) of total silence → `turn/interrupt` (graceful) then, if no `turn/completed` within a short grace, `client.close()` (kill) and fail the stream with a clear notice (`notice.codexTurnTimeout`, i18n ko+en both catalogs). Applies to BOTH worker and master turns (workers can wedge on a hung MCP too if ever configured; harmless otherwise). Configurable via a settings value `codexTurnIdleTimeoutMs` (default 120000; 0 disables). Interrupt/abort/normal-completion all disarm the timer.

## Track C — slack-thread as defs + slackProvider (partial item 7)

- **slack-thread as defs**: `src/tools/slack-thread-tools.ts` gains `slackThreadToolDefs(reader, channel, threadTs): SdkMcpToolDefinition[]` (extract the existing `tool()` — `readThreadImpl` is already factored out); `createSlackThreadToolsServer` wraps it (byte-parity, like schedule in P2). `makeSlackCapabilities` (server.ts overlay) provides it via the `caps.toolDefs` channel (P2 added `TurnCapabilities.toolDefs`) so a **codex** slack session gets `read_thread` over the bridge; claude still gets it wrapped. The system-prompt hint rides `systemPromptAppend` as today.
- **slackProvider setting**: `settings.slackProvider(): "claude" | "codex"` (default "claude"). `getOrCreateByKey` (used by the slack path) gains an optional provider; the slack handler passes `settings.slackProvider()`. A codex slack session is a codex master → gets the bridge + read_thread def + AskUserQuestion (canUseTool exists for slack). ⚠️ codex masters are bypassPermissions-only (P2 guard) — slack codex sessions inherit that; a non-bypass slack config would fail at turn start. Document.
- **Deferred (P3)**: automation-origin codex (the automation action config gaining `provider`) — automations are unattended bypassPermissions; codex-over-bridge under full automation wants its own review. The session-provider routing is already provider-agnostic, so only the automation config/DB/UI surface is deferred.

## Track D — desktop (item 2)

(Anchors from the renderer exploration — see the plan for exact file:line.)
1. **New-session provider selector**: `NewSessionPage.tsx` (full-page form, `onStart({cwd,prompt,model,effort})` → `startSession` in App.tsx builds `session.create`) gets a `claude | codex` selector (WorkerSpawnModal idiom: default claude → wire-omit `provider`; codex swaps the model field to free-text with `settings.codexMasterModel` placeholder). App's `startSession` sends `provider` on `session.create` and, for codex, stamps the codex model as the override (not the Claude picker's). The selector lives in the Composer `leftSlot`/controls area.
2. **`codexMasterModel` settings field**: 3-line copy beside `codexWorkerModel` in `SettingsPage.tsx` Codex section (`f.codexMasterModel ?? ""`, placeholder gpt-5.5). Daemon setting + protocol key already exist (P2); the 5 `SettingsValues` fixtures ALREADY carry `codexMasterModel` (P2) → no fixture edits. i18n: mirror `settings.codexWorkerModel`/Hint keys, ko+en.
3. **Store provider type**: add `provider?: string` to the inline session-row type at `store.ts:16` (data already flows from `session.list`; only the type is missing). Enables an optional codex badge on the session row/header via the existing `ProviderBadge`.
- item 3 (maxTurns hide): DISSOLVED — no session-level maxTurns UI exists (see scope table).

## Non-goals (unchanged)

Persistent child pool (item 5), automation-origin codex (P3), non-bypass codex masters, `plan` analog, nested-subagent panels, bearer-header bridge auth (0600 config.toml + loopback suffices).

**Known limitation (RESOLVED in P3 — see `docs/2026-07-06-p3-codex-fork-automation.md`):** codex master session **fork** was guarded here (Track A moved codex master turns to a per-session `CODEX_HOME`, so the ephemeral fork child on the SHARED home couldn't see the source thread). **P3 removed the guard and made fork work** — it runs `thread/fork` in the source session's per-session home and seeds the new session's home by copying the source `sessions/` rollout tree (the forked rollout is a parent-referencing delta, so the whole tree is copied; live-verified). Codex **worker** fork was always unaffected.

## Testing

- Track A: unit — `ensureSession` materializes CODEX_HOME (config.toml 0600 with the mcp block, auth symlink when no key, user-config preserved when present); CodexTurnStream spawns with `CODEX_HOME` env and no `-c` arg; delete removes the dir + releases the bridge. Live smoke (controller): a real codex master turn with the token ONLY in config.toml (grep the child argv = clean) still calls a bridge tool.
- Track B: fake-codex "silent turn" (emits `item/started`, never `turn/completed`) → watchdog interrupts + fails with the timeout notice within the (test-shortened) budget; a normally-progressing turn never trips; interrupt/abort disarm.
- Track C: slackThreadToolDefs name/shape; makeSlackCapabilities surfaces read_thread via toolDefs for a codex session (fake); slackProvider setting default/override; getOrCreateByKey passes provider.
- Track D: renderer component tests per conventions; dual gates.

## Risks

- Track A user-config copy: if the user edits `~/.codex/config.toml` mid-session, the change lands on the session's next turn (config is re-materialized per ensureSession) — benign, documented. A malformed user config.toml could break codex master turns — wrap the read in try/catch and fall back to a minimal rookery config (mcp block only) + a transcript notice.
- Track B watchdog false-positive: 120s of TOTAL silence is well beyond normal model/tool cadence; the timer resets on ANY event. A genuinely long single tool (>120s with no output delta) could trip — mitigate by resetting on `outputDelta` too, and make it configurable (0 disables).
- Track C slack codex: bypassPermissions-only guard means a mis-set slack permission fails the turn — document; slackProvider defaults claude so opt-in.
