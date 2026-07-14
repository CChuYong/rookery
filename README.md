# rookery

**An open-source agentic development environment: a resident AI orchestrator with memory, a fleet of coding workers isolated in git worktrees, and mission control to run it all — on your machine.**

A long-lived daemon hosts **master agent** sessions that register your repos, remember project context, and spawn **workers** that code in parallel — each in its own git worktree and branch, on the AI backend you choose (**Claude or Codex**). The desktop app, CLI, and Slack are thin clients: close them anytime, the daemon keeps working.

<p align="center">
  <img src="https://github.com/user-attachments/assets/a4eb2001-deaf-4738-92c1-435d1b216ce6" alt="Ask in plain language → the master spawns workers in isolated worktrees → a reviewer auto-spawns when they settle → the attention bell tells you what needs you" width="920">
</p>

Watch the full 90-second demo — a real run: real workers, real commits, real automation.

https://github.com/user-attachments/assets/38face67-d553-4c51-9741-b0942ca337cd

<table>
  <tr>
    <td width="50%"><img src="https://github.com/user-attachments/assets/3b339393-c0ec-4bdb-8e81-8817dae8d845" alt="The fleet: workers per repo with status, backend, and cost — and each worker's own transcript and terminal"></td>
    <td width="50%"><img src="https://github.com/user-attachments/assets/f9cb81ec-31d8-4e40-a790-e50cccc673aa" alt="Automation rules: cron, interval, Slack, and worker-settled triggers driving master turns or worker spawns"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>The fleet</b> — per-repo workers with status, backend & cost; every worker has its own transcript, diff, and terminal.</sub></td>
    <td align="center"><sub><b>Automation</b> — cron / interval / Slack / worker-settled triggers, with per-rule model, backend, and budget.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="https://github.com/user-attachments/assets/b958b17d-2bc6-4776-a65e-84e4d9267829" alt="The attention bell ranking what needs you now: blocked questions, failures, and unreviewed results"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>The attention bell</b> — one ranked queue for what actually needs you: blocked questions first, failures second, unreviewed results third.</sub></td>
  </tr>
</table>

## Why rookery

- **Always-on, not tab-bound.** The daemon owns sessions, workers, memory, and automations. Clients attach and detach; overnight runs survive; conversations restore on reconnect — including tool calls and reasoning.
- **A real fleet, safely parallel.** Every worker gets its own worktree + branch (`rookery/<id>`). Nothing touches your checkout; you review diffs and tell workers to commit, push, and open PRs themselves.
- **Two brains, one control plane.** Masters, workers, automations, and Slack threads each pick their backend — Claude or Codex — with per-surface model/effort controls, live model catalogs, and even **cross-provider fork** (continue a Claude conversation on Codex, or vice versa).
- **A fleet that reacts, not just obeys.** Automations fire on schedules (cron / every N minutes), Slack messages, or **when a worker settles** — so "implementation worker finished → spawn a reviewer on its branch" is a rule, not a ritual.
- **Honest signals.** Worker states are truthful: `idle` means *all assigned work is done* — a worker waiting on a background shell shows `background`, and completion notifications fire only at the real finish line. The **attention bell** ranks what needs you *now*: blocked questions first, failures second, unreviewed results third.
- **Drives and is driven.** Talk to it from Slack (thread = session), or expose the fleet as an **MCP server** and drive rookery from Claude Code, Cursor, or Codex — code never leaves your machine.
- **Guardrails for unattended work.** Lifetime USD budgets per worker/automation, turn caps, prompt-injection fencing for untrusted input (Slack text, worker output), and fail-closed defaults everywhere.

## What you can do

### Mission control (desktop)

Sessions and the live fleet at a glance: streaming conversations with plan cards and metrics, per-worker transcripts/diffs/checkpoints/costs, an integrated workspace (file explorer, git panel, Monaco editor/diff, terminal in each worktree), dockable panes, and a usage dashboard with Claude and Codex tabs. Korean/English UI.

Spawn workers from chat in natural language, from the spawn dialog, or **straight from a GitHub issue or Linear ticket** — the task is pre-filled from the ticket body.

### Capability Center

Register a local capability pack once, review its complete file digest, and assign it to
all of Rookery or to a repository, session, or worker. Audience filters target master,
worker, or Side agents and UI, Slack, automation, or external origins. More specific
assignments override broader ones, including disabled assignments used as tombstones.

The **Library** tab handles validation, trust, refresh, removal, and write-only secrets;
**Assignments** manages scope and audience; **Effective** shows native inventory plus the
deterministic desired and applied revisions for the selected master or worker. Trusted
packs apply to both **Claude and Codex** without changing the user's `~/.claude`,
`~/.codex/config.toml`, or repository provider files. Instructions append to the turn
prompt. Claude loads skills and MCP through generated local plugins; Codex loads them from
Rookery-owned, target-specific `CODEX_HOME` directories. Masters pick up changes on their
next turn; newly started or lazily resumed workers apply once when their provider stream
opens. An already-live worker reports **Reload required** and can either reload immediately
while idle or schedule a reload for the current turn boundary. Reload preserves the worker
row, worktree, transcript, provider-native conversation, model, effort, permission mode,
and lifetime budgets.

In an active master or worker chat, slash autocomplete is resolved from that exact
conversation's capability snapshot. `/capabilities`, `/skills`, `/hooks`, and `/mcp` open
the matching Capability Center view, while `/btw` and `/side` use the same action registry
to open a Side question. Managed skills are inserted with provider-native syntax
(`/name` for Claude and `$name` for Codex) only when the selected target can invoke them;
inventory-only provider commands are not offered as dead prompts.

Registered repositories may check in an opt-in shared index at
`.rookery/capabilities.json`; its pack paths are contained under
`.rookery/capabilities/`. Rookery discovers and watches those packs, but never trusts or
binds them automatically. A content change invalidates the exact-digest trust decision
until the new digest is reviewed. Removing, disabling, or deleting an index entry is an
authoritative tombstone for that repo-owned Library row.

Start with [`docs/examples/capability-pack`](docs/examples/capability-pack/):

1. Open Capability Center → Library and add the example directory.
2. Review the files and public MCP configuration, then trust the displayed digest.
3. Save the declared secret if needed; secret values are never returned to the UI.
4. Create an assignment, run the next Claude or Codex turn (or start/resume a matching
   worker), and inspect the matching desired/applied revision in Effective.

Rookery copies trusted bytes into an immutable
`~/.rookery/capability-runtime/<revision>/` directory at launch. Generated files contain
only environment aliases; write-only secret values are passed only in the selected provider
child environment and are never returned to the UI or written into plugin/TOML
configuration. Codex masters and workers each receive a separate generated home, config,
rollout tree, and secret alias overlay. For a stdio MCP with a pack-relative `cwd`, Rookery
generates a small Node launcher inside the immutable runtime so the declared working
directory is honored without invoking a shell.
For secret-bearing Codex launches, Rookery also disables Codex shell snapshots and removes
managed aliases from model-invoked shell environments using fixed public overrides; no
secret name or value is placed in argv.
On daemon boot, Rookery keeps only valid schema-2 runtime revisions still desired by an
authoritative session or worker and removes stale revisions and interrupted staging
directories without following symlinks.

### The fleet

The master routes tasks across your registered repos, spawns workers, watches them, steers them mid-flight (send follow-ups / interrupt), and gets woken when they finish. Follow-up instructions continue the same worker session with full context. After a daemon restart, workers rehydrate from disk — diffs, stop, and resume keep working.

### Automation

Rules = **trigger × action**, built in the Automation page:

| Triggers | Actions |
|---|---|
| Cron schedule · every N minutes · Slack message match · **worker settled** (idle / stopped / failure) | Run a master turn · spawn a worker |

Template variables (`{{message}}`, `{{branch}}`, `{{tail}}`, …) carry the trigger's context into the prompt — always fenced as untrusted input. Failures surface in the attention bell.

### Slack

A thread is a session: mention `@rookery` or use the Assistant panel, and the same thread stays the same conversation across daemon restarts. Tool calls render as live plan cards; worker activity can be relayed to a channel. Access is allowlist-gated and fail-closed. See [Slack setup](#slack-setup) below.

### Use rookery from other agents (External MCP)

Expose the fleet as an MCP server (**Settings → General → External MCP**, off by default):

```bash
claude mcp add rookery --transport http "http://127.0.0.1:8787/mcp-ext/<token>"
```

- **Read-only**: list workers, inspect status/transcripts/diffs.
- **Full control**: also spawn, steer, and stop workers.

> ⚠️ Full control lets an external agent drive workers that run with `bypassPermissions`. Enable only for clients you trust; rotate the token from Settings if a URL leaks.

## Install

- **macOS (Apple Silicon):** [⬇ `.dmg`](https://github.com/CChuYong/rookery/releases/latest/download/rookery-arm64.dmg)
- **Linux (x86_64):** [⬇ `.AppImage`](https://github.com/CChuYong/rookery/releases/latest/download/rookery-x86_64.AppImage)
- **Windows (x64):** [⬇ `.exe` installer](https://github.com/CChuYong/rookery/releases/latest/download/rookery-x64-setup.exe)

## Quick start

**Desktop app — no prerequisites.** Download it above, launch, done: the app bundles its own Node runtime and starts and manages the daemon for you. A first-run checklist walks you through the rest — connect Claude (paste an API key in Settings, or an existing `claude login` is picked up automatically), pick a work folder, start a session, and spawn your first worker. Codex is optional — authenticate the `codex` CLI or set an in-app key to unlock the second backend.

**Headless / CLI** — requires **Node.js ≥ 22**:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node dist/index.js daemon      # run the daemon in the foreground
node dist/index.js             # or use the CLI (auto-starts a daemon if none is running)
```

Build from source (Node.js ≥ 22):

```bash
npm install && npm run build   # daemon/CLI → dist/
npm -w apps/desktop run dev    # desktop app (dev), run from a Node 22 shell
```

Architecture and contributor docs live in [`docs/`](docs/README.md) (start there) and `AGENTS.md`.

## Backends & authentication

Both backends reach the same orchestration and tools; pick per session/worker/automation/Slack thread (or `--provider claude|codex` on the CLI).

- **Claude** — in-app API key (**Settings → Anthropic API key**) or `ANTHROPIC_API_KEY`; falls back to Claude Code OAuth (`claude login`). All permission modes supported.
- **Codex** — in-app key (**Settings → Codex API key**) or `codex login`. Model/effort pickers are driven by the live model catalog. Codex **masters** are `bypassPermissions`-only (workers are unaffected).

## Data handling

**What leaves your machine:** prompts and responses, referenced repository code/diffs/terminal output, and (if connected) Slack message text — sent to the LLM provider of the surface that runs them. Claude surfaces talk to Anthropic; Codex surfaces route the same data to OpenAI. The provider is always explicit and selectable per surface — review it before pointing a second vendor at sensitive code.

**What stays local:** everything else. Conversation history, memory, integration tokens, logs, and worker worktrees live under `~/.rookery` (hardened to `0700`/`0600` on boot). The desktop app shows a one-time data-transmission consent screen on first run.

## Security note

The master and workers run with `permissionMode: "bypassPermissions"` (a headless daemon has no TTY for approval prompts): they auto-approve tool use, including bash and file writes, in their working directories. Worktree isolation contains workers to their own copies, and USD budgets/turn caps bound runaway cost — but run rookery only in trusted environments and paths.

## Slack setup

1. Create an app at https://api.slack.com/apps.
2. Enable **Socket Mode** → issue an App-Level Token (scope `connections:write`) → `SLACK_APP_TOKEN` (xapp-…).
3. **OAuth & Permissions** → Bot Token Scopes: `assistant:write`, `chat:write`, `app_mentions:read`, `im:history`, `channels:history` → install to the workspace → `SLACK_BOT_TOKEN` (xoxb-…).
4. Enable the **Agents & Assistants** feature; subscribe to `app_mention`, `assistant_thread_started`, `message.im`, and `message.channels` (required for Slack automation triggers; invite the bot to the target channels).

Paste both tokens in **Settings → Slack** (or export them as env vars for headless runs). The allowlist is fail-closed: with an empty allowlist and allow-all off, everyone is refused. Slack threads run on Claude by default; `slackProvider: codex` switches them (bypassPermissions-only, like all Codex masters).

## License & third-party notices

rookery's own source code is licensed under the [Apache License 2.0](LICENSE).

⚠️ rookery is built on the **Anthropic Claude Agent SDK**, which is **proprietary software (© Anthropic PBC, all rights reserved)** and is **not** covered by this Apache-2.0 license. Using or distributing rookery is subject to Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) / [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Usage Policy](https://www.anthropic.com/legal/aup), and the [Claude Code legal terms](https://code.claude.com/docs/en/legal-and-compliance).

In short: **bring your own credentials**; do not pool or route subscription credentials on behalf of other users; a multi-tenant hosted service needs Anthropic's approval. The Apache-2.0 license covers only this project's code — see [NOTICE](NOTICE) for full third-party notices.
