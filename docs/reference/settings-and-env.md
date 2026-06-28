# Settings and Environment

> **Source of truth:** `src/core/settings.ts` (the `Settings` class + `SettingsValues` + secret getters), `src/config.ts` (`loadConfig` env vars) — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper. See AGENTS.md §"Environment variables" for the short table; verify against `config.ts` directly.

## Two layers

- **Settings (DB)** — the `settings` table, accessed via the `Settings` class. **Live**: every getter reads the DB on each call (no snapshotting), so UI changes take effect immediately. Mutated via `apply(patch)` where `null` deletes a key (reverts to default).
- **Environment / config** — `loadConfig` (`src/config.ts`) reads env once at boot into `Config`. For overlapping keys, **DB settings take priority and env/config is the fallback** (headless/CI compatible).

## Settings (DB)

`SettingsValues` — non-secret keys returned by `all()` and echoed via `settings.get`/`settings.result`. All values are stored and returned as **strings** (parsed by consumers).

| Key | Default | Echoed? | Meaning |
|---|---|---|---|
| `masterName` | `"rookery"` (`DEFAULT_MASTER_NAME`) | yes | Master's name in the system prompt. Settings-only (no env fallback); read trims + caps at 64 chars, empty → default. |
| `masterModel` | `config.masterModel` (`ROOKERY_MASTER_MODEL`, `claude-opus-4-8`) | yes | Master model. |
| `workerModel` | `config.workerModel` (`ROOKERY_WORKER_MODEL`, `claude-opus-4-8`) | yes | Default worker model. |
| `masterEffort` | `config.masterEffort` (`ROOKERY_MASTER_EFFORT`, `high`) | yes | Master effort. |
| `workerEffort` | `config.workerEffort` (`ROOKERY_WORKER_EFFORT`, `high`) | yes | Default worker effort. |
| `slackCwd` | `process.cwd()` | yes | cwd for Slack-originated sessions. Settings-only. |
| `slackAllowedUsers` | `""` | yes | Comma-separated user ids allowed to get responses. Settings-only. |
| `slackAllowAll` | `"0"` | yes | `"1"` allows everyone. Fail-closed default. Settings-only. |
| `slackRefuseReply` | `"1"` | yes | `"1"`/`"0"` — auto-reply to non-allowed users. |
| `slackRefusalMessage` | `DEFAULT_SLACK_REFUSAL` ("Sorry, you're not authorized to use this bot.") | yes | Refusal reply text. |
| `slackLocale` | `"ko"` (via `resolveLocale`) | yes | Slack output language (`ko`/`en`). |
| `usageRefreshMs` | `120000` (`DEFAULT_USAGE_REFRESH_MS`) | yes | Usage refresh interval (ms). Applied at boot. |
| `hasAcceptedDataNotice` | `"0"` | yes | First-run data-transmission consent flag (`"1"` accepted). Not secret. |

**Write-only secrets** — outside `SettingsValues`, separate getters/setters, **never echoed** via `settings.get`. Each prefers DB, falls back to env/config:

| Key | Env fallback | Meaning |
|---|---|---|
| `slackBotToken` | `SLACK_BOT_TOKEN` | Slack bot token. |
| `slackAppToken` | `SLACK_APP_TOKEN` | Slack app token. Both tokens present → `slackConfigured()` true. |
| `linearApiKey` | `ROOKERY_LINEAR_API_KEY` | Linear integration key. |
| `anthropicApiKey` | `ANTHROPIC_API_KEY` | Anthropic API key. Injected into `process.env.ANTHROPIC_API_KEY` at boot / on save (`applyApiKeyToEnv`) so the SDK subprocess, models-provider, and auth-status pick it up. |

## Environment variables

Resolved in `src/config.ts::loadConfig` (env read once at boot).

| Variable | Default | Effect |
|---|---|---|
| `ROOKERY_HOME` | `~/.rookery` | Base dir → `dbPath`, `pidPath`, `tokenPath`, `fleet.worktreesDir`. |
| `ROOKERY_HOST` | `127.0.0.1` | WS/HTTP bind host (non-local host warns about plaintext token). |
| `ROOKERY_PORT` | `8787` | WS/HTTP port. Valid range `[0,65535]` (0 = OS-assigned); invalid → `8787`. |
| `ROOKERY_MASTER_MODEL` | `claude-opus-4-8` | Master default model (settings fallback). |
| `ROOKERY_WORKER_MODEL` | `claude-opus-4-8` | Worker default model (settings fallback). `.env.example` shows `sonnet` as an example, but the code default is opus. |
| `ROOKERY_MASTER_EFFORT` | `high` | Master default effort. |
| `ROOKERY_WORKER_EFFORT` | `high` | Worker default effort. |
| `ANTHROPIC_API_KEY` | (none) | Default Anthropic key (DB `anthropicApiKey` takes priority). If absent, SDK falls back to OAuth (`claude login`); `detectAuth` is a hint only and never blocks startup. |
| `SLACK_BOT_TOKEN` | (none) | Slack bot token fallback (DB `slackBotToken` takes priority). |
| `SLACK_APP_TOKEN` | (none) | Slack app token fallback. Bot enabled only when **both** tokens are present. |
| `ROOKERY_LINEAR_API_KEY` | (none) | Linear key fallback (DB `linearApiKey` takes priority). |
| `ROOKERY_CCUSAGE_CMD` | `~/.bun/bin/bunx ccusage@latest` (or `bunx` if bunx not found) | Usage-collection command. JSON-array form preserves arg boundaries (spaces in paths); otherwise whitespace-split. |

**Removed env vars — now settings-only (DB):** `ROOKERY_MAX_WORKERS` (concept deleted), `ROOKERY_SLACK_CWD` → `slackCwd`, `ROOKERY_SLACK_ALLOWED_USERS` → `slackAllowedUsers`, `ROOKERY_SLACK_ALLOW_ALL` → `slackAllowAll`, `ROOKERY_USAGE_REFRESH_MS` → `usageRefreshMs`.
