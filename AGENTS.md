# AGENTS.md

This file provides guidance to coding agents (e.g. Claude Code) when working with code in this repository. (`CLAUDE.md` is a symlink to this file.)

## What rookery is

An orchestrator agent with memory. A resident **daemon** hosts **master agent** sessions built on the Claude Agent SDK, and the master spawns, controls, and observes a **worker fleet isolated per worktree** of registered git repos. The CLI, the Electron app, and Slack are all **thin clients** that attach to the daemon over WebSocket — the daemon survives client disconnects and does not kill sessions or workers.

## Glossary

- **Master (`MasterAgent`)** — the orchestrator you talk to. One session = one master conversation. Events `master.*`.
- **Worker (`Worker`)** — a worker the master spawns in isolation inside a worktree. Managed by `FleetOrchestrator`, DB `workers`, events `worker.*`. (The current name for the old term "subagent.")
- **Fleet** — the entire set of workers = the control plane (one global instance per daemon).
- **Session / Repo / Worktree** — the master conversation / a registered git repo / a per-worker isolated workspace.
- **Native nested subagent** — an SDK subagent that a worker (or the master) launches via the **Task tool** of `claude_code` (live-only, non-persistent): `worker.nested` event + desktop `NestedAgents`. ⚠️ **The words "agent"/"subagent" are reserved for this native concept** — rookery workers are always called "worker/Worker" (`forwardSubagentText` and `subagent_type` are SDK tokens, so they are preserved).

## Required: Node 22 (the most common pitfall)

`better-sqlite3` is built against the **Node 22 ABI (127)**. This machine defaults to an older Node, so **whatever you do, activate Node 22 first** (`nvm use 22` or PATH). If you get it wrong the daemon "won't come up" and an ABI mismatch is logged to `~/.rookery/daemon.log`. To work around this, the Electron app spawns the daemon as an **external Node 22 process** (`ROOKERY_NODE`) — which is why the app's main/renderer **must not runtime-import** `better-sqlite3` or daemon code.

## Commands

root = daemon/engine, `apps/desktop` = the Electron workspace (see its own `AGENTS.md`).

```bash
# Build / develop (root)
npm install
npm run build        # tsc -p tsconfig.json && chmod +x dist/index.js  (the Electron app spawns this dist/)
npm run dev          # tsx watch src/index.ts  — does NOT produce dist/ and does NOT typecheck
npm test             # vitest run
npm run test:watch
npm run typecheck    # tsc --noEmit  — tsx/vitest do not typecheck, so run this as a pre-commit gate

# Single test
npx vitest run test/core/fleet-orchestrator.test.ts   # one file
npx vitest run -t "spawns"                             # by test-name pattern

# Run
node dist/index.js daemon    # daemon in the foreground
node dist/index.js           # CLI (if no daemon is up, auto-starts one detached → logs in ~/.rookery/daemon.log)

# Desktop (the root dist/ must be built first)
npm run build                # (from root) prepare the daemon dist
npm -w apps/desktop run dev  # injects ROOKERY_NODE automatically
./scripts/dev.sh             # all in one: force Node 22 on PATH → kill the existing daemon → root build → desktop dev
```

Commit trailer convention: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Directories

- `src/core/` — **transport-agnostic engine**: SessionManager / MasterAgent / Worker / FleetOrchestrator / Settings / Usage / EventBus / GitOps, the automation engine (dispatcher/action/scheduler/match), and `i18n.ts` (daemon-side ko/en strings)
- `src/daemon/` — http+ws server, connection handler, single-instance lock, WS auth, fs hardening — **the only composition root**
- `src/protocol/messages.ts` — transport-agnostic wire message schema (zod)
- `src/persistence/` — SQLite connection/migrations (`db.ts`) + repository (`repositories.ts`)
- `src/tools/` — in-process MCP tool servers (memory, repos, fleet, schedule, slack-thread)
- `src/slack/` — Slack adapter (embedded in the daemon)
- `src/index.ts`, `src/entrypoints/cli.ts` — entrypoints (daemon vs CLI dispatch)
- `apps/desktop/` — the Electron mission-control app (separate workspace)
- `docs/` — **agent-facing reference docs** (evergreen, read on demand): `architecture/` flows, `reference/` catalogs (events/protocol/data-model/settings), `guides/` how-to recipes. Start at [`docs/README.md`](docs/README.md).

## Architecture (the big picture you only see by reading several files)

This section is the always-loaded summary. For depth — turn lifecycles, the event/protocol/schema catalogs, and "how to add X" recipes — read the on-demand docs under [`docs/`](docs/README.md) (each cites its source files).

### Transport-agnostic core + a single composition root
`src/core/` **never imports** WS/CLI/Slack/Electron. It is driven by domain commands and only emits `CoreEvent` through the `EventBus`. Every external boundary is an **injectable port + fake**: `QueryFn` (SDK `query()`), `GitOps` (`RealGitOps`/`FakeGitOps` — all git and gh shell-outs), `Repositories` (SQLite), `SlackClient`. **All wiring happens only in `startDaemon()` of `src/daemon/server.ts`.** Assemble new dependencies there; the core only receives them as interfaces.

### Master vs Worker — the spine of this codebase (don't confuse them)
The input models are **different.**
- **Master** (`src/core/master-agent.ts`): `runTurn(text)` → one **string prompt** to `query()` + SDK `resume: sdk_session_id` to continue context. Turns are **serialized** in a per-session `turnChain` (concurrent sends are queued, not interleaved). `buildSystemPrompt()` = `claude_code` preset + the 10 most recent memories + repo catalog injection. Every turn it receives the base in-process MCP servers (memory/repos/fleet) plus a per-source `capabilities()` overlay (see Tools).
- **Worker** (`src/core/worker.ts`): passes a **`MessageQueue` (streaming input)** to `query()` to keep the session alive → can follow up via `send()`. **No MCP servers** — it just runs the default `claude_code` toolset (Bash/Edit, etc.) with `cwd: worktree`. ⚠️ **The user echo of a mid-turn `send` is recorded not the moment it is sent but at the next `result` (turn boundary)** (`deferred` FIFO) — because the `MessageQueue` only hands the message to the SDK on the next turn, the echo is deferred to the boundary so it doesn't land in the middle of an in-progress turn's output (parity with the master `turnChain` deferral). In the meantime the desktop shows a `pendingByWorker` "waiting" bubble, then reconciles it with the echo (`clientMsgId`).

Model/effort are injected **not as values but as resolvers (`() => string`)**, so they are **re-evaluated every turn** → `Settings` changes are reflected immediately in live sessions. Snapshotting them as strings at session-creation time breaks this behavior.

### Fleet = the control plane (worktree isolation)
`src/core/fleet-orchestrator.ts`. **One** `FleetOrchestrator` per daemon (a global pool) is injected into all sessions → from any session you can list/inspect/control the entire fleet.
- spawn → create a worktree + branch `rookery/<id>` at `~/.rookery/worktrees/<id>` (`git worktree add -b … <base>`) → start the worker.
- ⚠️ **The orchestrator manages only worker lifecycle. Commit/push/PR is done directly by the worker in its own worktree via bash (`git`/`gh`)** (the master instructs it via `send_worker`). **There is no automatic PR pipeline** — `GitOps` does only worktree/diff/checkpoint/fetch (no commit/push/openPr). The README §Fleet description of an auto commit→push→`gh pr create` pipeline is **stale**; trust the source.
- `waitUntilSettled()` resolves **only on termination (stopped/done/error)** — **it does not resolve on idle**. `flows` is used to **wait for the termination drain (close→waitAllSettled)** (not for concurrency-cap accounting). **There is no concurrent worker cap — spawns are never rejected.** Runaway control (cost/turn budgets) will be introduced separately later.
- **Async notification:** `spawn_worker`/`send_worker` accept `notify:true`. `WorkerNotifier` (`src/core/worker-notifier.ts`) arms the requesting master to be woken when that worker next *settles* (idle on success, or a terminal failure — so the master isn't left waiting forever on a failed dispatch). Pending arms persist in the `pending_notifications` table so they survive a restart.
- `stop_worker` (keeps the worktree) vs `discard_worker` (removes the worktree + branch, losing uncommitted work).
- Restart: on daemon boot `fleet.rehydrate()` restores detached entries from DB rows (diff/discard/stop keep working). If both the worktree and `sdk_session_id` are alive, lazy resume (→idle); otherwise `orphaned`. The live streaming conversation itself dies with the process and does not come back.

Worker state union: `running | idle | stopped | done | error` + the orchestrator-only DB states `failed`/`orphaned`. (`done` happens only when the SDK generator terminates naturally — in practice it almost always ends as `stop`→`stopped`.)

### Tools = in-process MCP servers (master only)
`src/tools/`. Each file returns `create*ToolsServer()` → `createSdkMcpServer()`. The base set injected every master turn is **memory / repos / fleet**; `schedule` and per-source servers (e.g. `slack-thread`) are layered on via the turn's `capabilities()` overlay.
- **memory** (`memory-tools.ts`): `remember`, `recall`
- **repos** (`repo-tools.ts`): `register_repo`, `list_repos`, `update_repo`, `remove_repo`
- **fleet** (`fleet-tools.ts`): `spawn_worker`, `send_worker`, `list_workers`, `get_worker_status`, `view_worker_transcript`, `view_worker_diff`, `stop_worker`, `discard_worker` (the master is purely async — `spawn_worker`/`send_worker` take `notify:true` to be woken on completion/failure; there is no blocking `await_worker`)
- **schedule** (`schedule-tools.ts`): `schedule_wakeup`, `schedule_list`, `schedule_cancel` — the master scheduling its own future wake-ups (the `once` automation kind)
- **slack-thread** (`slack-thread-tools.ts`): `read_thread` — injected only for Slack-origin sessions, lets the master read the current thread transcript

Because `permissionMode:"bypassPermissions"`, the only exposure gate is the `allowedTools` allowlist → you **must keep** each file's `*_TOOL_NAMES` constants (format `mcp__<server>__<name>`) **in sync** with the actual `tool()` names. If they drift, the tool registers but silently can't be used. **Workers do not receive these tools** (they cannot spawn fleet or access memory themselves). Recent memories are injected into the system prompt every turn automatically, separate from any `recall` call.

### Persistence (SQLite)
`src/persistence/`. `better-sqlite3` (synchronous), `WAL` + `foreign_keys=ON` + **`STRICT` tables**. Migrations are an **append-only `MIGRATIONS` array in `db.ts`** (index = version, forward-only, one transaction). **Never modify existing entries; only add new ones** — `db.test.ts` asserts the applied schema version stays `=== MIGRATIONS.length`, and a DB newer than the build is rejected at open. Tables: `sessions`, `messages` (text + last_activity), `session_events` (master transcript events — on restart/reconnect even tool/thinking/metrics/notice are restored; the master counterpart of `worker_events`), `workers`, `worker_events`, `worker_checkpoints`, `memories`, `repos`, `settings`, `automations`, `pending_notifications`. All access goes through `Repositories`.

### Daemon / Protocol
`src/daemon/`, `src/protocol/messages.ts`. http `/health` + WebSocket `/ws` in `noServer` mode. Single-instance is a **PID file lock** (`~/.rookery/daemon.pid`, exclusive `wx` creation; stale ones are judged via `process.kill(pid,0)` and cleaned up). WS auth: `~/.rookery/ws-token` (0600 shared secret) + an **Origin gate** (rejects non-local Origins) + `timingSafeEqual`. A non-local bind (`ROOKERY_HOST`) sends the token in plaintext, so it only raises a stderr warning. On boot, `src/daemon/fs-hardening.ts` tightens `~/.rookery` to `0700` and sensitive files to `0600` (best-effort, never throws).
Protocol: **inbound is validated with the zod `clientMessageSchema` (discriminated union)**, outbound `ServerMessage` is just `JSON.stringify`'d (no schema validation). `reqId` correlates request and response (some fire-and-forget messages have no reqId). Events flow over `EventBus` channels: session id, `FLEET_CHANNEL("@fleet")`, `ALL_CHANNEL("@all")`. When subscribing to `@all`, duplicate per-session subscriptions are deduped, and `EventBus.deliver` wraps each listener in try/catch so one bad listener can't break fan-out.

### Localization (i18n)
Two independent, zero-dependency catalogs; **Korean is the default** everywhere.
- **Daemon side — `src/core/i18n.ts`** (`t(locale, key, params?)`, `resolveLocale`, `DEFAULT_LOCALE="ko"`): ko/en strings for Slack/CLI output and core notices (`notice.*` / `slack.*` / `cli.*` / `interaction.*`). The Slack adapter resolves its locale live per message from the `slackLocale` setting; the CLI resolves from env (`LC_ALL`/`LANG`).
- **Structured core notices:** `classifySystemPush` returns `{code, params, text}` where `text` is pre-rendered at `DEFAULT_LOCALE`, and the master attaches `code`+`params` to `master.notice` events so each client can re-localize. `worker.ts` consumes the pre-rendered `text` and is deliberately untouched by this.
- **Desktop side** has its own renderer catalog (`apps/desktop/src/renderer/i18n/`, ko/en, runtime-switchable) plus a separate main-process catalog (`apps/desktop/src/main/i18n.ts`). ⚠️ The renderer `notice.*` keys/param-names must stay byte-identical to the daemon `notice.*` keys (intentional cross-build duplication).

### Slack adapter
`src/slack/`. Only when **both** the bot and app tokens are present does the daemon also bring up a bolt Socket Mode bot (otherwise it is silently disabled and the daemon is fine). **Token, cwd, allowlist, allow_all, refusal message/reply, and locale are all resolved from `Settings` (DB)** — tokens prefer the DB with an env fallback, the rest are settings-only. Instead of a `config`, the slack layer receives a `slackConfig: () => {...}` resolver and **resolves on every call (live)**: tokens at connect time, allowlist/cwd/locale per message. **Thread = session** (external key `slack:team:channel:threadTs`, persisted → the same conversation survives a daemon restart). The allowlist is **fail-closed**: if the allowlist is empty and allow_all is not set either, **everyone is rejected** (stderr warning at connect); a non-permitted user gets the (configurable) `DEFAULT_SLACK_REFUSAL` reply. Responses stream as plan cards (`task_display_mode:"plan"`), and the master's tool calls are rendered as in_progress→complete tasks.

Bolt **boots asynchronously** (it does not block startup): `SlackController` (`src/slack/controller.ts`) is the single owner of lifecycle + state (`unconfigured` (no token) / `off` (toggle off) / `connecting` / `up` / `error`), and on every state transition emits a `slack.status` CoreEvent to `sessionId:ALL_CHANNEL` to broadcast to all clients. server.ts brings it up with `void slack.boot()` and injects it into the Connection. **Turning it on/off is the `slack.set {enabled}` command** → `controller.setEnabled` → the persisted setting `slackEnabled` ("1"/"0", default on) + start/stop. **When a token changes via `settings.set`, the Connection calls `controller.reconcile()`** → it disconnects, re-evaluates against the current configured/enabled, and (re)connects immediately on save (`configured` is a resolver because tokens change at runtime). On connect, the Connection replies once with the current state in `events.subscribe` (initial sync). The UI (desktop) exposes it via a bottom-left indicator + the Slack section of the settings page (status/toggle + token/cwd/allowlist/allow_all/refusal/locale fields).

### Automation (Triggers + Actions) — cron + Slack events
An automation rule = a **trigger** (`cron` | `slack`) + an **action** (`master` | `worker`). The `automations` table (STRICT): `trigger_type`/`trigger_config_json` (cron: `{cron,timezone}` · slack: `{channels?,keyword?,fromUsers?}`) + `action_type`/`action_config_json` (master: `{prompt,cwd,sessionMode}` · worker: `{repo,task,base?}`) + `model`/`effort`/`permission_mode`/`max_turns`/`next_run_at`/`last_*`. The types are `Automation`/`AutomationTrigger`/`AutomationAction` (`kind` discriminated union), CRUD via `Repositories`.

- **`AutomationDispatcher` (`src/core/automation-dispatcher.ts`) = the single firing point.** Every trigger source calls `run(a, vars)` → **only cron (time) triggers** skip overlap via a per-id **in-flight Set** (`last_status:"skipped"`, preventing schedule pile-up); **slack (event) triggers allow concurrent execution** (processed per message, no drops) → `runAutomationAction` → `setAutomationRun` (last_run/status/error, preserving `next_run_at`) → emit `automation.changed`. The source only decides "what, with which vars." (For `once`, the Scheduler deletes before firing to prevent double-firing — no dispatcher guard needed.)
- **`runAutomationAction` (`src/core/automation-action.ts`)** = a pure action. It substitutes `{{message}}`·`{{channel}}`·`{{user}}`·`{{ts}}`·`{{threadTs}}` (falls back to the message ts if there is no thread)·`{{team}}` into the master prompt / worker task (function-form replacer, `$`-safe; empty string when missing) → master `runTurn` (reuse[`automation:<id>`]/fresh) / worker `fleet.spawn` (the hidden home session `AUTOMATION_FLEET_SESSION_KEY="automation:fleet"`). ⚠️ **Untrusted Slack vars are fenced**: each substituted value is wrapped in `<untrusted-… id="<nonce>">…</untrusted-…>` with a fresh per-call nonce, and the value is neutralized (nonce stripped + a Zero-Width Space inserted into any literal `untrusted-` tag) so injected text can't spoof the fence.
- **Trigger source ① cron — `Scheduler` (`src/core/scheduler.ts`, one per daemon):** uses `croner` to **only compute the next run** (no internal timer → deterministic via an injected `now()`); an injected tick selects `trigger.kind==="cron" && enabled && next_run_at<=now` and **advances next_run first → re-reads fresh → `dispatcher.run(a,{})`** (no double recording — recording is the dispatcher's). `runNow` fires once immediately (does not advance next_run), **enabled defaults off**, **does not backfill**, and ignores slack rules.
- **Trigger source ② slack — `src/slack/trigger-source.ts` + `app.message`:** filters Bolt message events via `src/slack/message-text.ts` — it excludes only **our own bot (its own `bot_id`, looked up via `auth.test` at connect)** and noise subtypes like edit/delete, while **letting other bots/integrations (CI, monitoring, alerts) through** (the `bot_message` subtype is allowed; feedback loops are blocked by self-exclusion). `extractSlackText` **melts Block Kit blocks/attachments/rich_text into text** for matching and `{{message}}` (rich_text mirrors m.text so it's skipped as a duplicate; fallback is used only when there's nothing else). Then `makeSlackTriggerHandler` evaluates `enabled && trigger.kind==="slack"` rules with `matchesSlack` (`src/core/automation-match.ts`, pure: channel / keyword [case-insensitive substring] / sender, all matching when empty) → on a match, `dispatcher.run(a,{message,channel,user})`. Independent of the conversational (assistant/mention) path.
- Protocol `automation.*` (connection→`AutomationProvider`, wired in server.ts; create/update/set_enabled call `scheduler.reconcile`); for cron triggers, `automationInputSchema.superRefine` rejects saving an invalid cron via `isValidCron`. On change, `automation.changed` is broadcast to `ALL_CHANNEL` → the desktop `AutomationPage`/`AutomationModal` refetches.
- ⚠️ **Slack app prerequisites (user configuration, the bot can't do it):** subscribe to the `message.channels` event + the `channels:history` scope + invite the bot to the target channels. Without these, message events are not received.
- ⚠️ **Prompt injection / unattended runs:** untrusted channel text enters the master prompt as fenced `{{message}}` (see above), but because automation runs `bypassPermissions` and unattended there are still **no cost/turn budget guards** beyond the per-action `max_turns`. `canUseTool` auto-allows (an unattended turn isn't blocked by AskUserQuestion).
- **Extension seam:** a new trigger kind (webhook/reaction/interval) only needs a union member + config + (event-type) a matcher or (time-type) next-run computation + a source file + server.ts wiring — the dispatcher/execution/model/Scheduler are unchanged.

### `~/.rookery` home layout (`ROOKERY_HOME`)
`rookery.db` (WAL) · `daemon.pid` (single-instance lock) · `ws-token` (0600 WS auth) · `daemon.log` (daemon stdout/stderr — Node version/auth errors are logged here) · `worktrees/<id>/` (per-worker git worktree) · `slack-files/` (downloaded Slack attachments). It's outside the repo, so it's not subject to `.gitignore`; the home dir is hardened to `0700` on boot.

## Environment variables (all resolved in `src/config.ts::loadConfig`)

| Variable | Default | Effect |
|---|---|---|
| `ROOKERY_HOME` | `~/.rookery` | Base for DB/pid/token/worktrees |
| `ROOKERY_HOST` / `ROOKERY_PORT` | `127.0.0.1` / `8787` | WS·HTTP bind (a non-local host warns about plaintext token) |
| `ROOKERY_MASTER_MODEL` | `claude-opus-4-8` | Master default model |
| `ROOKERY_WORKER_MODEL` | `claude-opus-4-8` | Worker default model — **`.env.example` shows `sonnet` as an example, but the code default is opus** |
| `ROOKERY_MASTER_EFFORT` / `ROOKERY_WORKER_EFFORT` | `high` | Global default effort (not passed to Haiku) |
| `ANTHROPIC_API_KEY` | (none) | SDK auth. **The settings (DB) in-app key takes priority**; env is the fallback. If neither is set, the SDK falls back to OAuth (`claude login`) — `detectAuth` is only a hint and does not block startup |
| `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | (none) | If **both** are present, the Slack bot is enabled. **But the settings (DB) `slackBotToken`/`slackAppToken` take priority** — env is the fallback (headless/CI) |
| `ROOKERY_LINEAR_API_KEY` | (none) | Linear integration key. **Settings (DB) `linearApiKey` takes priority**; env is the fallback |
| `ROOKERY_CCUSAGE_CMD` | `~/.bun/bin/bunx ccusage@latest` | Usage-collection command (space-separated) |

**Removed env vars (now settings-only, DB):** `ROOKERY_MAX_WORKERS` (the concurrent-worker-cap concept is gone — spawns are never rejected); `ROOKERY_SLACK_CWD` / `ROOKERY_SLACK_ALLOWED_USERS` / `ROOKERY_SLACK_ALLOW_ALL` / `ROOKERY_USAGE_REFRESH_MS` → `Settings.slackCwd/slackAllowedUsers/slackAllowAll/usageRefreshMs`, edited on the UI settings page (usageRefreshMs is applied at boot).

**Settings-only (DB) values worth knowing:** `slackRefuseReply` / `slackRefusalMessage` / `slackLocale` (Slack output language ko/en), `masterName`, `hasAcceptedDataNotice` (first-run data-transmission consent), plus the write-only secrets `slackBotToken`/`slackAppToken`/`linearApiKey`/`anthropicApiKey` (never echoed back through `settings.get`).

## Fragile conventions / pitfalls

- **Node 22 ABI** — see the "Required" section above. The #1 pitfall of all.
- **ESM NodeNext** — relative imports **require the `.js` extension**, type-only uses need **`import type`** (`verbatimModuleSyntax:true`). `rootDir: src`.
- Don't confuse the **master (string prompt + resume) vs worker (MessageQueue streaming)** input models.
- **Model/effort are re-evaluated every turn via a resolver** — snapshotting them means runtime `Settings` changes aren't reflected.
- **Control-plane model** — there is no automatic PR pipeline. The worker opens PRs directly. README §Fleet is stale on that part, so **trust the source.**
- **`bypassPermissions` applies to both master and worker**, and fleet fan-out multiplies the blast radius. Because there are **still no** cost/turn budget guards (only per-automation `max_turns`), run it only in trusted environments/paths.
- **Migrations are append-only** — never modify existing entries.
- **There are two terminal-state writers** (`Worker.transition` vs `FleetOrchestrator.setStatus`), but **the terminal write-once is enforced at the single chokepoint `repos.setWorkerStatus(id, status, force?)`** — once terminated (`stopped/done/error/failed/orphaned`) it can't be overwritten with another value (force = only user stop/discard and rehydrate are exceptions). Adding a new writer is safe as long as it goes through this guard.
- **Passing effort to Haiku is an API 400** — always gate with `effortApplies(model) && coerceEffort(effort)`.
- **i18n** — Korean is the default. New daemon-side user-facing strings (Slack/CLI/notices) go through `src/core/i18n.ts`; new `notice.*` codes must be added to BOTH the daemon catalog and the desktop renderer catalog with matching param names. Code comments are written in English.

## Testing

- Tests mirror `src/**` 1:1 in `test/**`. Thanks to the DI ports, unit tests run **without a real SDK, git, or network**.
- **`test/helpers/fake-query.ts` is the canonical way to mock the SDK `query()`** (`fakeQuery(script)`). To verify `query()` options (model/effort/systemPrompt/permissionMode), wrap the fake in a capturing closure (see `capture()` in `test/core/master-agent.test.ts`).
  - ⚠️ **`fakeQuery` is finite** (end of script → generator terminates → the worker reaches `done`). **A real streaming SDK iterator only ends when the input is closed.** This gap hides happy-path lifecycle issues, so don't overtrust green tests as end-to-end evidence.
- The DB is `openDb(":memory:")` + `new Repositories(db, now?)` (deterministic timestamps via an injected clock). git is the injected `FakeGitOps` (records calls); `RealGitOps` is verified separately against a temp repo (`fs.mkdtempSync`).
- Background fleet flows are awaited with `FleetOrchestrator.waitAllSettled()`.
