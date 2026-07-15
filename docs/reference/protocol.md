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
| `repos.list` | ✓ | — | list registered repos with authoritative ids | `repos.list.result` |
| `repo.branches` | ✓ | `repo` | list branches of a repo | `repo.branches.result` |
| `repos.register` | ✓ | `name`, `path`, `description`, `base?` | register a repo (`base` ref-validated) | `repos.ack` (`register`) |
| `repos.update` | ✓ | `name`, `description?`, `base?` | update a repo | `repos.ack` (`update`) |
| `repos.remove` | ✓ | `name` | remove a repo | `repos.ack` (`remove`) |
| `source.fetch` | ✓ | `url` | fetch a source item (issue/PR) | `source.fetch.result` |
| `source.search` | ✓ | `provider` (`github\|linear`), `query`, `repo?` | search a source provider | `source.search.result` |
| `integrations.status` | ✓ | — | gh/linear connection status | `integrations.status.result` |
| `auth.status` | ✓ | — | active Claude auth (api-key vs OAuth) | `auth.status.result` |
| `commands.list` | ✓ | `sessionId?`, `workerId?`, `cwd?`, `provider?` | executable slash actions/skills for one context (`sessionId` and `workerId` are mutually exclusive) | `commands.result` |
| `capabilities.snapshot` | ✓ | `target: {kind:"session"\|"worker", id}` | read the selected target's effective capability inventory | `capabilities.snapshot.result` |
| `capabilities.library` | ✓ | — | list sanitized packs, bindings, secret metadata, and generation | `capabilities.library.result` |
| `capabilities.mcp.create` | ✓ | `input:{id,displayName,description,mcpServer,secretValues?}` | register one untrusted MCP Catalog entry without a binding | `capabilities.catalog.create.result` |
| `capabilities.skill.create` | ✓ | `input:{id,displayName,description,sourcePath}` | copy and register one untrusted Skill Catalog entry without a binding | `capabilities.catalog.create.result` |
| `capabilities.mcpPack.create` | ✓ | `input:{id,displayName,version,description,repoId,agents,mcpServers,secretValues?}` | create an untrusted Rookery-owned MCP pack and repo-local UI binding | `capabilities.mcpPack.result` |
| `capabilities.pack.add` | ✓ | `path` | validate and register a local pack directory | `capabilities.pack.result` |
| `capabilities.pack.remove` | ✓ | `instanceId` | remove a pack and its dependent local state | `capabilities.pack.result` (`pack:null`) |
| `capabilities.binding.set` | ✓ | `id`, `binding` | create or replace one scoped binding | `capabilities.binding.result` |
| `capabilities.binding.quickSet` | ✓ | `input:{packInstanceId,scopeKind,scopeRef,mode,agents}` | atomically replace a simple UI-only Master/Worker binding (`inherit\|enabled\|disabled`) | `capabilities.binding.quickSet.result` |
| `capabilities.binding.delete` | ✓ | `id` | delete one binding | `capabilities.binding.result` (`binding:null`) |
| `capabilities.trust.set` | ✓ | `instanceId`, `digest`, `trusted` | trust or untrust the exact current pack digest | `capabilities.pack.result` |
| `capabilities.secret.set` | ✓ | `instanceId`, `key`, `value` | set a declared write-only pack secret | `capabilities.secret.result` |
| `capabilities.secret.delete` | ✓ | `instanceId`, `key` | clear a declared pack secret | `capabilities.secret.result` |
| `capabilities.refresh` | ✓ | `instanceId?` | revalidate one pack or the whole library | `capabilities.refresh.result` |
| `capabilities.worker.reload` | ✓ | `workerId`, `whenIdle?` | replace a worker provider stream now, schedule at idle, or record next-start for a detached worker | `capabilities.worker.reload.result` |
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
- **`commands.list` target authority:** an existing conversation sends exactly one of `sessionId` or `workerId`; the daemon ignores any accompanying cwd/provider hint, snapshots the persisted target, and returns only entries with an executable invocation plus Rookery client actions. A cold new-session preview has no target, so it may use `cwd`/`provider`; Claude supported commands become `insert-prompt` actions and Codex returns no guessed cold commands. Provider inventory without an SDK/app-server invocation never appears in this response.
- **`capabilities.snapshot` target authority:** the client sends only target kind/id. The daemon resolves provider, label, cwd, repository, origin, home session, and worker worktree from persisted rows; it never trusts client-supplied runtime metadata. The reply merges Rookery built-ins, provider inventory, and managed entries. `desiredRevision` is deterministic and `desiredBlocked` reports fail-closed required state. Claude and Codex snapshots expose `appliedRevision` (`null` before confirmation) and remap launchable managed entries to `applied`, `pending-next-turn`, `pending-reload`, or `error`; blocked/unavailable/suppressed entries retain their more precise resolver state. Independent provider probe failures remain in `diagnostics[]` while successful entries stay visible; unknown is not encoded as an empty successful list.
- **Binding shape:** `binding` is `{packInstanceId, scopeKind, scopeRef, audience:{agents,origins}, enabled}`. `scopeKind` is `rookery|repo-local|repo-shared|session|worker`; Rookery uses an empty `scopeRef`, while every other scope uses the authoritative repo/session/worker id. Audience agents are `master|worker|side` and origins are `ui|slack|automation|external`.
- **Generated MCP pack creation:** `capabilities.mcpPack.create` accepts one or more provider-neutral stdio/streamable-HTTP declarations. The daemon writes a public `capability.json` under `<ROOKERY_HOME>/capability-packs`, stores supplied `secretValues` only through the write-only secret registry, and creates one enabled `repo-local` binding for the authoritative `repoId`, the requested `master|worker` agents, and UI origin. Creation never trusts the digest; users must review and trust the returned pack before it can execute. Removing a `rookery-generated` pack also removes its Rookery-owned directory.
- **Lightweight Catalog creation:** `capabilities.mcp.create` creates one-MCP generated pack; `capabilities.skill.create` copies one contained, symlink-safe Skill snapshot and validates its `SKILL.md` before atomic installation. Neither creates a binding or trust decision. Registration, declared-secret, and owned-directory state roll back together on failure.
- **Repository quick binding:** `capabilities.binding.quickSet` manages only `rookery|repo-local`, UI origin, and Master/Worker agents. `inherit` removes the simple override, `enabled` creates an enabled row, and `disabled` creates a tombstone. Replacement is one SQLite transaction and refuses custom overlapping rows (mixed origins or Side) instead of overwriting them.
- **Capability secret boundary:** `value` exists only on `capabilities.secret.set` and authenticated MCP creation `secretValues` maps. Library and mutation replies expose only `{key, configured}`; generated pack documents contain secret references, never expanded values. The daemon rejects undeclared keys and redacts submitted values from correlated creation errors.
- **Worker capability reload:** `whenIdle:false` rejects a busy worker. `whenIdle:true` acknowledges with `mode:"scheduled"` and begins only after the active turn settles. An idle live worker returns `mode:"reloading"` after replacement completes; a detached resumable worker returns `mode:"next-start"` without materializing it. Only the short replacement phase rejects `worker.send`.
- **Repo-shared authority:** registered repos may declare schema 1 `packs[]` in `.rookery/capabilities.json`, with each `{path, disabled?}` contained below `.rookery/capabilities/`. Discovery never creates bindings or trust. `CapabilityLibrarySnapshot.diagnostics[]` isolates index/pack failures, and exact-digest trust automatically stops matching after content changes.
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
| `repos.list.result` | `reqId`, `repos[]` (`id,name,path,description,base`) | repo list with ids used by capability scopes |
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
| `commands.result` | `reqId`, `commands: CommandCandidate[]` | executable candidates; every item carries a structured `CommandAction` |
| `capabilities.snapshot.result` | `reqId`, `snapshot: CapabilitySnapshot` | authoritative target metadata, effective entries, and per-source diagnostics |
| `capabilities.library.result` | `reqId`, `library: CapabilityLibrarySnapshot` | sanitized pack, binding, repo-discovery diagnostic, and generation inventory |
| `capabilities.catalog.create.result` | `reqId`, `pack: CapabilityLibraryEntry` | sanitized singleton MCP/Skill registration result; no binding or secret values |
| `capabilities.mcpPack.result` | `reqId`, `pack: CapabilityLibraryEntry`, `binding: CapabilityBinding` | sanitized generated-pack creation result; no secret values |
| `capabilities.pack.result` | `reqId`, `pack: CapabilityLibraryEntry\|null` | pack mutation result |
| `capabilities.binding.result` | `reqId`, `binding: CapabilityBinding\|null` | binding mutation result |
| `capabilities.binding.quickSet.result` | `reqId`, `binding: CapabilityBinding\|null` | canonical simple assignment, or `null` for inherit |
| `capabilities.secret.result` | `reqId`, `instanceId`, `secret:{key,configured}` | write-only secret mutation status |
| `capabilities.refresh.result` | `reqId`, `library: CapabilityLibrarySnapshot` | sanitized post-refresh inventory |
| `capabilities.worker.reload.result` | `reqId`, `workerId`, `mode: reloading\|scheduled\|next-start` | worker reload disposition |
| `settings.result` | `reqId`, `settings: SettingsValues` | settings (secrets omitted) |
| `slack.ack` | `reqId?`, `status: SlackStatus` | Slack toggle result |
| `automation.list.result` | `reqId`, `automations: Automation[]` | automation list |
| `automation.result` | `reqId`, `automation: Automation` | created/updated/toggled automation |
| `event` | `event: CoreEvent` | a live `CoreEvent` (see [events.md](./events.md)) |
| `error` | `message`, `reqId?` | parse/handler failure |

`WorkerRow` (shared by worker.list/fleet.list): `id`, `label`, `repoPath`, `status`, `branch`, `model`, `permissionMode?`, `ticketKey?`, `ticketUrl?` (no `pr_url` — there is no automatic PR pipeline).

Capability mutations emit `capabilities.changed` on `@all`. Clients use its monotonic
in-process `generation` as an invalidation signal and refetch. Claude application also
emits target-routed `capabilities.runtime`; clients increment their local invalidation
clock and refetch the authoritative snapshot. Neither event carries pack bodies,
instructions, public config, command lines, or secret values.
