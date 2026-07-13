# Capability Center and Managed Capabilities — Design

Date: 2026-07-13
Status: accepted; Slice 1 implemented
Branch: `feat/capability-center-spec`

Implementation status (2026-07-13): Slice 1 ships the read-only Effective inventory for
authoritative session and worker targets. Desired state, pack bindings, mutations,
repo/Rookery previews, and slash deep-link actions remain in later slices.

## Goal

Make Rookery the source of truth for agent capabilities across Claude and Codex.
Users can inspect what a master or worker can actually use, install a provider-neutral
capability pack once, and bind it to all Rookery agents, one registered repository,
one master session, or one worker without editing `~/.claude` or `~/.codex`.

The first managed capability types are:

- Agent Skills (`SKILL.md` plus optional scripts/references/assets).
- MCP servers (stdio and streamable HTTP).
- Rookery-injected instruction fragments.

The Center also inventories provider-native commands, skills, MCP servers, hooks,
plugins/apps, instructions, and Rookery actions. Hooks and plugins/apps are read-only
inventory in v1; portable management for them is a later phase because their runtime
semantics are not equivalent across providers.

## Product decisions

1. **Rookery owns desired state; providers remain execution engines.** A user binds a
   canonical capability pack to a Rookery scope. A provider adapter compiles the
   resolved pack set for the target agent.
2. **Rookery-managed capabilities are Rookery-only by default.** We do not mutate the
   user's global Claude or Codex configuration. Standalone CLI sessions remain
   unchanged.
3. **Installed, desired, and effective are different states.** The UI never equates
   "found on disk" with "usable in this runtime."
4. **Native provider capabilities coexist rather than being overwritten.** Generated
   MCP/plugin identifiers are namespaced. Standard skill names are preserved; an
   ambiguous skill-name collision blocks the managed skill instead of guessing. Replacing
   a native capability is not supported in v1.
5. **Repository bindings use Rookery's repo relationship, not path ancestry alone.** A
   worker lives under `~/.rookery/worktrees/<id>` but still belongs to the registered
   repository in `workers.repo_path`.
6. **No busy agent is restarted automatically.** A changed master resolves again on its
   next turn. A live worker becomes `pending-reload` and reloads only when idle and the
   user requests it (or explicitly chooses "reload when idle").
7. **Unattended/external origins are opt-in.** A Rookery-wide binding defaults to UI
   masters and workers. Slack, automation, and External-MCP-origin agents must be
   selected explicitly.
8. **Side remains read-only.** Side inherits safe instruction/skill metadata from its
   source, but v1 suppresses managed MCP servers and hooks. Native nested agents inherit
   the provider runtime of their parent and are not independently bindable.
9. **Shared repository manifests never auto-execute.** A newly discovered pack requires
   trust for its current content digest before it can affect an agent.

## Terminology

### Capability pack

A directory containing one canonical manifest and its local assets. A pack may contain
multiple skills, MCP servers, and instruction fragments. A pack is the unit installed in
the Library, trusted, versioned, and bound to scopes.

### Binding

A declaration that enables or disables a pack for a scope and audience. Bindings carry
no provider-specific configuration.

### Desired manifest

The deterministic result of resolving all applicable Rookery bindings for a target.
It contains canonical capability definitions and a revision hash but no secret values.

### Effective manifest

The user-visible merge of:

- Rookery-managed desired capabilities and their runtime state.
- Rookery built-ins such as `/btw`, `/side`, memory/repos/fleet tools, and External MCP.
- Provider-native inventory discovered from Claude or Codex.

### Runtime revision

A SHA-256 hash of the resolved, secret-free runtime configuration. It lets Rookery say
whether a live worker is running the latest desired configuration without serializing
credentials or full skill bodies to the UI.

## Scope and precedence

Managed bindings resolve in this order, from most specific to least specific:

1. `worker`
2. `session`
3. `repo-local`
4. `repo-shared`
5. `rookery`

For a given pack and target audience, the first matching binding wins. A disabled
higher-precedence binding is a tombstone: it suppresses the same pack inherited from a
broader scope.

Provider-native configuration is not another mutable layer in this order. It is merged
into the effective inventory under a separate origin and cannot be shadowed implicitly
by a managed pack. Generated MCP/plugin names use:

```text
rookery__<pack-id>__<capability-id>
```

Skills keep the `name` declared in `SKILL.md` because that name is part of the portable
Agent Skills contract. If two effective skills have the same name, Rookery reports
`blocked/name-collision` for the managed entry; it does not depend on provider-specific
selector ambiguity.

### Binding audience

Every binding declares both agent kinds and origins:

```ts
type CapabilityAgentKind = "master" | "worker" | "side";
type CapabilityOrigin = "ui" | "slack" | "automation" | "external";

interface CapabilityAudience {
  agents: CapabilityAgentKind[];
  origins: CapabilityOrigin[];
}

type CapabilityScopeKind = "rookery" | "repo-local" | "repo-shared" | "session" | "worker";

interface CapabilityBindingInput {
  id?: string;                    // absent on create; required to update an existing row
  packInstanceId: string;
  scopeKind: CapabilityScopeKind;
  scopeRef: string;               // empty for rookery; otherwise authoritative repo/session/worker id
  audience: CapabilityAudience;
  enabled: boolean;
}

interface CapabilityScopeRef {
  scopeKind: CapabilityScopeKind;
  scopeRef: string;
}
```

Both arrays are non-empty, sorted, and deduplicated on write. More than one binding for
the same pack/scope/ref is allowed only when their audience cross-products do not overlap.
This permits, for example, an enabled UI binding and a disabled Slack tombstone at the
same repository scope while guaranteeing that one target never has two equal-precedence
answers.

Defaults in the desktop UI are:

```json
{
  "agents": ["master", "worker"],
  "origins": ["ui"]
}
```

The scope determines *where* a binding applies. The audience determines *which agents*
inside that scope receive it.

### Target-to-repository resolution

- Master: find the registered repo whose canonical real path is the longest ancestor of
  the session cwd. If none matches, no repository binding applies.
- Worker: use `workers.repo_path`, canonicalized through the registered repo catalog;
  never infer ownership from `worktree_path`.
- Side: inherit the source master/worker's resolved repository.
- Native nested agent: inherit the parent worker runtime; it has no Rookery binding target.

Symlink resolution and platform path normalization reuse `src/core/repo-path.ts` rather
than creating a second path policy.

## Pack format

The canonical filename is `capability.json`. JSON is used because the daemon and desktop
already share Zod/TypeScript contracts and no YAML parser is currently shipped.

```json
{
  "schemaVersion": 1,
  "id": "team-engineering",
  "displayName": "Team Engineering",
  "version": "1.2.0",
  "description": "Shared review workflows and engineering tools",
  "instructions": [
    {
      "id": "engineering-guidance",
      "path": "./instructions/engineering.md"
    }
  ],
  "skills": [
    {
      "id": "review-pr",
      "path": "./skills/review-pr"
    }
  ],
  "mcpServers": [
    {
      "id": "sentry",
      "transport": "streamable-http",
      "url": "https://mcp.example.com/sentry",
      "auth": {
        "bearerToken": {
          "source": "rookery-secret",
          "key": "sentry-token"
        }
      },
      "enabledTools": ["search_issues", "read_issue"],
      "required": false
    }
  ]
}
```

### Schema

```ts
export interface CapabilityPackManifest {
  schemaVersion: 1;
  id: string;                    // /^[a-z0-9][a-z0-9._-]{0,63}$/
  displayName: string;           // 1..80 chars
  version: string;               // display/version identity; no semver dependency in v1
  description: string;           // 0..500 chars
  instructions?: InstructionSpec[];
  skills?: SkillSpec[];
  mcpServers?: McpServerSpec[];
}

export interface InstructionSpec {
  id: string;
  path: string;                  // relative, inside the pack root, UTF-8 Markdown
}

export interface SkillSpec {
  id: string;
  path: string;                  // directory containing SKILL.md, inside pack root
}

export type SecretRef =
  | { source: "rookery-secret"; key: string }
  | { source: "environment"; name: string };

export type McpServerSpec = StdioMcpServerSpec | HttpMcpServerSpec;

export interface McpCommon {
  id: string;
  enabledTools?: string[];
  disabledTools?: string[];
  required?: boolean;            // false by default; true makes the target runtime fail closed
  startupTimeoutSec?: number;    // 1..120
  toolTimeoutSec?: number;       // 1..600
}

export interface StdioMcpServerSpec extends McpCommon {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;                  // relative to the pack root
  env?: Record<string, string>;  // non-secret literals only
  secretEnv?: Record<string, SecretRef>;
}

export interface HttpMcpServerSpec extends McpCommon {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;          // non-secret literals only
  secretHeaders?: Record<string, SecretRef>;
  auth?: { bearerToken: SecretRef };
}
```

### Pack validation and digest

- `capability.json`, instruction paths, skill roots, `SKILL.md`, scripts,
  references, and assets must resolve inside the pack root.
- Symlinks are followed only when their real path remains inside the root. Escapes and
  cycles are rejected.
- Duplicate capability ids inside one kind are rejected. Provider-safe generated names
  must remain unique after normalization.
- A skill must have valid `name` and `description` frontmatter, and `SkillSpec.id` must
  equal the skill's declared `name`.
- Literal `env`/`headers` values are treated as public configuration and displayed during
  trust review. Credential-bearing keys such as authorization, token, key, secret,
  password, and cookie must use `secretEnv`, `secretHeaders`, or `auth`.
- A pack traversal is bounded to 2,000 files and 64 MiB. Exceeding either limit is a
  validation error, not partial loading.
- The trust digest hashes normalized relative paths, file modes, and file bytes for every
  included file. Changing instructions or executable content changes the digest.
- Secret values are external to the pack and never participate in the digest.
- A validation failure yields an inventory entry with `status: "error"`; it never causes
  the entire Capability Center request to fail.

## Storage and discovery

### Rookery Library

The desktop can register an existing local directory or create a simple MCP-only pack.
MCP-only packs created in the UI are written beneath:

```text
~/.rookery/capability-packs/<pack-id>/
```

An existing local directory remains in place and is referenced by canonical real path.
Deleting or moving it produces a visible `source-missing` error.

### Repository-local binding

Stored only in Rookery's SQLite database. It causes no git diff and is the default when a
user chooses "this repository."

### Repository-shared pack

Opt-in shared configuration lives at:

```text
<repo>/.rookery/capabilities.json
<repo>/.rookery/capabilities/<pack-id>/capability.json
```

The index contains pack-relative paths and optional disabled tombstones. Rookery scans it
when a registered repo is opened or refreshed. Discovery creates no binding until the user
trusts the current digest. A checked-in secret value is never required: shared manifests
reference local `rookery-secret` keys or environment variable names.

### Database additions

Add one migration with four tables:

```sql
CREATE TABLE capability_packs (
  instance_id    TEXT PRIMARY KEY,
  logical_id     TEXT NOT NULL,
  source_kind    TEXT NOT NULL, -- rookery-generated | local-directory | repo-shared
  owner_repo_id  TEXT,          -- set only for repo-shared discovery
  source_path    TEXT NOT NULL,
  manifest_json  TEXT NOT NULL, -- validated, secret-free snapshot for diagnostics
  digest         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(source_kind, source_path)
) STRICT;

CREATE TABLE capability_bindings (
  id             TEXT PRIMARY KEY,
  pack_instance_id TEXT NOT NULL REFERENCES capability_packs(instance_id),
  scope_kind     TEXT NOT NULL, -- rookery | repo-local | repo-shared | session | worker
  scope_ref      TEXT NOT NULL DEFAULT '', -- empty | repo id | session id | worker id
  audience_json  TEXT NOT NULL,
  enabled        INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;
CREATE INDEX idx_capability_bindings_scope
  ON capability_bindings(pack_instance_id, scope_kind, scope_ref);

CREATE TABLE capability_trust (
  pack_instance_id TEXT NOT NULL REFERENCES capability_packs(instance_id),
  digest           TEXT NOT NULL,
  trusted_at       TEXT NOT NULL,
  PRIMARY KEY(pack_instance_id, digest)
) STRICT;

CREATE TABLE capability_secrets (
  pack_instance_id TEXT NOT NULL REFERENCES capability_packs(instance_id),
  secret_key       TEXT NOT NULL,
  secret_value     TEXT NOT NULL,
  secret_version   INTEGER NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY(pack_instance_id, secret_key)
) STRICT;
```

Repository methods enforce the non-overlapping-audience invariant and delete child
binding/trust/secret rows before a pack. Session/worker deletion removes bindings scoped
exactly to that target. Repo removal deletes repo-local bindings plus repo-shared
pack/binding rows owned by that repo; an independently registered Library pack is not
deleted merely because it was also used by the repo.

Secrets have the same local-at-rest boundary as existing write-only Slack/API-key
settings: the Rookery home and database are mode-hardened. Secret values are never echoed
over WebSocket, logged, included in manifests, or written into provider config files.
OS-keychain-backed storage is a follow-up, not a v1 claim.

`secret_version` starts at 1 and increments on every value change. The runtime revision
includes the secret key and opaque version, never the value. Rotating a secret therefore
marks a live worker pending reload even when the pack manifest itself did not change.

## Architecture

```text
Library directories + repo shared packs + provider-native inventory
                              │
                              ▼
                    CapabilityRegistry
                    validate · digest · trust
                              │
            target ───────────┤
                              ▼
                    CapabilityResolver
               scope precedence · audience · secrets
                              │
                  DesiredCapabilityManifest
                 revision (secret-free SHA-256)
                     │                   │
          ClaudeCapabilityCompiler   CodexCapabilityCompiler
                     │                   │
       SDK options + generated        per-agent CODEX_HOME
       local plugin + process env     config.toml + process env
                     │                   │
                     └─────────┬─────────┘
                               ▼
                      Agent runtime state
                  active · pending · blocked · error
                               │
                               ▼
                       Capability Center
```

### Core components

Create focused modules under `src/core/capabilities/`:

- `types.ts`: canonical manifests, targets, bindings, inventory, statuses.
- `manifest.ts`: Zod schema, path validation, normalization, digest.
- `registry.ts`: persistence-facing Library and trust operations.
- `resolver.ts`: target resolution, precedence, audience filtering, secret-presence
  checks, revision generation.
- `runtime-state.ts`: in-memory desired/applied revision tracking and reload state.
- `service.ts`: application facade used by Connection and agent factories.
- `commands.ts`: provider-neutral command/action projection for slash autocomplete
  (phase 3; no UI imports).

Provider lowering stays beside the provider adapters:

- `src/core/claude-capabilities.ts`
- `src/core/codex/codex-capabilities.ts`
- `src/daemon/capability-runtime.ts` for generated runtime directories, permissions,
  cleanup, and environment materialization.

`startDaemon()` remains the single composition root. Core capability modules do not
import WebSocket, Electron, Slack, or renderer code.

### Canonical target

```ts
export interface CapabilityTarget {
  kind: "master" | "worker" | "side";
  id: string;
  provider: "claude" | "codex";
  origin: "ui" | "slack" | "automation" | "external";
  cwd: string;
  repoId: string | null;
  homeSessionId: string;
}
```

The daemon builds targets from authoritative repository rows. Clients never supply
provider, origin, cwd, repoId, or homeSessionId for an existing session/worker lookup.

### Desired runtime shape

```ts
export interface CapabilitySource {
  packInstanceId?: string;
  packId?: string;
  binding?: CapabilityScopeRef;
  label: string;
  path?: string;
}

export interface CapabilityDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  capabilityId?: string;
  source?: CapabilitySource;
}

export interface ResolvedMcpServer {
  generatedName: string;
  packInstanceId: string;
  spec: McpServerSpec;
  secretVersions: Record<string, number>;
  source: CapabilitySource;
}

export interface ResolvedAgentCapabilities {
  revision: string;
  instructions: Array<{ id: string; content: string; source: CapabilitySource }>;
  skills: Array<{ id: string; root: string; source: CapabilitySource }>;
  mcpServers: Array<ResolvedMcpServer>; // secret refs, never secret values
  diagnostics: CapabilityDiagnostic[];
}
```

`AgentSessionOptions` gains:

```ts
runtimeKey: string; // master id, worker id, or Side id
capabilities?: ResolvedAgentCapabilities;
```

The backend resolves secret values through an injected daemon-only callback immediately
before spawn and returns only generated environment variable names to provider config.
No secret-bearing object is stored on events or protocol types.

## Resolver algorithm

For every target lookup:

1. Build the authoritative target and repository relationship.
2. Load valid, trusted candidate packs. Keep invalid/untrusted packs as diagnostics.
3. Filter bindings by audience agent kind and origin.
4. Group bindings by pack instance.
5. Sort each group by `worker > session > repo-local > repo-shared > rookery`.
6. Select the first binding. Drop the pack when that binding is disabled.
7. Validate required secret presence without reading secret values into the manifest.
8. Suppress MCP/hooks for Side and record `suppressed-by-read-only-policy`.
9. Sort resolved packs and entries by stable id, serialize the secret-free runtime shape,
   and compute the runtime revision.
10. Return partial success plus diagnostics. A required MCP with a missing secret marks the
    runtime `blocked`; an optional MCP is omitted and marks the entry `unavailable`.

Resolver output is cached by target identity plus a monotonic registry generation. Any
pack/binding/trust/secret change increments the generation and invalidates affected
targets. It does not poll the filesystem on every chat turn; watched pack paths and manual
Refresh invalidate their pack digest.

## Provider compilation

### Claude

Claude Agent SDK already accepts `plugins`, `mcpServers`, `settingSources`, and an
appended system prompt.

For each runtime revision, Rookery materializes a generated local Claude plugin beneath:

```text
~/.rookery/capability-runtime/<revision>/claude/rookery-<pack-id>-<instance-hash>/
```

It contains a minimal `.claude-plugin/plugin.json`, links/copies the pack's `skills/`
entries, and writes a generated `.mcp.json` containing environment-variable references.
For stdio entries with a pack-relative `cwd`, it also writes a tiny Node launcher and public
launch descriptor under the immutable plugin. This compensates for Claude's plugin loader
discovering but not applying that field, without a shell and without putting secret values in
files or argv.
The plugin path is passed through the SDK's `plugins` option. The SDK's direct
`mcpServers` option remains reserved for Rookery's existing in-process master tools, so
managed credentials never become inline `--mcp-config` argv JSON. Instruction contents
join `systemPromptAppend` after the existing worker/master fence text.

Generated configuration contains environment-variable references only. Secret values are
added to the Claude child process environment under deterministic names derived from pack
instance and secret key. The names are safe to expose; the values are not.

- Master: re-resolve before every `startTurn`; a change applies on the next turn.
- Worker: resolve before `openSession`; a later change requires a controlled runtime reload.
- Side: load instruction/skill metadata only and keep the current strict read-only tool
  boundary; no managed MCP.

Managed capabilities are additive to native filesystem settings. Rookery does not set
`settingSources: []`, because that would unexpectedly disable the user's native project
instructions and skills.

### Codex master

Extend the existing per-session `CODEX_HOME` materialization. Start from the user's real
base `config.toml`, strip only Rookery-generated blocks, then append deterministic blocks:

```toml
[[skills.config]]
path = "/absolute/pack/skills/review-pr/SKILL.md"
enabled = true

[mcp_servers.rookery__team-engineering__sentry]
url = "https://mcp.example.com/sentry"
bearer_token_env_var = "ROOKERY_CAP_SECRET_..."
enabled_tools = ["search_issues", "read_issue"]
```

The existing `[mcp_servers.rookery]` daemon bridge remains reserved and cannot be used by
a pack id. User base config is preserved. Generated names prevent table collisions.

The home is re-materialized before every master turn, so capability changes apply on the
next turn. `skills/list`, `mcpServerStatus/list`, `hooks/list`, `plugin/list`, and
`config/read` are used for effective inventory and diagnostics; failure of one call yields
partial inventory.

### Codex worker

Codex workers currently share the process/default Codex home. That cannot safely express
two workers with different Rookery-wide/repo/session bindings. Managed capabilities
therefore require a per-worker Codex home:

```text
~/.rookery/codex-homes/worker-<worker-id>/
```

It uses the same base-config preservation and auth symlink/provisioning rules as master
homes, but contains the worker's compiled capability blocks and rollout state. Creating a
per-worker home does **not** create another git worktree and does not change worktree
isolation.

Worker fork copies the source rollout tree only for a same-provider fork, then resolves
the target worker's bindings and recompiles config. Cross-provider handoff starts from a
fresh provider home and uses the existing transcript seed behavior.

### Unsupported or lossy fields

Compilation never silently drops a requested capability. Every entry reports one of:

- `applied`
- `pending-next-turn`
- `pending-reload`
- `unavailable`
- `blocked`
- `suppressed`
- `error`

Provider-specific metadata in a `SKILL.md` may be ignored by the other provider, but the
common skill remains available. The detail panel identifies ignored metadata as a
diagnostic rather than claiming exact parity.

## Runtime lifecycle

### Master

There is no long-lived provider process between turns. The effective view for an idle
master means "will be used on the next turn." During a turn, runtime state records the
revision passed to `startTurn`; a later binding change shows desired/applied drift until
the turn ends.

### Worker reload

Add a non-terminal worker runtime reload, distinct from `stop_worker`:

1. Reject immediate reload while the worker is `running` or `background` unless
   `whenIdle: true` is requested.
2. Mark the worker runtime `pending-reload`; do not change the fleet lifecycle status.
3. At a truthful idle boundary, close only the provider stream/process and preserve:
   worker row, worktree, transcript, model, effort, permission mode, budget, and
   `sdk_session_id`. Replace the old internal `MessageQueue` and `AbortController`; do not
   reuse the terminal `stop()` path.
4. Hold a Fleet reload gate while replacing the runtime. A concurrent `worker.send` is
   rejected with a correlated retryable error rather than entering the closing queue.
5. Resolve the latest capabilities and reopen the backend with `resume`.
6. Mark the new revision applied after provider initialization. If a resumed provider is
   lazy and emits no init until input, retain `pending-start` and confirm on its next turn.
7. On failure, leave the worker idle and resumable, record a visible capability error,
   and allow retry. Never convert a reload failure to terminal `stopped`.

This requires a new Worker/Fleet operation; it must not reuse `Worker.stop()`, which closes
the queue and is intentionally terminal.

### Restart and crash behavior

- Runtime revision state is in memory because a provider process does not survive daemon
  restart.
- After restart, a detached resumable worker appears `pending-reload`; the latest desired
  capabilities compile when the worker is lazily materialized and its first provider
  frame confirms application.
- Per-worker Codex-home cleanup and generated runtime revision garbage collection belong
  to later slices. Slice 3 revision directories are immutable and may accumulate.

### Fork, Side, Slack, automation, and External MCP

- Same-provider master fork copies session-scoped bindings to the new session, then
  recompiles against the new id. Repo/global bindings resolve normally.
- Cross-provider handoff copies bindings but compiles for the target provider; unsupported
  entries are visible before the first turn.
- Worker fork copies worker-scoped bindings to the new worker. Session/repo/global bindings
  resolve through the target's new relationships.
- Side inherits only safe instruction/skill entries from the source revision and suppresses
  managed MCP/hooks.
- Slack/automation/external origins receive a pack only when the winning binding audience
  explicitly includes that origin.
- Native nested agents inherit the parent provider runtime; the Center labels them
  "inherited from worker" and offers no binding controls.

## Effective inventory model

### Slice 1 contract and Slice 2/3 additions

Slice 1 deliberately used the smallest contract needed for trustworthy read-only
inventory:

```ts
export type CapabilityTarget =
  | { kind: "session"; id: string }
  | { kind: "worker"; id: string };

export interface CapabilityEntry {
  id: string;
  kind: CapabilityKind;
  name: string;
  description?: string;
  detail?: string;
  provider: "rookery" | "claude" | "codex";
  source: string;
  scope: "builtin" | "session" | "worker" | "repo" | "user" | "system" | "admin" | "plugin";
  state: "applied" | "unavailable" | "blocked" | "error";
  evidence: "runtime" | "declared" | "inferred";
}

export interface CapabilitySnapshot {
  target: CapabilityTarget & {
    label: string;
    provider: "claude" | "codex";
    cwd: string;
  };
  generatedAt: string;
  entries: CapabilityEntry[];
  diagnostics: CapabilityDiagnostic[];
}
```

Slice 2 preserves that shape and adds `state: "desired"|"suppressed"`, optional managed
binding provenance, and optional `desiredRevision`/`desiredBlocked` snapshot fields.
Slice 3 adds `pending-next-turn`, `pending-reload`, and optional `appliedRevision` for
Claude targets. Codex targets remain desired-only. Later slices add Codex application,
worker hot reload, invocation, and structured source metadata without changing Slice 1's
rule that unknown is never encoded as empty success.

```ts
export type CapabilityKind =
  | "instruction"
  | "skill"
  | "command"
  | "tool"
  | "mcp"
  | "hook"
  | "plugin"
  | "app";

export interface CapabilityEntry {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  provider: "rookery" | "claude" | "codex";
  origin: "managed" | "native" | "builtin";
  scope: "rookery" | "repo-local" | "repo-shared" | "session" | "worker" | "user" | "plugin" | "builtin";
  state: "applied" | "pending-next-turn" | "pending-reload" | "unavailable" | "blocked" | "suppressed" | "error";
  evidence: "runtime" | "declared" | "inferred";
  source: { label: string; path?: string; packId?: string };
  invocation?: {
    type: "prompt" | "client-action" | "daemon-action" | "provider-action" | "tool";
    name?: string;
  };
  diagnostic?: { code: string; message: string };
}

export interface CapabilitySnapshot {
  schemaVersion: 1;
  target: CapabilityTargetSummary;
  desiredRevision: string;
  appliedRevision: string | null;
  generatedAt: string;
  entries: CapabilityEntry[];
  diagnostics: CapabilityDiagnostic[];
}

export type CapabilityTargetSummary = Pick<
  CapabilityTarget,
  "kind" | "id" | "provider" | "origin" | "cwd" | "repoId"
>;
```

Unknown is never encoded as an empty success. A failed Codex `hooks/list`, for example,
produces a hooks diagnostic while skills/MCP inventory still renders.

### Inventory sources

- Rookery: local command action registry, base master tools, source-specific tools,
  External MCP direction/status, resolved managed packs.
- Claude: live `supportedCommands()` when available; cwd probe when cold; plugin JSON
  inventory; native config discovery for instructions/hooks/MCP with evidence marked
  `declared` unless observed by a live runtime.
- Codex: app-server structured list/read methods from the same effective `CODEX_HOME` and
  cwd as the target.

The Center distinguishes:

- **Agent-consumed MCP**: tools available to the selected agent.
- **Rookery External MCP**: Rookery's fleet API exposed to other clients.

They are opposite directions and never share one status label.

## Protocol and events

### Read

```ts
{ type: "capabilities.snapshot", reqId, target:
    | { kind: "rookery" }
    | { kind: "repo"; repo: string; provider?: "claude" | "codex"; agent?: "master" | "worker" }
    | { kind: "session"; id: string }
    | { kind: "worker"; id: string }
}

{ type: "capabilities.snapshot.result", reqId, snapshot: CapabilitySnapshot }
```

For session/worker targets the daemon ignores any client-supplied provider/cwd and reads
authoritative rows. Repo/global targets are previews and may take provider/agent hints.

### Library and bindings

```ts
{ type: "capabilities.library", reqId }
{ type: "capabilities.pack.add", reqId, path: string }
{ type: "capabilities.pack.remove", reqId, instanceId: string }
{ type: "capabilities.binding.set", reqId, id: string, binding: CapabilityBindingInput }
{ type: "capabilities.binding.delete", reqId, id: string }
{ type: "capabilities.trust.set", reqId, instanceId: string, digest: string, trusted: boolean }
{ type: "capabilities.secret.set", reqId, instanceId: string, key: string, value: string }
{ type: "capabilities.secret.delete", reqId, instanceId: string, key: string }
{ type: "capabilities.refresh", reqId, instanceId?: string }
{ type: "capabilities.worker.reload", reqId, workerId: string, whenIdle?: boolean }
```

Through Slice 3, every request above is shipped except `capabilities.worker.reload`, which
belongs to Slice 5. Library projections include file paths, modes,
hashes, public MCP configuration, validation/change metadata, and secret configured
booleans; they never include instruction bodies, skill bodies, or secret values.

Secret responses contain only `{ key, configured: boolean }`. The value is write-only.
Mutation replies return the affected sanitized Library entry or binding so the desktop can
update without a full reload.

### Events

```ts
{ type: "capabilities.changed", generation: number, affected: CapabilityScopeRef[] }
{ type: "capabilities.runtime", sessionId: string, targetKind: "master" | "worker", targetId: string,
  desiredRevision: string, appliedRevision: string | null,
  state: "current" | "pending-next-turn" | "pending-reload" | "blocked" | "error" }
```

`capabilities.changed` is an `@all` invalidation event. Slice 3 ships
`capabilities.runtime` for Claude master/worker desired, applied, blocked, drift, and
application-error transitions. It contains target identifiers and revisions only.

Events contain no pack bodies, instruction contents, command lines containing expanded
secrets, or secret values.

## Command action registry

The current slash autocomplete stores display strings, but provider CLI commands are not
all executable by sending raw text. Phase 3 replaces that assumption with actions:

```ts
export type CommandAction =
  | { type: "insert-prompt"; text: string }
  | { type: "open-capability-center"; tab?: "effective" | "assignments" | "library"; kind?: CapabilityKind }
  | { type: "open-panel"; panel: "side" | "btw" }
  | { type: "daemon-request"; method: string }
  | { type: "provider-request"; provider: "claude" | "codex"; method: string };
```

`/capabilities`, `/skills`, `/hooks`, and `/mcp` open filtered Center views. `/btw` and
`/side` move into the same registry. Managed skills appear in autocomplete only when the
selected target snapshot says they are invocable. Claude and Codex invocation syntax is
lowered by the command registry; the renderer never guesses by concatenating raw text.

Provider TUI-only commands with no app-server/SDK action are either hidden or shown in the
Center as non-invocable native inventory. They never become dead composer commands.

## Desktop UX

Capability Center is a top-level overlay reachable from the left rail and slash actions.
It is not only a right sidebar because Library and Rookery-wide/repo assignments outlive
one conversation.

### Tabs

1. **Effective** — default; current target's desired/applied state and diagnostics.
2. **Assignments** — pack-to-scope bindings, inheritance, and disabled tombstones.
3. **Library** — installed/discovered packs, validation, trust, secrets, and source paths.

### Effective layout

```text
Capabilities   [Current worker: api-review · Codex] [Refresh]
12 applied · 2 unavailable · 1 pending reload

Overview  Instructions  Skills & Commands  Tools & MCP  Hooks  Plugins & Apps

┌ capability list ──────────────┬ detail ──────────────────────────┐
│ ✓ review-pr     Repo · Managed│ Source: team-engineering        │
│ ✓ /btw          Rookery       │ Applied by: repo-local          │
│ ! sentry        MCP           │ Missing secret: sentry-token    │
│ ○ /review       Codex native  │ Inventory only: TUI action      │
└───────────────────────────────┴──────────────────────────────────┘
```

The target selector supports Rookery preview, repo preview, master session, and worker.
Opening from a conversation selects that context automatically.

### Add flow

```text
Add capability
→ Existing pack directory / New MCP server / Repository shared pack
→ Validate and show contents
→ Review commands, URLs, scripts, requested secrets, and compatibility
→ Choose scope: Rookery / Repository / Session / Worker
→ Choose audience: master / worker and UI / Slack / automation / external
→ Trust current digest
→ Save binding
```

Provider compatibility is shown before saving. A change that affects a live worker ends on
a confirmation screen offering `Reload now` (idle only), `Reload when idle`, or `Later`.

### i18n and navigation

- Add `"capabilities"` to the single `Overlay` location model so Back/Forward works.
- All new user-facing strings live in matching Korean/English namespace catalogs.
- Capability diagnostics use stable code+params so provider errors do not leak raw English
  into Korean UI; raw detail remains available in an expandable technical section.
- The Library never renders secret values after submit.

## Security model

Capability packs are executable configuration. Skills can instruct tool use and ship
scripts; MCP can start a process or reach a remote service. The Center must treat adding a
pack like installing code, not like bookmarking documentation.

### Trust review

- Show pack source, digest, changed files, executable files, stdio commands, remote URLs,
  requested environment variables/secrets, MCP tool filters, and target audience.
- Repo-shared packs require digest trust. A content change returns them to `untrusted` and
  preserves the last trusted binding as inactive; no automatic execution occurs.
- Local pack registration also requires initial trust. Subsequent content changes require
  re-trust in v1; a "trust this mutable path" mode is deliberately omitted.
- Trusting a pack does not grant a permission/sandbox profile. Provider permission policy
  still applies independently.

### Secrets

- Shared files contain only public configuration and `SecretRef` identifiers; credentials
  must not be stored as literal header/environment values.
- Secret values are write-only over the authenticated local WebSocket.
- Provider config files contain environment variable names, never values.
- Child process environment receives only secrets required by its resolved capabilities.
- Secret values are redacted from errors and never included in command-line arguments.
- Removing a binding drops the secret from future child environments; removing a pack
  deletes its stored secrets.

### Paths and commands

- Pack paths are canonicalized and containment-checked.
- Generated runtime directories are `0700`; config/manifest artifacts are `0600` where
  they may reveal local paths or server metadata.
- MCP stdio commands are displayed verbatim before trust. Rookery does not invoke a shell
  to launch them; provider-native argv semantics are used.
- Required MCP failure blocks runtime creation with a clear diagnostic. Optional MCP
  failure degrades that server only.

## Portability matrix

| Capability | Claude | Codex | v1 management |
|---|---|---|---|
| `SKILL.md` instructions/resources/scripts | Native skill via generated local plugin | Native skill via `skills.config` | Read/write |
| stdio MCP | Generated local-plugin `.mcp.json` | `mcp_servers` config | Read/write |
| streamable HTTP MCP | Generated local-plugin `.mcp.json` | `mcp_servers` config | Read/write |
| instruction fragment | `systemPromptAppend` | developer instructions | Read/write |
| Rookery UI command | Client action registry | Client action registry | Read/write |
| hook | Native inventory | Native inventory | Read-only |
| provider plugin/app | Native inventory | Native inventory | Read-only |
| provider TUI action | Inventory; action only when SDK supports it | Inventory; action only when app-server supports it | Read-only/action-gated |

## Failure semantics

- Snapshot/list calls return partial results with diagnostics. One broken provider probe or
  pack never blanks the whole Center.
- Mutation calls are atomic at the database boundary. Pack validation/digest and any
  UI-created pack write complete before committing its pack/binding rows. Provider runtime
  artifacts are generated lazily with temp-directory + atomic-rename semantics.
- A required missing secret or untrusted pack marks the target blocked before a provider
  process starts.
- An optional broken capability is omitted and visible as unavailable.
- A worker reload failure preserves the resumable worker and worktree and records a
  non-terminal notice.
- If the daemon lacks a provider binary, managed definitions remain visible as desired but
  provider inventory is unavailable.
- Unknown manifest schema versions are inventory errors and never interpreted as v1.

## Non-goals for v1

- Public/remote capability marketplace, Git URL installation, update feeds, or dependency
  resolution.
- Mutating `~/.claude`, `~/.codex`, provider marketplaces, or standalone CLI behavior.
- A universal provider-neutral hook language.
- Installing/enabling/disabling provider-native plugins or apps.
- Automatically deciding that an MCP tool is read-only enough for Side.
- OS-keychain storage or team secret synchronization.
- Managed/admin policy enforcement. Capability trust and provider sandbox/permission policy
  remain separate controls.
- Live mutation of an in-flight provider runtime.

## Delivery slices

This design spans multiple independently reviewable subsystems. Implementation plans must
be split along these slices rather than delivered as one PR.

### Slice 1 — Inventory foundation

- Provider-neutral `CapabilitySnapshot` and diagnostics.
- Rookery built-ins and existing Claude command catalog.
- Codex structured inventory adapter.
- `capabilities.snapshot` protocol and read-only Effective UI.
- No database migration or mutations.

Implemented on 2026-07-13. The rail opens a read-only Effective view for the selected
session or worker. Rookery built-ins merge with Claude command discovery or Codex
structured probes, and each provider probe can fail independently with a visible
diagnostic.

Exit: Selecting a Claude/Codex master or worker shows trustworthy partial inventory, source,
scope, evidence, and explicit probe errors.

Verification evidence:

- Automated service tests cover authoritative target resolution, worker worktree cwd,
  master-only Rookery tools, deterministic merge/deduplication, and provider degradation.
- Codex adapter tests cover all structured probes, pagination bounds, effective app
  filtering, state/evidence mapping, secret-safe config inventory, and partial failures.
- Desktop tests cover loading, refresh, no-target, errors, diagnostics beside successful
  rows, stale-response rejection, all five categories, and absence of mutation controls.
- Isolated live daemon smoke returned 84 Claude and 55 Codex master entries with no
  diagnostics. Taskless Claude/Codex workers preserved worker cwd and received only the
  worker-safe Rookery commands. A delayed Codex worker `app/list` appeared as one explicit
  probe diagnostic while the remaining 48 entries rendered.
- Electron smoke rendered provider, cwd, source, scope, state, and evidence without a
  terminal or renderer runtime error.

### Slice 2 — Registry, trust, and bindings

- Pack schema/validation/digest.
- Capability tables and repository facade.
- Library, Rookery/repo-local/session/worker bindings, audience, tombstones.
- Write-only local secrets and trust UI.
- Desired manifests only; no provider application yet.

Implemented on 2026-07-13. Capability Center now has Effective, Library, and Assignments
tabs. Local directories are strictly validated and whole-pack hashed; trust is bound to
the exact digest; declared Rookery secrets are write-only. Authoritative Rookery,
repository, session, and worker bindings resolve by audience and by precedence
`worker > session > repo-local > repo-shared > rookery`; a disabled winning binding is a
tombstone. Snapshots merge deterministic desired, blocked, unavailable, and suppressed
managed entries with the existing native inventory.

At the Slice 2 delivery point, no `capability-runtime` directory, provider home, plugin,
MCP process, or provider configuration was created. "Desired" meant selected
configuration only; later slices were responsible for application.

The checked-in [`docs/examples/capability-pack`](../../examples/capability-pack/) exercises
the real validator and demonstrates an instruction, a skill, and an optional HTTP MCP
whose bearer token is a write-only Rookery secret.

Exit: A user can add a local pack, bind it, and see the deterministic desired result and
blocked/missing-secret state without changing any agent runtime.

Verification evidence:

- Core tests cover schema/path/frontmatter/digest limits, repository cleanup, exact-digest
  trust, secret-safe projections, binding precedence/audience/tombstones, and stable desired
  revisions.
- Protocol and live-server tests cover all sanitized mutations and `capabilities.changed`
  fan-out.
- Desktop tests cover Library review/trust/secret actions, Assignments CRUD, all three tabs,
  desired states, target changes, and stale-response rejection.

### Slice 3 — Claude application

- Generated local plugin runtime, SDK MCP/env/instruction lowering.
- Master next-turn application.
- Worker initial application and applied revision tracking.
- Claude runtime verification and tests.

Implemented on 2026-07-13. Trusted bytes are copied and digest-revalidated into an
immutable `capability-runtime/<revision>` tree, then lowered into collision-safe local
Claude plugins. Instructions append after the existing system fragment; skills retain
their resources/scripts; generated `.mcp.json` files contain environment aliases only.
Pack-relative stdio working directories are enforced by an immutable generated Node launcher
that spawns without a shell; its descriptor contains public command metadata only.
Secret values are resolved at the daemon materializer boundary and passed only in the
Claude child environment. Native Claude filesystem settings and Rookery's direct master
MCP servers remain additive.

Masters re-resolve on every serialized turn and mark the revision applied after provider
stream construction. Workers resolve once on initial or lazy-resumed stream open and mark
applied on the first provider frame; later changes display `pending-reload` without an
automatic restart. Effective snapshots and `capabilities.runtime` expose secret-free
desired/applied drift. Codex application, worker hot reload, repository-shared discovery,
runtime GC, and command actions are explicitly outside this slice.

Exit: The same pack works in Claude masters and newly started/resumed Claude workers.

### Slice 4 — Codex application and worker isolation

- Codex config compiler and extended master home materialization.
- Per-worker Codex homes, auth/state handling, cleanup, fork behavior.
- Codex master/worker application and runtime verification.

Exit: The same pack works in Codex masters and workers without touching the user's real
Codex config or leaking one worker's bindings to another.

### Slice 5 — Worker reload and shared repo packs

- Non-terminal worker runtime reload/pending state.
- `.rookery/capabilities.json` discovery and digest trust.
- Reload UI and file watchers/refresh.

Exit: Existing idle workers can adopt changes safely, and a checked-in pack is discovered
but cannot execute before trust.

### Slice 6 — Command actions

- Command action registry.
- `/capabilities`, `/skills`, `/hooks`, `/mcp` deep links.
- Move `/btw` and `/side` into the registry.
- Managed-skill autocomplete and provider invocation lowering.

Exit: Slash preview contains only actions/skills executable in the selected context; no
provider TUI-only dead commands are sent as prompts.

## Testing strategy

### Pure/core

- Manifest Zod validation, traversal containment, symlink escape/cycle rejection, bounds,
  deterministic digest, provider-safe id normalization.
- Resolver precedence and disabled tombstones across every scope.
- Audience filtering for master/worker/side and UI/Slack/automation/external origins.
- Master cwd longest-repo match and worker `repo_path` ownership.
- Missing required vs optional secret behavior.
- Secret-version changes alter runtime revision without hashing or serializing values.
- Side suppression, fork binding copy, stable revision ordering.
- Runtime desired/applied drift transitions.

### Persistence

- Migration from the previous schema version.
- Pack/binding/trust/secret CRUD and delete cleanup.
- Secret getters are internal only; protocol serializers never contain values.
- Session/worker/repo deletion removes only the appropriate scoped bindings.

### Claude adapter

- Generated plugin structure and namespacing.
- MCP merge preserves Rookery base tools and native settings.
- Secret environment injection without argv/config leakage.
- Master resolves each turn; worker resolves at open/reload.
- Partial command/runtime probe failures.

### Codex adapter

- Base config preservation and stripping only generated Rookery blocks.
- Skill/MCP config lowering, reserved bridge id, deterministic config.
- Per-master and per-worker home separation, auth link/provisioning, cleanup.
- Same-provider fork state copy plus target recompilation.
- app-server list/read partial failure behavior.

### Protocol/daemon

- Authoritative target lookup rejects unknown ids and ignores spoofed provider/cwd.
- All mutation validation and correlated replies.
- `capabilities.changed` affected-scope calculation.
- Write-only secret request/response behavior.
- Busy worker reload rejection and `whenIdle` scheduling.

### Desktop

- Overlay navigation and Back/Forward.
- Effective/Assignments/Library loading, empty, partial-error, and retry states.
- Inheritance and tombstone visualization.
- Trust review and secret fields never repopulate values.
- Provider compatibility and pending reload confirmation.
- Slash deep links and invocable-only filtering.
- Korean/English catalog parity and used-key checks.

### Required gates per slice

```bash
nvm use 22
npm run typecheck
npm test
npm -w apps/desktop run typecheck
npm -w apps/desktop test
```

Slices that materialize provider runtime files also need live smoke tests with one local
Claude session and one local Codex session. Smoke packs use a harmless instruction-only
skill and a local read-only MCP fixture; no third-party credentials are required.

## Acceptance criteria

The managed-capability milestone is complete when all of the following are true:

1. One local pack containing a `SKILL.md`, an instruction, and a harmless MCP server can be
   registered once and bound to Rookery-wide, repo, session, or worker scope.
2. The same pack is usable by Claude and Codex masters and workers through provider-native
   loading, without changing real user provider config.
3. A repo binding reaches workers through `repo_path` even though their worktrees are outside
   the source repo directory.
4. Slack/automation/external origins do not receive a UI-default binding unless explicitly
   included.
5. Side does not receive managed MCP and remains read-only.
6. A changed shared pack becomes untrusted before it can affect a new runtime.
7. Values resolved from `SecretRef` never appear in WebSocket responses, logs, generated
   provider configs, or child argv.
8. A master change applies on its next turn. A live worker clearly shows pending reload and
   can reload without losing worktree, transcript, or provider conversation.
9. Capability Center distinguishes desired, applied, unavailable, blocked, suppressed, and
   error states with source and evidence.
10. Slash preview contains only commands/actions/skills that can execute in the selected
    context.

## Documentation updates during implementation

- `AGENTS.md`: capability architecture, Rookery home layout, per-worker Codex home, secret
  boundary, and worker reload semantics.
- `docs/reference/protocol.md`: capability requests/results/events.
- `docs/reference/data-model.md`: four capability tables and delete behavior.
- `docs/reference/events.md`: capability generation/runtime events.
- `docs/architecture/master-worker-turn.md`: resolution/application points.
- `README.md`: concise Capability Center and repo/Rookery scope usage.
- Example pack under `docs/examples/capability-pack/` after Slice 2, validated by tests.

## Source notes

- Codex supports common Agent Skills and arbitrary configured skill paths; repository
  skill discovery and project config are provider-native inputs, not files Rookery needs to
  mutate: <https://developers.openai.com/codex/skills>
- Codex supports user and trusted-project MCP config in `config.toml`:
  <https://developers.openai.com/codex/mcp>
- Claude skills use the Agent Skills format and project/user scopes:
  <https://code.claude.com/docs/en/slash-commands>
- Claude MCP has local/project/user scopes and project trust:
  <https://code.claude.com/docs/en/mcp>
- Claude Agent SDK supports programmatic local plugins and MCP config; the installed SDK
  types are the implementation source of truth for the pinned Rookery version.
