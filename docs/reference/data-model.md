# Data Model (SQLite)

> **Source of truth:** `src/persistence/db.ts` (schema + migration framework), `src/persistence/repositories.ts` (row types + access patterns) — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

## Basics

- **Engine:** `better-sqlite3` (synchronous, no async/await).
- **Pragmas** (set in `openDb`): `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- **STRICT tables:** every table is declared `STRICT` — column types are enforced, no silent affinity coercion.
- **Single squashed baseline migration.** `MIGRATIONS` is an **append-only array**; the index is the version number. The entire pre-release history was squashed into one CREATE-only baseline (`MIGRATIONS[0]`) — no `ALTER`/backfill cruft, and there are no in-the-wild DBs to migrate. **Never modify an existing entry; only append a new one.** `db.test.ts` asserts `currentVersion === MIGRATIONS.length`.
- **Versioning / downgrade guard:** `schema_version` holds a single integer row. `openDb` runs every migration from the stored version up to `MIGRATIONS.length` in one transaction, then rewrites `schema_version`. If the stored version is **newer** than the build (`from > MIGRATIONS.length`) it throws (refuses to open a DB written by a newer daemon).
- The DB lives at `~/.rookery/rookery.db` (`Config.dbPath`); tests use `openDb(":memory:")`.

## Tables

### `sessions`
One row per master conversation.

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | TEXT | PK | Session id |
| `cwd` | TEXT | NOT NULL | Working directory for the session |
| `status` | TEXT | NOT NULL, default `'active'` | Lifecycle status |
| `sdk_session_id` | TEXT | nullable | SDK session id for `resume` (continue context) |
| `external_key` | TEXT | UNIQUE, nullable | External dedupe key (e.g. Slack `slack:team:channel:threadTs`, automation key) |
| `created_at` | TEXT | NOT NULL | ISO timestamp |
| `updated_at` | TEXT | NOT NULL | ISO timestamp |
| `label` | TEXT | nullable | Auto-generated (Haiku) label; UI falls back to cwd folder name |
| `archived_at` | TEXT | nullable | Archive timestamp; hides from list (restorable) |
| `origin` | TEXT | nullable | Source: `ui` \| `slack` \| `automation` |
| `origin_ref` | TEXT | nullable | Identifier within the source (slack thread key / automation id) |
| `pinned_at` | TEXT | nullable | Pin timestamp for the sidebar 'pinned' section |
| `provider` | TEXT | NOT NULL, default `'claude'` | Which `AgentBackend` runs this session: `claude`\|`codex` (P2) |

### `messages`
Text-only transcript (used for text + `last_activity`). Tool/thinking/metrics events live in `session_events`.

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Row id |
| `session_id` | TEXT | NOT NULL, FK → `sessions(id)` | Owning session |
| `role` | TEXT | NOT NULL | Message role |
| `content` | TEXT | NOT NULL | Message text |
| `created_at` | TEXT | NOT NULL | ISO timestamp |

Index: `idx_messages_session (session_id, id)`.

### `session_events`
Master (session) transcript events — restores tool cards / thinking / metrics / notice on reconnect/restart (the master counterpart of `worker_events`).

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Row id |
| `session_id` | TEXT | NOT NULL, FK → `sessions(id)` | Owning session |
| `seq` | INTEGER | NOT NULL | Monotonic position within the session |
| `type` | TEXT | NOT NULL | Event type |
| `payload_json` | TEXT | NOT NULL | JSON-encoded payload |
| `created_at` | TEXT | NOT NULL | ISO timestamp |

Index: `idx_session_events (session_id, seq)`.

### `workers`
One row per spawned worker (fleet member).

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | TEXT | PK | Worker id (branch `rookery/<id>`) |
| `session_id` | TEXT | NOT NULL, FK → `sessions(id)` | Spawning session |
| `repo_path` | TEXT | NOT NULL | Registered repo path |
| `label` | TEXT | NOT NULL | Worker label |
| `status` | TEXT | NOT NULL, default `'running'` | `running`\|`idle`\|`stopped`\|`done`\|`error` + orchestrator-only `failed`\|`orphaned` |
| `created_at` | TEXT | NOT NULL | ISO timestamp |
| `updated_at` | TEXT | NOT NULL | ISO timestamp |
| `worktree_path` | TEXT | nullable | `~/.rookery/worktrees/<id>` |
| `branch` | TEXT | nullable | Worktree branch |
| `base` | TEXT | nullable | Base ref the worktree branched from |
| `sdk_session_id` | TEXT | nullable | Resume conversation after restart (idle vs orphaned) |
| `model` | TEXT | nullable | Model fixed at spawn / live-changed by `setModel` (UI + restart consistency) |
| `archived_at` | TEXT | nullable | Archive timestamp |
| `ticket_key` | TEXT | nullable | Ticket/issue that spawned this worker (null = created directly) |
| `ticket_url` | TEXT | nullable | Ticket/issue URL |
| `notify_armed` | INTEGER | NOT NULL, default `0` | One-shot: notify the master when this worker next settles |
| `permission_mode` | TEXT | NOT NULL, default `'bypassPermissions'` | SDK permission mode (`bypassPermissions`\|`plan`), live-changeable |
| `max_turns` | INTEGER | nullable | Per-result turn cap (unattended runaway guard). NULL = unlimited. Survives restart/fork. |
| `effort` | TEXT | nullable | Spawn-time effort override. NULL = global default. Survives restart/fork. |
| `provider` | TEXT | NOT NULL, default `'claude'` | Which `AgentBackend` runs this worker: `claude`\|`codex` (P1) |

Index: `idx_workers_session (session_id)`.

### `worker_events`
Worker transcript events (worker counterpart of `session_events`).

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Row id |
| `worker_id` | TEXT | NOT NULL, FK → `workers(id)` | Owning worker |
| `seq` | INTEGER | NOT NULL | Monotonic position within the worker |
| `type` | TEXT | NOT NULL | Event type |
| `payload_json` | TEXT | NOT NULL | JSON-encoded payload |
| `created_at` | TEXT | NOT NULL | ISO timestamp |

Index: `idx_worker_events (worker_id, seq)`.

### `worker_checkpoints`
Per-turn worktree git snapshot — maps a transcript position (`seq`) to a commit sha for "revert to this turn".

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Row id |
| `worker_id` | TEXT | NOT NULL, FK → `workers(id)` | Owning worker |
| `seq` | INTEGER | NOT NULL | Transcript position |
| `sha` | TEXT | NOT NULL | Git snapshot sha |
| `created_at` | TEXT | NOT NULL | ISO timestamp |

Index: `idx_worker_checkpoints (worker_id, seq)`.

### `memories`
Master long-term memory (`remember`/`recall`; recent rows injected into the system prompt each turn).

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Row id |
| `content` | TEXT | NOT NULL | Memory text |
| `tags` | TEXT | NOT NULL, default `''` | Comma-style tag string |
| `created_at` | TEXT | NOT NULL | ISO timestamp |

### `repos`
Registered git repositories (the catalog injected into the master).

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | TEXT | PK | Repo id |
| `name` | TEXT | NOT NULL, UNIQUE | Repo name |
| `path` | TEXT | NOT NULL | Local path |
| `description` | TEXT | NOT NULL, default `''` | Description |
| `base` | TEXT | nullable | Default base branch |
| `remote_url` | TEXT | nullable | Remote URL |
| `created_at` | TEXT | NOT NULL | ISO timestamp |
| `updated_at` | TEXT | NOT NULL | ISO timestamp |

### `settings`
Generic key/value store (all values are strings). See [settings-and-env.md](settings-and-env.md) for keys.

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `key` | TEXT | PK | Setting key |
| `value` | TEXT | NOT NULL | String value |
| `updated_at` | TEXT | NOT NULL | ISO timestamp |

### `automations`
Automation rules = trigger + action (see AGENTS.md §Automation).

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | TEXT | PK | Automation id |
| `name` | TEXT | NOT NULL | Display name |
| `enabled` | INTEGER | NOT NULL, default `0` | On/off |
| `trigger_type` | TEXT | NOT NULL | `cron` \| `slack` |
| `trigger_config_json` | TEXT | NOT NULL | JSON (cron: `{cron,timezone}` · slack: `{channels?,keyword?,fromUsers?}`) |
| `action_type` | TEXT | NOT NULL | `master` \| `worker` |
| `action_config_json` | TEXT | NOT NULL | JSON (master: `{prompt,cwd,sessionMode}` · worker: `{repo,task,base?}`) |
| `model` | TEXT | nullable | Override model |
| `effort` | TEXT | nullable | Override effort |
| `next_run_at` | TEXT | nullable | Next cron fire time |
| `last_run_at` | TEXT | nullable | Last fire time |
| `last_status` | TEXT | nullable | Last run status (e.g. `skipped`) |
| `last_error` | TEXT | nullable | Last error message |
| `created_at` | TEXT | NOT NULL | ISO timestamp |
| `permission_mode` | TEXT | nullable | NULL = `bypassPermissions` (current behavior) |
| `max_turns` | INTEGER | nullable | NULL = unlimited |
| `provider` | TEXT | NOT NULL, default `'claude'` | Which `AgentBackend` runs the session/worker this automation creates: `claude`\|`codex` (P3) |

### `pending_notifications`
Worker-completion notification queue (per session). Enqueued when an armed (`notify_armed`) worker settles.

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK | Row id |
| `session_id` | TEXT | NOT NULL, FK → `sessions(id)` | Target session |
| `text` | TEXT | NOT NULL | Notification text |
| `created_at` | TEXT | NOT NULL | ISO timestamp |

Index: `idx_pending_notifications_session (session_id)`.

### `capability_packs`

One registered local or repository-owned capability-pack instance. `manifest_json` is the registry's sanitized
validated document (manifest, file metadata, change list, validation status, and errors),
not expanded instructions or secret values.

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `instance_id` | TEXT | PK | Stable registry identity; distinct from the manifest's logical id |
| `logical_id` | TEXT | NOT NULL | Current `capability.json` pack id |
| `source_kind` | TEXT | NOT NULL | `rookery-generated` \| `local-directory` \| `repo-shared` |
| `owner_repo_id` | TEXT | nullable, FK → `repos(id)` | Owning repo for a shared pack only |
| `source_path` | TEXT | NOT NULL | Canonical local pack directory |
| `manifest_json` | TEXT | NOT NULL | Sanitized registry document |
| `digest` | TEXT | NOT NULL | SHA-256 trust identity for the whole validated pack |
| `created_at` | TEXT | NOT NULL | ISO timestamp |
| `updated_at` | TEXT | NOT NULL | ISO timestamp |

Unique: `(source_kind, source_path)`.

For `source_kind = repo-shared`, `owner_repo_id` is the authoritative registered repo id
and `source_path` is contained under `<repo>/.rookery/capabilities/`. The checked-in schema-1
index at `<repo>/.rookery/capabilities.json` owns discovery and removal; it stores no trust,
secrets, or bindings. Reconciliation updates an existing instance in place so those local
rows survive ordinary content changes, while the changed digest no longer matches an old
trust row. Invalid indexes leave existing rows present but invalid/fail-closed and expose
sanitized in-memory Library diagnostics.

### `capability_bindings`

Assigns one pack to a scope and audience. `enabled=0` is an explicit higher-precedence
tombstone, not the absence of a binding.

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `id` | TEXT | PK | Client-selected binding id |
| `pack_instance_id` | TEXT | NOT NULL, FK → `capability_packs(instance_id)` | Assigned pack |
| `scope_kind` | TEXT | NOT NULL | `rookery` \| `repo-local` \| `repo-shared` \| `session` \| `worker` |
| `scope_ref` | TEXT | NOT NULL, default `''` | Empty for Rookery; authoritative repo/session/worker id otherwise |
| `audience_json` | TEXT | NOT NULL | Agent (`master|worker|side`) and origin (`ui|slack|automation|external`) filters |
| `enabled` | INTEGER | NOT NULL | `0` tombstone or `1` enabled |
| `created_at` | TEXT | NOT NULL | ISO timestamp |
| `updated_at` | TEXT | NOT NULL | ISO timestamp |

Index: `idx_capability_bindings_scope (pack_instance_id, scope_kind, scope_ref)`.

### `capability_trust`

Trust is exact-digest approval. Editing any included file changes the current digest and
therefore makes the pack untrusted until that new digest is reviewed.

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `pack_instance_id` | TEXT | PK part, FK → `capability_packs(instance_id)` | Pack instance |
| `digest` | TEXT | PK part | Reviewed whole-pack digest |
| `trusted_at` | TEXT | NOT NULL | ISO timestamp |

### `capability_secrets`

Local write-only values for declared `rookery-secret` references. Only key, configured
state, and monotonically increasing version leave the repository facade; `secret_value`
is read only by the internal resolver/runtime boundary.

| Column | Type | Null/Default | Meaning |
|---|---|---|---|
| `pack_instance_id` | TEXT | PK part, FK → `capability_packs(instance_id)` | Pack instance |
| `secret_key` | TEXT | PK part | Declared secret key |
| `secret_value` | TEXT | NOT NULL | Local value; never serialized to protocol or events |
| `secret_version` | INTEGER | NOT NULL | Revision input changed on every set |
| `updated_at` | TEXT | NOT NULL | ISO timestamp |

Capability-pack removal explicitly deletes its bindings, trust rows, and secrets before
deleting the pack. Session, worker, and repository deletion likewise removes bindings for
that authoritative scope; repository deletion also removes packs it owns and all of their
dependent state. These cleanup paths do not depend on SQLite cascade behavior.
Repository removal captures every affected binding scope before that transaction and emits
one repository-change notification, allowing capability snapshots to invalidate even when
an owned pack had a Rookery/session/worker binding outside the repo scope itself.

## Access patterns

All DB access goes through **`Repositories`** (`src/persistence/repositories.ts`) — exposing typed row interfaces (`SessionRow`, `MessageRow`, `WorkerRow`, `RepoRow`, `WorkerEventRow`, `MemoryRow`, …) and an injected clock (`now?`) for deterministic timestamps in tests.

**Terminal-state write-once guard:** worker status writes route through the single chokepoint `setWorkerStatus(id, status, force = false)`. The terminal set is `{stopped, done, error, failed, orphaned}` (`TERMINAL_WORKER_STATUSES`, mirroring `FleetOrchestrator.isTerminal`). Once a worker is terminal, a write of a **different** value is dropped unless `force` is passed (force = only user stop/discard and rehydrate). This structurally prevents a race from overturning a terminal value even though two writers (`Worker.transition` and `FleetOrchestrator.setStatus`) exist.
