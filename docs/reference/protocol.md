# Wire Protocol Catalog

> **Source of truth:** `src/protocol/messages.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

The daemon exposes HTTP `/health` + a WebSocket `/ws` (`noServer` mode). All client↔daemon traffic flows over `/ws`. Handlers live in `src/daemon/connection.ts`; the event side is sibling [events.md](./events.md).

## Transport model

- **Inbound (client→server):** validated with the zod `clientMessageSchema` (discriminated union on `type`) via `parseClientMessage`. A parse failure replies `{type:"error", message:"invalid message: …"}`. Handler throws are caught and replied as `{type:"error", message, reqId?}` (so a hung `request()` never results).
- **Outbound (server→client):** `ServerMessage`, just `JSON.stringify`'d by `serializeServerMessage` — **no schema validation**.
- **`reqId` correlation:** request-style messages carry a `reqId`; the matching `ServerMessage` echoes it. `RequestResultMap` is the 1:1 type map between request `type` and its reply `ServerMessage` (must stay in sync with `connection.ts`). Fire-and-forget messages (`session.send`/`attach`, `worker.send`/`setModel`/`setPermissionMode`, `interaction.respond`, all `*.subscribe`) have no `reqId` and no reply. Mutations without a dedicated ack reply with `fleet.ack`.
- **Channels / live events:** `events.subscribe` subscribes the connection to `@all` (every event); `fleet.subscribe` to `@fleet` (worker events); session-bearing messages (`session.create/open/attach/send`) auto-subscribe that session id. Subscribing `@all` dedupes/replaces narrower subscriptions. Live events arrive as `{type:"event", event: CoreEvent}`.
- **Auth:** WS connections require the `~/.rookery/ws-token` shared secret + a local-Origin gate (`timingSafeEqual`). See AGENTS.md §"Daemon / Protocol".

## Client → Server messages

`reqId` column: ✓ = always present, opt = optional, — = none (fire-and-forget). "Reply" is the `ServerMessage` `type` returned (per `RequestResultMap` / `connection.ts`).

| `type` | reqId | Key fields | Purpose | Reply |
|---|---|---|---|---|
| `session.create` | opt | `cwd?` | create a master session | `session.created` |
| `session.open` | opt | `key`, `cwd?` | find-or-create by external key (e.g. Slack thread) | `session.created` |
| `session.attach` | — | `sessionId` | subscribe to a session's events | (none) |
| `session.send` | — | `sessionId`, `text`, `model?`, `effort?`, `permissionMode?`, `clientMsgId?` | run a master turn (per-session overrides) | (none; streams events) |
| `session.stop` | opt | `sessionId` | interrupt the in-progress master turn | `fleet.ack` (action `stop`) |
| `interaction.respond` | opt | `requestId`, `decision?`, `answers?` | answer a master canUseTool card | (none; `interaction.resolved` event) |
| `session.delete` | ✓ | `sessionId` | delete a session | `fleet.ack` (`delete`) |
| `session.archive` | ✓ | `sessionId`, `archived` | archive/unarchive | `fleet.ack` (`archive`) |
| `session.rename` | ✓ | `sessionId`, `label` | rename | `fleet.ack` (`rename`) |
| `session.pin` | ✓ | `sessionId`, `pinned` | pin/unpin | `fleet.ack` (`pin`) |
| `session.list` | opt | — | list sessions | `session.list.result` |
| `session.history` | ✓ | `sessionId` | replay persisted `session_events` | `session.history.result` |
| `worker.list` | opt | `sessionId` | list fleet (per-session view) | `worker.list.result` |
| `worker.archive` | ✓ | `id`, `archived` | archive/unarchive a worker | `fleet.ack` (`archive`) |
| `worker.rename` | ✓ | `id`, `label` | rename a worker (emits `worker.label`) | `fleet.ack` (`rename`) |
| `worker.delete` | ✓ | `id` | discard worktree + remove DB row | `fleet.ack` (`delete`) |
| `worker.history` | ✓ | `id` | replay persisted `worker_events` | `worker.history.result` |
| `worker.send` | opt | `id`, `text`, `clientMsgId?` | follow-up to a running worker | (none) |
| `worker.setModel` | opt | `id`, `model` | live-change worker model | (none) |
| `worker.setPermissionMode` | opt | `id`, `permissionMode` (`bypassPermissions\|plan`) | live-change worker permission mode | (none) |
| `worker.interrupt` | opt | `id` | interrupt worker turn (session preserved) | `fleet.ack` (`interrupt`) |
| `worker.checkpoints` | ✓ | `id` | list worktree checkpoints | `worker.checkpoints.result` |
| `worker.restore` | ✓ | `id`, `seq` | restore worker to a checkpoint | `fleet.ack` (`restore`) |
| `fleet.list` | ✓ | — | list the whole fleet | `fleet.list.result` |
| `fleet.diff` | ✓ | `id` | worktree diff of a worker | `fleet.diff.result` |
| `fleet.stop` | ✓ | `id` | stop worker (keep worktree) | `fleet.ack` (`stop`) |
| `fleet.discard` | ✓ | `id` | discard worker (remove worktree+branch) | `fleet.ack` (`discard`) |
| `fleet.spawn` | ✓ | `repo`, `task?`, `label?`, `model?`, `effort?`, `permissionMode?`, `base?`, `ticketKey?`, `ticketUrl?` | spawn a worker from the UI | `fleet.spawn.result` |
| `fleet.subscribe` | — | — | subscribe to `@fleet` | (none) |
| `events.subscribe` | — | — | subscribe to `@all` (+ initial `slack.status`) | (none; events) |
| `repos.list` | ✓ | — | list registered repos | `repos.list.result` |
| `repo.branches` | ✓ | `repo` | list branches of a repo | `repo.branches.result` |
| `repos.register` | ✓ | `name`, `path`, `description`, `base?` | register a repo (`base` ref-validated) | `repos.ack` (`register`) |
| `repos.update` | ✓ | `name`, `description?`, `base?` | update a repo | `repos.ack` (`update`) |
| `repos.remove` | ✓ | `name` | remove a repo | `repos.ack` (`remove`) |
| `source.fetch` | ✓ | `url` | fetch a source item (issue/PR) | `source.fetch.result` |
| `source.search` | ✓ | `provider` (`github\|linear`), `query`, `repo?` | search a source provider | `source.search.result` |
| `integrations.status` | ✓ | — | gh/linear connection status | `integrations.status.result` |
| `auth.status` | ✓ | — | active Claude auth (api-key vs OAuth) | `auth.status.result` |
| `commands.list` | ✓ | `cwd?`, `workerId?` | slash-command/skill candidates | `commands.result` |
| `capabilities.snapshot` | ✓ | `target: {kind:"session"\|"worker", id}` | read the selected target's effective capability inventory | `capabilities.snapshot.result` |
| `usage.get` | ✓ | — | usage snapshot | `usage.result` |
| `models.list` | ✓ | — | available models (live or static) | `models.result` |
| `settings.get` | ✓ | — | read settings | `settings.result` |
| `settings.set` | ✓ | `settings` (see below) | write settings; secrets handled separately | `settings.result` |
| `slack.set` | opt | `enabled` | turn the Slack bot on/off | `slack.ack` |
| `automation.list` | ✓ | — | list automations (hides `once`) | `automation.list.result` |
| `automation.create` | ✓ | `automation` (input schema) | create; emits `automation.changed` | `automation.result` |
| `automation.update` | ✓ | `id`, `patch` | update | `automation.result` |
| `automation.set_enabled` | ✓ | `id`, `enabled` | toggle | `automation.result` |
| `automation.delete` | ✓ | `id` | delete | `fleet.ack` (`delete`) |
| `automation.run` | ✓ | `id`, `vars?` | fire once now | `fleet.ack` (`run`) |

Notes:
- **`capabilities.snapshot` target authority:** the client sends only target kind/id. The daemon resolves provider, label, cwd, and worker worktree from persisted rows; it never trusts client-supplied runtime metadata. The reply merges Rookery built-ins with provider inventory. Independent provider probe failures remain in `diagnostics[]` while successful entries stay visible; unknown is not encoded as an empty successful list. Slice 1 is read-only and supports session/worker targets only.
- **`settings.set` `settings` object:** `masterName`, `masterModel`, `workerModel`, `masterEffort`, `workerEffort`, `slackCwd`, `slackAllowedUsers`, `slackAllowAll`, `slackRefuseReply`, `slackRefusalMessage`, `slackLocale`, `usageRefreshMs`, `hasAcceptedDataNotice` (echoed back), and write-only secrets **not echoed**: `linearApiKey`, `anthropicApiKey`, `slackBotToken`, `slackAppToken`. `null`/empty string clears a key (reverts to config default). `effort` fields are membership-validated against `low\|medium\|high\|xhigh\|max`. Changing a Slack token triggers `slack.reconcile()`.
- **`automation` / `patch` (`automationInputSchema`):** `name`, `enabled?`, `trigger` (discriminated on `kind`: `cron`{`cron`,`timezone`} validated by `isValidCron` in `superRefine`, or `slack`{`channels?`,`keyword?`,`fromUsers?`}), `action` (`master`{`prompt`,`cwd`,`sessionMode:reuse\|fresh`} or `worker`{`repo`,`task`,`base?`}), `model?`, `effort?`, `permissionMode?`, `maxTurns?`.
- **`automation.run` `vars`:** partial `{message, channel, user, ts, threadTs, team}`.

## Server → Client messages

| `type` | Key fields | Purpose |
|---|---|---|
| `session.created` | `sessionId`, `cwd`, `reqId?` | reply to `session.create`/`session.open` |
| `session.list.result` | `sessions[]` (`id,cwd,status,lastActivity,origin,originRef,label,archived,pinned`), `reqId?` | session list |
| `worker.list.result` | `sessionId`, `workers: WorkerRow[]`, `reqId?` | per-session fleet list |
| `fleet.list.result` | `reqId`, `fleet: (WorkerRow & {archived})[]` | full fleet list |
| `fleet.diff.result` | `reqId`, `id`, `diff` | worktree diff text |
| `fleet.ack` | `reqId`, `action`, `id` | generic mutation ack (stop/discard/delete/archive/rename/pin/restore/interrupt/run) |
| `fleet.spawn.result` | `reqId`, `id` | new worker id |
| `repos.list.result` | `reqId`, `repos[]` (`name,path,description,base`) | repo list |
| `repo.branches.result` | `reqId`, `branches[]` | branch list |
| `repos.ack` | `reqId`, `action`, `name` | repo mutation ack |
| `source.fetch.result` | `reqId`, `item: {title,body}\|null` | fetched source item |
| `source.search.result` | `reqId`, `items: SourceItem[]` | source search results |
| `integrations.status.result` | `reqId` + `IntegrationsStatus` (`github`,`linear`) | integration status |
| `auth.status.result` | `reqId` + `AuthStatus` | Claude auth status |
| `session.history.result` | `reqId`, `sessionId`, `events[]` (`seq,type,payload,createdAt`) | replayed master transcript |
| `worker.history.result` | `reqId`, `id`, `events[]` | replayed worker transcript |
| `worker.checkpoints.result` | `reqId`, `id`, `checkpoints[]` (`seq,sha,createdAt`) | worktree checkpoints |
| `usage.result` | `reqId`, `usage: UsageSnapshot` | usage snapshot |
| `models.result` | `reqId`, `models[]` (`id,displayName`) | model picker list |
| `commands.result` | `reqId`, `commands: SlashCommandInfo[]` | slash-command candidates |
| `capabilities.snapshot.result` | `reqId`, `snapshot: CapabilitySnapshot` | authoritative target metadata, effective entries, and per-source diagnostics |
| `settings.result` | `reqId`, `settings: SettingsValues` | settings (secrets omitted) |
| `slack.ack` | `reqId?`, `status: SlackStatus` | Slack toggle result |
| `automation.list.result` | `reqId`, `automations: Automation[]` | automation list |
| `automation.result` | `reqId`, `automation: Automation` | created/updated/toggled automation |
| `event` | `event: CoreEvent` | a live `CoreEvent` (see [events.md](./events.md)) |
| `error` | `message`, `reqId?` | parse/handler failure |

`WorkerRow` (shared by worker.list/fleet.list): `id`, `label`, `repoPath`, `status`, `branch`, `model`, `permissionMode?`, `ticketKey?`, `ticketUrl?` (no `pr_url` — there is no automatic PR pipeline).
