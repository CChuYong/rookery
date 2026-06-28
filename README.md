# rookery

rookery is an **open-source agentic development environment** for running a
resident AI development orchestrator with memory, repo awareness, and a
worktree-isolated worker fleet.

A long-lived daemon hosts master agent sessions built on the Claude Agent SDK.
The master can register repositories, remember project context, spawn coding
workers in isolated Git worktrees, inspect their diffs, and continue coordinating
work even when clients disconnect. The CLI, Electron desktop app, and Slack bot
are thin clients over WebSocket; the daemon owns the sessions, workers, memory,
automation rules, and local state.

## What you can do

- Coordinate multiple coding workers from one master agent conversation.
- Keep every worker isolated in its own Git worktree and branch.
- Register multiple local repos with descriptions so the master can route tasks.
- Review worker status, transcripts, diffs, checkpoints, and costs from the CLI
  or desktop app.
- Continue sessions from CLI, Electron, or Slack without killing background work.
- Trigger unattended master or worker runs from cron schedules and Slack events.
- Spawn workers from GitHub issues or Linear tickets in the desktop app.

## Install

- **macOS (Apple Silicon):** [⬇ `.dmg`](https://github.com/CChuYong/rookery/releases/latest/download/rookery-arm64.dmg)
- **Linux (x86_64):** [⬇ `.AppImage`](https://github.com/CChuYong/rookery/releases/latest/download/rookery-x86_64.AppImage)
- **Windows (x64):** [⬇ `.exe` installer](https://github.com/CChuYong/rookery/releases/latest/download/rookery-x64-setup.exe) — unsigned; on first launch click **More info → Run anyway** (SmartScreen)

## Requirements
- Node.js >= 22
- `ANTHROPIC_API_KEY`

> This machine defaults to Node 20, so before running you must activate Node 22 via `nvm use 22` (or a Node 22+ PATH) (the better-sqlite3 native module is built against the Node 22 ABI).

## Build from source
```bash
npm install
npm run build
```

## Running
```bash
export ANTHROPIC_API_KEY=sk-ant-...
# Launch the daemon directly in the foreground:
node dist/index.js daemon
# Or just run the CLI, and the daemon starts automatically when none is running:
node dist/index.js
```

## Development
```bash
npm run dev        # tsx watch (daemon/CLI dispatch)
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

## Architecture
- `src/core/` — transport-agnostic agentic development engine (SessionManager / MasterAgent / FleetOrchestrator / Worker)
- `src/daemon/` — http+ws server, connection handler, single-instance lock
- `src/protocol/` — transport-agnostic message schema (shared by the CLI, Electron app, and Slack adapter)
- `src/persistence/` — SQLite connection/migrations/repository
- `src/tools/` — memory, repo, and fleet (orchestration) MCP tools (master only)
- `src/slack/` — Slack adapter (bolt Socket Mode + Assistant API, embedded in the daemon)

## Fleet (worktree isolation + repo registry)

Workers form a fleet that **codes in parallel, isolated per git worktree of a registered repo**. The master is the control plane — it views the registered repo pool (with domain descriptions) and routes tasks.

- Repo registration: `register_repo` (name/path/description). Injected into the master prompt as a catalog for automatic routing.
- `spawn_worker({repo, task})` → creates a worktree + branch `rookery/<id>` in `~/.rookery/worktrees/<id>` → the worker works there.
- The orchestrator manages only worker lifecycle. **The worker commits, pushes, and opens PRs itself via bash (`git`/`gh`) in its own worktree**, when the master instructs it (`send_worker`). There is no automatic PR pipeline or `pr_open` status.
- Global fleet: `list_workers`/`view_worker_diff`/`stop`/`discard` target the entire fleet from any session.

## Desktop app (macOS)

An Electron mission control for the agentic development environment. The app
auto-starts the daemon with an external Node and attaches over WS.

**It must run with Node 22** (better-sqlite3 native ABI). The `dev` script passes the Node path it was launched with to the daemon spawn via `ROOKERY_NODE`, so you just need to run it from a Node 22 shell.

Dev run:
```bash
cd /Users/CChuYonng/workspace/Rookery && nvm use 22   # or node22 on PATH
npm run build                 # build the daemon dist (the app spawns this)
npm -w apps/desktop run dev    # ROOKERY_NODE auto-injected
```
- Left: sessions list + Repos nav + daemon status pill; center: conversation (chat/plan cards/metrics) + tab container for file/diff tabs; right sidebar: Files | Git | Worker segments. The live fleet/worker tree lives in the Repos view (`RepoTree`).
- Register repos via the Repos view or chat. Spawn workers via chat (natural language).
- If the daemon fails to start, the UI shows a "Cannot connect to the daemon" banner, and the cause is logged in `~/.rookery/daemon.log` (e.g. Node version mismatch, missing auth).

## Data Handling

**What leaves your machine:** rookery sends the following to Anthropic's API for processing:
- Master conversation prompts (your messages and the master's responses)
- Repository source code paths referenced in sessions
- Worker repository source code, diffs, and terminal output
- If Slack is connected: channel message text that triggers automations or mentions

**Authentication (API key):** An Anthropic API key is recommended. You can set it in-app (**Settings → Anthropic API key** — stored in the local DB, takes priority) or via the `ANTHROPIC_API_KEY` environment variable (env fallback). If neither is configured, the daemon falls back to Claude Code OAuth (`claude login`).

**Local storage:** All rookery data lives under `~/.rookery` — conversation history, integration tokens (Slack, Linear), logs, and worker worktrees. The directory is hardened to mode `0700` on each boot; sensitive files (DB, WS token, PID file, daemon log) are set to `0600`.

**First run (desktop app):** The desktop app shows a one-time data-transmission consent screen before use. It is a blocking modal — you must accept before the UI becomes usable. The acceptance is stored in the local DB (`hasAcceptedDataNotice`) so it is only shown once.

## Security note
Both the master and the workers run with `permissionMode: "bypassPermissions"` (because a headless daemon has no TTY to approve permission prompts). That means the master, in its launch directory (the Slack session cwd is a setting), and the workers, in their target repos, **auto-approve** tool use including bash and file writes. Run only in trusted environments/paths. (If you need finer control, replace this with a `canUseTool` callback or scoped `allowedTools`.)

## Slack adapter

Embeds a Slack bot (Socket Mode + Assistant API) in the daemon. When **both** `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set, it comes up automatically alongside the daemon at startup (when absent, it is disabled and the daemon/CLI run normally). Each thread is tied to a master session (same thread = same conversation), and the master's responses stream message by message.

### Slack app setup (one-time)
1. Create an app at https://api.slack.com/apps.
2. Enable **Socket Mode** → issue an App-Level Token (scope `connections:write`) → `SLACK_APP_TOKEN` (xapp-…).
3. **OAuth & Permissions** → Bot Token Scopes: `assistant:write`, `chat:write`, `app_mentions:read`, `im:history`, `channels:history`, etc. → install to the workspace → `SLACK_BOT_TOKEN` (xoxb-…).
4. Enable the **Agents & Assistants** (Assistant) feature. Event Subscriptions: subscribe to `app_mention`, `assistant_thread_started`, `message.im`, `message.channels` (required for Slack automation triggers — also needs the `channels:history` scope and the bot invited to target channels).

### Running
```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
nvm use 22 && node dist/index.js daemon
```

### Behavior
- Chat in the Assistant panel, or mention `@rookery ...` in a channel. (Restrict which users get responses via the allowlist in **Settings → Slack**, stored in the DB; fail-closed — empty allowlist + allow_all off rejects everyone.)
- The same thread is the same master session (conversation continues). Responses stream message by message.
- The master's tool calls (remember/recall/spawn_worker, etc.) are shown as tasks in the response message's **plan card** (`task_display_mode: "plan"`, in_progress→complete).
- A worker's actual completion (`done`/`stopped`) happens in the background, so it arrives as a follow-up notification in the thread (`🤖 <id> → done`).
- A `$cost · n turns` context block at the end of the turn.

> Slack's SDK auth is separate from the master/worker Anthropic auth (API key or Claude Code OAuth).

## Automation

Rookery supports automation rules, each a **trigger** (`cron` | `slack`) + an **action** (`master` | `worker`), managed on the desktop **Automation** page. Cron rules fire on a schedule; Slack rules fire on matching channel messages (requires the `message.channels` subscription above). Per-automation model/effort are configurable. Untrusted Slack message text is substituted as `{{message}}` into the prompt.

## Integrations (spawn workers from GitHub issues / Linear tickets)

In the desktop app's worker-creation dialog, **search and select** an issue or ticket, and the task message is auto-filled with its content (identifier + title + URL + body).

- **GitHub**: reuses the authenticated `gh` CLI with no extra setup (`gh auth login`). Searches issues in the selected repo. The auth status is shown in the settings screen's "Integrations" section.
- **Linear**: enter a Personal API Key in the settings screen's "Integrations" section (or the `ROOKERY_LINEAR_API_KEY` env) to globally search tickets via the Linear GraphQL API. The key is stored in `~/.rookery/rookery.db` (settings) and is not exposed back through the UI.

If no integration is configured, the dialog only shows the existing "paste a GitHub issue/PR URL" fallback.

## License & third-party notices

rookery's own source code is licensed under the [Apache License 2.0](LICENSE).

⚠️ rookery is built on the **Anthropic Claude Agent SDK**, which is **proprietary
software (© Anthropic PBC, all rights reserved)** and is **not** covered by this
Apache-2.0 license. Using or distributing rookery is subject to Anthropic's
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms) /
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[Usage Policy](https://www.anthropic.com/legal/aup), and the
[Claude Code legal terms](https://code.claude.com/docs/en/legal-and-compliance).

In short: **bring your own Anthropic credentials** (API key recommended for
SDK-based use); **do not** offer Claude login or pool/route subscription
credentials on behalf of other users; a multi-tenant hosted service needs
Anthropic's approval. The Apache-2.0 license covers only this project's code, not the
SDK or other bundled third-party software. See [NOTICE](NOTICE) for the full
third-party notices.
