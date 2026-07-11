# rookery

**An open-source agentic development environment: a resident AI orchestrator with memory, a fleet of coding workers isolated in git worktrees, and mission control to run it all — on your machine.**

A long-lived daemon hosts **master agent** sessions that register your repos, remember project context, and spawn **workers** that code in parallel — each in its own git worktree and branch, on the AI backend you choose (**Claude or Codex**). The desktop app, CLI, and Slack are thin clients: close them anytime, the daemon keeps working.

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

Requirements: **Node.js ≥ 22** and Anthropic credentials (an API key, or a `claude login` session as fallback). Codex is optional — authenticate the `codex` CLI or set an in-app key to unlock the second backend.

```bash
# Desktop app: just launch it — it starts and manages the daemon for you.

# Or headless:
export ANTHROPIC_API_KEY=sk-ant-...
node dist/index.js daemon      # run the daemon in the foreground
node dist/index.js             # or use the CLI (auto-starts a daemon if none is running)
```

Build from source:

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
