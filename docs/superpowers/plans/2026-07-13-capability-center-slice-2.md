# Capability Center Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user register and trust a local capability pack, configure write-only secrets, bind the pack to Rookery/repository/session/worker audiences, and inspect a deterministic desired result without changing a Claude or Codex runtime.

**Architecture:** Add a provider-neutral manifest validator, persistence-backed registry, and deterministic resolver under `src/core/capabilities/`. `Repositories` owns atomic storage and cleanup; `CapabilityRegistry` owns filesystem validation/trust/secret-safe projections; `CapabilityResolver` owns authoritative scope/audience precedence and secret-presence decisions. The daemon exposes sanitized CRUD over the existing WebSocket, emits generation changes, and merges resolver entries into Slice 1 snapshots. The desktop extends Capability Center with Effective, Assignments, and Library tabs; provider application remains absent.

**Tech Stack:** Node.js 22, TypeScript NodeNext, Zod 4, `better-sqlite3` STRICT migrations, SHA-256 from `node:crypto`, React 18, Zustand, Tailwind, Vitest/jsdom.

## Global Constraints

- Work on stacked branch `feat/capability-center-slice-2` in `/Users/clover/workspace/clovot-capability-center`; preserve the user's other worktrees and local `main` divergence.
- Activate Node 22 for every build/test/daemon command; `better-sqlite3` requires ABI 127.
- Append exactly one migration; never modify an existing `MIGRATIONS` entry.
- Core capability modules remain transport/UI/provider independent. `startDaemon()` remains the only composition root.
- Slice 2 is desired-state only: do not write provider config, create capability runtime homes, change turn/session options, or expose managed capabilities to a Claude/Codex process.
- Slice 2 registers existing local directories. Repository-shared discovery, provider application, worker reload, and command-action deep links remain later slices.
- Capability manifests, digests, binding metadata, secret keys, and secret versions may cross the WebSocket; secret values may not appear in any response, event, log, diagnostic, manifest snapshot, revision input, or test snapshot.
- Local and changed packs require explicit trust for their exact current digest. A refresh that changes content preserves bindings but makes the current pack untrusted.
- Binding precedence is `worker > session > repo-local > repo-shared > rookery`; the first matching binding per pack wins, and a disabled winner is a tombstone.
- Binding audiences contain non-empty, sorted, deduplicated `agents` and `origins`; equal-scope cross-products for one pack may not overlap.
- Master repository ownership uses the longest canonical registered-repo ancestor of session cwd. Worker ownership comes from `workers.repo_path`, never `worktree_path` ancestry.
- All new desktop strings live in matching Korean/English `capabilities` catalogs. Code comments remain English.
- Use `apply_patch` for source and documentation edits. Follow TDD and commit independently reviewable tasks.

---

## Slice 2 exit criteria

1. A valid local pack containing an instruction, an Agent Skill, and MCP definitions can be registered and listed with a deterministic digest and sanitized manifest.
2. Invalid manifests, traversal/symlink escapes, bad Skill frontmatter, credential-like literal env/header keys, file-count overflow, and byte overflow fail safely with actionable validation errors.
3. Trust applies only to the current digest. A content change followed by refresh makes the pack untrusted without deleting bindings.
4. Rookery secrets are write-only over the protocol. Clients see only key/configured/version-free status; values never serialize or enter the desired revision.
5. Bindings support Rookery, repo-local, session, and worker scopes plus master/worker/side and UI/Slack/automation/external audiences. Invalid scope refs and overlapping audiences are rejected atomically.
6. Resolver precedence, disabled tombstones, audience filtering, master longest-repo matching, worker `repo_path` ownership, required/optional missing secret behavior, and stable revision ordering have direct tests.
7. Effective snapshots retain Slice 1 provider/Rookery inventory and add managed entries in `desired`, `blocked`, `unavailable`, or `suppressed` states plus a secret-free `desiredRevision`.
8. Capability Center exposes functional Effective, Assignments, and Library tabs. Users can add/remove/refresh/trust packs, save/delete secrets, and create/edit/delete bindings. Secret inputs always remount empty.
9. Session, worker, repo, and pack deletion clean only the capability rows owned by that target. A local Library pack survives repo removal.
10. Root and desktop typechecks/tests/builds pass, a live isolated daemon round-trip proves CRUD/resolution/write-only secrets, and Electron renders the three tabs without provider runtime mutation.

---

### Task 1: Define canonical managed-capability contracts and validate pack contents

**Files:**

- Modify: `src/core/capabilities/types.ts`
- Create: `src/core/capabilities/manifest.ts`
- Create: `test/core/capabilities/manifest.test.ts`

**Interfaces:**

- Consumes: Slice 1 `CapabilityEntry`, `CapabilitySnapshot`, and diagnostic sort helpers.
- Produces: `CapabilityPackManifest`, `CapabilityBindingInput`, `CapabilityLibraryEntry`, `ValidatedCapabilityPack`, `validateCapabilityPack(root, limits?)`, and `collectSecretRequirements(manifest)`.

- [ ] **Step 1: Write failing contract and manifest tests**

Cover a temporary pack with `capability.json`, one Markdown instruction, one skill directory with `SKILL.md`, and stdio/HTTP MCP definitions. Assert normalized manifest, canonical root, deterministic digest, requested secret keys, and included-file metadata. Add direct failures for unsupported schema, invalid ids, duplicate/provider-normalized MCP ids, absolute/escaping paths, symlink escape/cycle, missing files, mismatched skill name, malformed frontmatter, public credential-like env/header keys, non-http URL, 2,001 files, and more than 64 MiB.

```ts
const result = validateCapabilityPack(packRoot);
expect(result.manifest.id).toBe("team-engineering");
expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
expect(result.files.map((file) => file.path)).toContain("skills/review-pr/SKILL.md");
expect(collectSecretRequirements(result.manifest)).toEqual([
  { source: "environment", key: "GITHUB_TOKEN" },
  { source: "rookery-secret", key: "sentry-token" },
]);
```

- [ ] **Step 2: Run the focused test and verify missing-module failure**

Run: `npx vitest run test/core/capabilities/manifest.test.ts`

Expected: FAIL because `manifest.ts` and managed types do not exist.

- [ ] **Step 3: Add the canonical types**

Extend `types.ts` with exact unions and sanitized wire shapes:

```ts
export type CapabilityAgentKind = "master" | "worker" | "side";
export type CapabilityOrigin = "ui" | "slack" | "automation" | "external";
export type CapabilityScopeKind = "rookery" | "repo-local" | "repo-shared" | "session" | "worker";

export interface CapabilityAudience {
  agents: CapabilityAgentKind[];
  origins: CapabilityOrigin[];
}

export interface CapabilityBindingInput {
  id?: string;
  packInstanceId: string;
  scopeKind: CapabilityScopeKind;
  scopeRef: string;
  audience: CapabilityAudience;
  enabled: boolean;
}

export interface CapabilityBinding extends Required<CapabilityBindingInput> {
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityPackManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  version: string;
  description: string;
  instructions?: InstructionSpec[];
  skills?: SkillSpec[];
  mcpServers?: McpServerSpec[];
}

export type CapabilityPackStatus = "trusted" | "untrusted" | "invalid" | "source-missing";

export interface CapabilitySecretStatus {
  key: string;
  configured: boolean;
}

export interface CapabilityLibraryEntry {
  instanceId: string;
  sourceKind: "rookery-generated" | "local-directory" | "repo-shared";
  sourcePath: string;
  ownerRepoId: string | null;
  manifest: CapabilityPackManifest;
  digest: string;
  status: CapabilityPackStatus;
  errors: string[];
  files: Array<{ path: string; mode: number; size: number; executable: boolean; sha256: string }>;
  changes: Array<{ path: string; kind: "added" | "modified" | "removed" }>;
  secrets: CapabilitySecretStatus[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityLibrarySnapshot {
  generation: number;
  packs: CapabilityLibraryEntry[];
  bindings: CapabilityBinding[];
}
```

Extend `CapabilityState` with `desired` and `suppressed`. Add optional managed provenance to `CapabilityEntry` and `desiredRevision`/`desiredBlocked` to `CapabilitySnapshot`; keep existing Slice 1 fields backward compatible.

- [ ] **Step 4: Implement bounded validation and digesting**

Create a Zod discriminated schema for MCP transport and exact numeric/path/id bounds. Canonicalize with `fs.realpathSync.native`; use `path.relative` containment checks; recursively walk the pack root without following an escaping symlink; reject repeated directory realpaths as cycles. Count no more than 2,000 files and 64 MiB. Hash sorted tuples of normalized relative path, `stat.mode & 0o777`, file length, and bytes plus the canonical manifest representation using `createHash("sha256")`.

Parse `SKILL.md` frontmatter between opening/closing `---`; accept quoted/plain scalar strings and folded/literal description blocks. Require `name` and `description`; require `SkillSpec.id === name`. Do not execute commands or load remote URLs.

- [ ] **Step 5: Run manifest tests and root typecheck**

Run:

```bash
npx vitest run test/core/capabilities/manifest.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit manifest contracts**

```bash
git add src/core/capabilities/types.ts src/core/capabilities/manifest.ts test/core/capabilities/manifest.test.ts
git commit -m "feat: validate capability packs"
```

---

### Task 2: Persist packs, bindings, trust, and write-only secrets atomically

**Files:**

- Modify: `src/persistence/db.ts`
- Modify: `src/persistence/repositories.ts`
- Modify: `test/persistence/db.test.ts`
- Modify: `test/persistence/repositories.test.ts`

**Interfaces:**

- Consumes: canonical binding/audience/source types from Task 1.
- Produces: `CapabilityPackRow`, `CapabilityBindingRow`, `CapabilitySecretMetadata`, and `Repositories` capability CRUD/cleanup methods.

- [ ] **Step 1: Write failing migration and repository tests**

Assert migration from the preceding schema, STRICT table/index presence, pack CRUD, trust-by-digest, secret version increment, sanitized secret metadata, deterministic list ordering, binding audience normalization, overlap rejection on create/update, unknown foreign keys, pack child cleanup, and target-specific session/worker/repo cleanup. `manifest_json` stores a sanitized registry document (manifest, file hashes/change list, and validation status), never instruction bodies or secrets.

```ts
repos.setCapabilitySecret("pack-1", "sentry-token", "first");
repos.setCapabilitySecret("pack-1", "sentry-token", "second");
expect(repos.listCapabilitySecretMetadata("pack-1")).toEqual([
  { key: "sentry-token", configured: true, version: 2 },
]);
expect(JSON.stringify(repos.listCapabilitySecretMetadata("pack-1"))).not.toContain("second");
```

- [ ] **Step 2: Run persistence tests and confirm schema/API failures**

Run: `npx vitest run test/persistence/db.test.ts test/persistence/repositories.test.ts`

Expected: FAIL on missing migration/tables/methods.

- [ ] **Step 3: Append the four-table migration**

Append one `MIGRATIONS` entry creating `capability_packs`, `capability_bindings`, `capability_trust`, and `capability_secrets` as STRICT tables. Add foreign keys to packs and repos but keep explicit child deletion consistent with current repository conventions. Add the scope index and unique `(source_kind, source_path)` constraint. Do not edit earlier migration entries.

- [ ] **Step 4: Implement repository row mapping and CRUD**

Add methods with stable ordering and synchronous transactions:

```ts
createCapabilityPack(row: CapabilityPackRow): CapabilityPackRow;
updateCapabilityPack(instanceId: string, patch: { logicalId: string; manifestJson: string; digest: string }): CapabilityPackRow;
getCapabilityPack(instanceId: string): CapabilityPackRow | undefined;
listCapabilityPacks(): CapabilityPackRow[];
deleteCapabilityPack(instanceId: string): void;

setCapabilityBinding(id: string, input: CapabilityBindingInput): CapabilityBinding;
getCapabilityBinding(id: string): CapabilityBinding | undefined;
listCapabilityBindings(packInstanceId?: string): CapabilityBinding[];
deleteCapabilityBinding(id: string): void;

setCapabilityTrust(instanceId: string, digest: string, trusted: boolean): void;
isCapabilityDigestTrusted(instanceId: string, digest: string): boolean;
setCapabilitySecret(instanceId: string, key: string, value: string): CapabilitySecretMetadata;
deleteCapabilitySecret(instanceId: string, key: string): void;
listCapabilitySecretMetadata(instanceId: string): CapabilitySecretMetadata[];
```

Normalize/sort/deduplicate audiences before storing JSON. Reject an equal pack/scope/ref row when any `agent × origin` pair overlaps, excluding the updated id. Keep a daemon-internal value getter separate from sanitized metadata and never use it in protocol serializers during Slice 2.

- [ ] **Step 5: Add deletion cleanup at existing ownership boundaries**

Inside current transactions, delete session-scoped bindings before a session, worker-scoped bindings before a worker, and repo-local bindings before a repo. When removing a repo, delete repo-shared packs owned by its repo id with their children; do not delete `local-directory` packs. Pack deletion removes bindings, trust rows, and secrets before the pack row.

- [ ] **Step 6: Run persistence tests and root typecheck**

Run:

```bash
npx vitest run test/persistence/db.test.ts test/persistence/repositories.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit persistence**

```bash
git add src/persistence/db.ts src/persistence/repositories.ts test/persistence/db.test.ts test/persistence/repositories.test.ts
git commit -m "feat: persist capability registry state"
```

---

### Task 3: Build the registry and deterministic desired resolver

**Files:**

- Create: `src/core/capabilities/registry.ts`
- Create: `src/core/capabilities/resolver.ts`
- Modify: `src/core/repo-path.ts`
- Create: `test/core/capabilities/registry.test.ts`
- Create: `test/core/capabilities/resolver.test.ts`
- Modify: `test/core/repo-path.test.ts`

**Interfaces:**

- Consumes: validated manifests, repository CRUD, registered repo/session/worker rows.
- Produces: `CapabilityRegistry`, `CapabilityResolver`, `ResolvedCapabilityTarget`, `DesiredCapabilityManifest`, registry generation notifications, and canonical repo matching helpers.

- [ ] **Step 1: Write failing registry tests**

Test add/list/remove, canonical duplicate path rejection, explicit current-digest trust, changed-file refresh to untrusted with an added/modified/removed review list, missing/invalid source degradation that survives restart through the sanitized registry document, only declared Rookery secret keys accepted, empty secret values rejected, sanitized secret results, scope authority validation, and affected-scope generation notifications.

```ts
const added = registry.add(packRoot);
registry.setTrust(added.instanceId, added.digest, true);
expect(registry.list().packs[0]?.status).toBe("trusted");
fs.appendFileSync(instruction, "\nchanged");
expect(registry.refresh(added.instanceId).packs[0]?.status).toBe("untrusted");
```

- [ ] **Step 2: Write failing resolver tests**

Build multiple packs and bindings to cover all precedence edges, equal-level audience selection, disabled tombstones, UI default exclusion from Slack/automation/external, master longest canonical repo, worker exact `repo_path` ownership, Side audience filtering/MCP suppression, stable pack ordering, invalid/untrusted packs, environment and Rookery secret presence, required missing MCP blocking, optional missing MCP unavailable, and secret-version revision changes without value leakage.

```ts
const desired = resolver.resolve({
  kind: "worker", id: "w1", provider: "codex", origin: "ui",
  cwd: "/tmp/worktrees/w1", repoId: "repo-a", homeSessionId: "s1",
});
expect(desired.entries.find((entry) => entry.name === "sentry")?.state).toBe("blocked");
expect(JSON.stringify(desired)).not.toContain("actual-secret-value");
```

- [ ] **Step 3: Run focused tests and verify missing-module failures**

Run: `npx vitest run test/core/capabilities/registry.test.ts test/core/capabilities/resolver.test.ts test/core/repo-path.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement canonical repository matching**

Add `canonicalPath(value)` and `longestContainingRepo(cwd, repos, realpath?)` to `repo-path.ts`. Compare with `path.relative`; require `relative === ""` or a non-absolute relative path that does not start with `..`. Sort matches by canonical path length then id. Resolver callers inject/fallback realpath so unit tests remain deterministic.

- [ ] **Step 5: Implement `CapabilityRegistry`**

The registry validates before insert, stores a canonical sanitized registry document, and revalidates on explicit refresh. The document includes manifest metadata, per-file hashes/modes, current validation/source status, and a path-only added/modified/removed list so trust review remains useful after restart; it excludes file bodies and secrets. Its public projections contain no secret values. `setTrust` requires `digest === current digest`, clears the reviewed change list for that digest, and `setSecret` requires a declared `rookery-secret` key. Binding setters verify scope refs (`rookery` empty, repo/session/worker exists) before delegating overlap enforcement to `Repositories`.

Every successful mutation increments an in-memory monotonic generation and calls:

```ts
onChanged?: (change: {
  generation: number;
  affected: CapabilityScopeRef[];
}) => void;
```

Pack/trust/secret changes derive affected scopes from that pack's current bindings; an unbound pack uses an empty affected list and still emits so Library clients refresh.

- [ ] **Step 6: Implement `CapabilityResolver`**

Resolve candidate scopes from the authoritative target, filter by audience, group by pack instance, sort by exact precedence, and choose one binding per pack. Emit managed `CapabilityEntry` rows for instruction, skill, and MCP definitions with safe provenance:

```ts
export interface DesiredCapabilityManifest {
  revision: string;
  blocked: boolean;
  entries: CapabilityEntry[];
  diagnostics: CapabilityDiagnostic[];
}
```

Trusted, enabled, satisfiable definitions use `desired`. Disabled winners use `suppressed`. Untrusted/invalid packs use `blocked`. A required MCP with missing refs sets `blocked=true`; an optional MCP uses `unavailable`. A Side target can receive instructions/skills through a `side` audience but always suppresses MCP with a diagnostic. Compute SHA-256 from a canonical JSON projection containing pack instance/digest, selected binding/audience, public specs, secret keys and opaque Rookery secret versions/environment configured booleans. Never load secret values.

- [ ] **Step 7: Run focused tests, placeholder scan, and typecheck**

Run:

```bash
npx vitest run test/core/capabilities/registry.test.ts test/core/capabilities/resolver.test.ts test/core/repo-path.test.ts
rg -n "TODO|TBD|FIXME|placeholder|implement later" src/core/capabilities src/core/repo-path.ts test/core/capabilities
npm run typecheck
```

Expected: tests/typecheck PASS and no implementation placeholders.

- [ ] **Step 8: Commit registry and resolver**

```bash
git add src/core/capabilities/registry.ts src/core/capabilities/resolver.ts src/core/repo-path.ts test/core/capabilities/registry.test.ts test/core/capabilities/resolver.test.ts test/core/repo-path.test.ts
git commit -m "feat: resolve desired capability bindings"
```

---

### Task 4: Expose sanitized registry mutations and merge desired snapshots

**Files:**

- Modify: `src/core/capabilities/service.ts`
- Modify: `src/core/events.ts`
- Modify: `src/protocol/messages.ts`
- Modify: `src/daemon/connection.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/core/capabilities/service.test.ts`
- Modify: `test/core/events.test.ts`
- Modify: `test/protocol/messages.test.ts`
- Modify: `test/daemon/connection.test.ts`
- Modify: `test/daemon/server.test.ts`

**Interfaces:**

- Consumes: registry/resolver and Slice 1 snapshot provider.
- Produces: library/mutation protocol, `capabilities.changed` events, and snapshots carrying desired entries/revision.

- [ ] **Step 1: Write failing service tests for authoritative desired resolution**

Extend fixtures with session origin/external key, worker home session/repo path, and registered repos. Assert session/worker target resolution cannot be spoofed, master longest repo is used, worker worktree is never used for repo ownership, provider entries survive managed diagnostics, and the snapshot exposes `desiredRevision`/`desiredBlocked` without bodies/secrets.

- [ ] **Step 2: Write failing protocol and connection route tests**

Add parser coverage for:

```ts
capabilities.library
capabilities.pack.add/remove
capabilities.binding.set/delete
capabilities.trust.set
capabilities.secret.set/delete
capabilities.refresh
```

Reject empty ids/paths/secret values, bad scope refs, empty audiences, and unknown enum members in Zod. Test correlated replies and errors for every route. Assert serialized secret replies contain `{key, configured}` but never the request value.

- [ ] **Step 3: Add wire result types**

Use dedicated results so each mutation returns its sanitized affected object:

```ts
{ type: "capabilities.library.result"; reqId; library: CapabilityLibrarySnapshot }
{ type: "capabilities.pack.result"; reqId; pack: CapabilityLibraryEntry | null }
{ type: "capabilities.binding.result"; reqId; binding: CapabilityBinding | null }
{ type: "capabilities.secret.result"; reqId; instanceId; secret: CapabilitySecretStatus }
{ type: "capabilities.refresh.result"; reqId; library: CapabilityLibrarySnapshot }
```

Pack/binding deletion returns the same result with `null`; trust returns the refreshed sanitized pack. Update `RequestResultMap` exhaustively.

Extend the additive `repos.list.result` row with its existing persisted `id`; Slice 2 binding forms must send authoritative repo ids instead of names or paths. Update its protocol/Connection tests and desktop store row type without changing existing repo behavior.

- [ ] **Step 4: Extend the service facade**

Inject `CapabilityRegistry` and `CapabilityResolver` into `CapabilityService`. Resolve an internal authoritative target containing agent kind, origin, repo id, cwd, provider, and home session. Call `registry.refresh()` on explicit `capabilities.refresh`; snapshots resolve from the current registry projection and merge desired + built-in + native contributions deterministically.

- [ ] **Step 5: Wire registry events and routes at the daemon boundary**

Add `CoreEvent`:

```ts
| { type: "capabilities.changed"; sessionId: string; generation: number; affected: CapabilityScopeRef[] }
```

Construct registry/resolver/service only in `startDaemon()`. Emit changes on `ALL_CHANNEL`. Extend `CapabilitySnapshotProvider` into a capability facade interface with the mutation methods used by Connection; do not let Connection reach `Repositories` directly for capability behavior.

- [ ] **Step 6: Run focused backend tests and root gates**

Run:

```bash
npx vitest run test/core/capabilities/service.test.ts test/core/events.test.ts test/protocol/messages.test.ts test/daemon/connection.test.ts test/daemon/server.test.ts
npm run typecheck
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit daemon integration**

```bash
git add src/core/capabilities/service.ts src/core/events.ts src/protocol/messages.ts src/daemon/connection.ts src/daemon/server.ts test/core/capabilities/service.test.ts test/core/events.test.ts test/protocol/messages.test.ts test/daemon/connection.test.ts test/daemon/server.test.ts
git commit -m "feat: expose capability registry protocol"
```

---

### Task 5: Add Library and Assignments workflows to Capability Center

**Files:**

- Modify: `apps/desktop/src/renderer/components/CapabilitiesPage.tsx`
- Create: `apps/desktop/src/renderer/components/capabilities/CapabilityLibraryTab.tsx`
- Create: `apps/desktop/src/renderer/components/capabilities/CapabilityAssignmentsTab.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/store/store.ts`
- Modify: `apps/desktop/src/renderer/store/reduce.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/capabilities.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts`
- Modify: `apps/desktop/test/capabilities-page.test.tsx`
- Create: `apps/desktop/test/capability-library-tab.test.tsx`
- Create: `apps/desktop/test/capability-assignments-tab.test.tsx`
- Modify: `apps/desktop/test/store-reduce.test.ts`
- Modify: `apps/desktop/test/i18n/catalog.test.ts`

**Interfaces:**

- Consumes: protocol facade callbacks, App's current repos/sessions/fleet, and `capabilities.changed` generation.
- Produces: three functional Center tabs, trust/secret/pack actions, binding form/edit/delete, and desired-state presentation.

- [ ] **Step 1: Write failing shell/Effective tests**

Assert the three tabs render even with no selected target; Effective remains the default; managed desired/blocked/suppressed rows and desired revision render; a generation change reloads active data; native rows still render. Update state summary expectations for six states.

- [ ] **Step 2: Write failing Library tests**

Test loading/empty/error/retry, Add directory using an injected picker, refresh, expanded trust review, trust/untrust, removal confirmation, source/digest/files/executable/MCP command-or-URL/tool filters, provider compatibility, and per-secret write/delete. Assert the secret input starts empty, the sent value never comes back through props, and rerender after success remains empty.

- [ ] **Step 3: Write failing Assignments tests**

Test default audience (`master`,`worker`,`ui`), scope ref options, save/edit/delete, enabled tombstone, master/worker/side and all four origin toggles, validation of at least one agent/origin, inherited scope display, and server overlap errors. Use only ids/labels from authoritative App state.

- [ ] **Step 4: Split the page and add a typed desktop facade**

Keep `CapabilitiesPage` as the loading/tab shell and Effective renderer. Pass a `CapabilityCenterApi` object whose methods call typed `WsClient.request`. Pass target options:

```ts
interface CapabilityTargetOptions {
  repos: Array<{ id: string; label: string }>;
  sessions: Array<{ id: string; label: string }>;
  workers: Array<{ id: string; label: string }>;
}
```

The repo options use the `id` added to `repos.list.result` in Task 4. Sessions and workers already expose authoritative ids.

Use `window.rookery.pickDirectory()` only through an injected `pickDirectory` callback from App so component tests remain browser-only.

- [ ] **Step 5: Implement Library trust and write-only secret UX**

Cards show status, source path, version, digest, safe manifest metadata, included/executable files, MCP commands/URLs, literal public keys, requested secret identifiers, and Claude/Codex compatibility. Trust requires an explicit review expansion and uses the displayed digest. Password inputs are uncontrolled or key-reset after save and never receive a server value prop.

- [ ] **Step 6: Implement Assignments CRUD and tombstones**

Create/edit uses a single form with canonical audience ordering before send. `rookery` forces empty `scopeRef`; the other scopes require a selected authoritative option. Existing cards show enabled/disabled, scope, audience, and pack name. Disabled bindings use explicit tombstone copy rather than a generic off toggle.

- [ ] **Step 7: Consume generation events and complete i18n**

Update the pure reducer/store with `capabilityGeneration`; `capabilities.changed` assigns the event generation. The open page includes it in reload dependencies. Add all labels, validation, trust warnings, buttons, and status copy to both catalogs; keep provider brand names unchanged.

- [ ] **Step 8: Run desktop tests/typecheck/build**

Run:

```bash
npm --workspace apps/desktop test -- capabilities-page.test.tsx capability-library-tab.test.tsx capability-assignments-tab.test.tsx store-reduce.test.ts
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop test
npm --workspace apps/desktop run build
```

Expected: PASS. Existing jsdom canvas and React `act(...)` warnings may remain, but no new failure/runtime warning is accepted.

- [ ] **Step 9: Commit desktop workflows**

```bash
git add apps/desktop/src/renderer/components/CapabilitiesPage.tsx apps/desktop/src/renderer/components/capabilities apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/store apps/desktop/src/renderer/i18n/locales/en/capabilities.ts apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts apps/desktop/test
git commit -m "feat: manage capability library and assignments"
```

---

### Task 6: Document, live-smoke, and audit Slice 2

**Files:**

- Modify: `docs/superpowers/specs/2026-07-13-capability-center-design.md`
- Modify: `docs/reference/protocol.md`
- Modify: `docs/reference/data-model.md`
- Modify: `docs/reference/events.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Create: `docs/examples/capability-pack/capability.json`
- Create: `docs/examples/capability-pack/instructions/team.md`
- Create: `docs/examples/capability-pack/skills/review-pr/SKILL.md`
- Create: `test/core/capabilities/example-pack.test.ts`

**Interfaces:**

- Consumes: the shipped contracts and Slice 2 exit criteria.
- Produces: evergreen references, a validated harmless example pack, live smoke evidence, and a clean stacked branch.

- [ ] **Step 1: Add and validate the example pack**

Create a harmless pack with one instruction, one `review-pr` skill, one optional HTTP MCP using a `rookery-secret` bearer ref, and no executable command. Test the real `validateCapabilityPack` against the checked-in directory and assert its id/contents/digest.

- [ ] **Step 2: Update evergreen documentation**

Document all new request/result/event types, four tables and delete behavior, write-only secret boundary, precedence/audience semantics, desired-only Slice 2 boundary, local pack layout, and Capability Center workflow. Mark Slice 2 implemented in the design while retaining later runtime slices as unshipped.

- [ ] **Step 3: Run final static and automated gates**

Run:

```bash
rg -n "TODO|TBD|FIXME|placeholder|coming soon|implement later" src/core/capabilities apps/desktop/src/renderer/components/capabilities docs/superpowers/plans/2026-07-13-capability-center-slice-2.md
git diff --check
npm run typecheck
npm test
npm run build
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop test
npm --workspace apps/desktop run build
```

Expected: all gates PASS; contextual documentation may name later slices, but no Slice 2 code path is a stub.

- [ ] **Step 4: Run an isolated live daemon protocol smoke**

Start the built daemon with a temporary `ROOKERY_HOME`, `/dev/null` env file, and unused port. Register the checked-in example pack, verify it starts untrusted, trust the exact digest, set a known canary secret, and assert every response/event/database-facing sanitized projection omits the canary. Create Rookery, repo-local, session, and worker bindings; request master/worker snapshots; verify precedence/tombstone/audience and stable desired revisions. Modify a copied instruction, refresh, and verify `untrusted` plus blocked desired state. Confirm no `capability-runtime` directory or provider config mutation appears.

- [ ] **Step 5: Run an Electron smoke**

Launch desktop against the isolated daemon. Verify Library add/review/trust/secret/refresh/remove, Assignments create/edit/tombstone/delete, and Effective desired/blocked/suppressed states. Switch master/worker targets and confirm authoritative cwd/repo behavior and no stale response. Capture terminal/renderer errors and fix them before completion.

- [ ] **Step 6: Audit every exit criterion with direct evidence**

For each of the ten criteria above, point to a focused test, full gate, or live observation. Missing or indirect evidence requires another test/fix. Explicitly inspect protocol serialization and the temporary home for the canary secret; a passing unit test alone is insufficient for the write-only boundary claim.

- [ ] **Step 7: Commit docs and final tested fixes**

```bash
git add AGENTS.md README.md docs test/core/capabilities/example-pack.test.ts
git commit -m "docs: finalize capability center slice two"
```

- [ ] **Step 8: Final branch audit**

Run:

```bash
git status --short --untracked-files=all
git diff --check origin/main...HEAD
git log --oneline --decorate -8
```

Expected: clean `feat/capability-center-slice-2`, Slice 1 plus Slice 2 commits only, no temporary symlink/output, and no unrelated user files.
