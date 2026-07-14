# Capability Center Slice 5B Repository-Shared Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover capability packs checked into registered repositories, require trust for each exact digest, keep them synchronized through refresh/watch events, and reclaim stale immutable runtime revisions at safe boot boundaries.

**Architecture:** A pure repository-index parser defines the checked-in contract. `CapabilityRegistry` reconciles that index against existing `repo-shared` rows without a new migration, preserving instance identity/trust/secrets for unchanged paths and failing closed on changes. A daemon watcher debounces `.rookery` filesystem events and a repository change subscription covers every registration path, including MCP tools and WebSocket clients.

**Tech Stack:** TypeScript, Node.js 22 `fs.watch`, Zod, SQLite/better-sqlite3, Vitest, React 18.

## Global Constraints

- Shared configuration lives only at `<repo>/.rookery/capabilities.json` and `<repo>/.rookery/capabilities/<pack>/capability.json`.
- The index contract is `{ "schemaVersion": 1, "packs": [{ "path": "team-pack", "disabled"?: boolean }] }`; each `path` is relative to `.rookery/capabilities`, unique, and bounded to 256 entries.
- Every index path and pack symlink must resolve inside `<repo>/.rookery/capabilities`; traversal and escaping links are errors.
- Discovery never creates a binding and never trusts a digest. A content change keeps bindings but makes the pack untrusted because trust is keyed by digest.
- A disabled index entry is a tombstone: it is not discovered, and an existing row for that exact shared source is removed.
- Removing the index removes only repository-owned shared pack rows and their child bindings/trust/secrets. Independently registered local packs remain untouched.
- One invalid index or pack must surface a diagnostic without blanking the rest of the Library.
- Watch events are debounced and advisory. Manual Refresh must perform a complete authoritative reconciliation even when watching is unavailable.
- Watchers are closed on repository removal and daemon shutdown.
- Generated runtime garbage collection runs only at daemon boot, before clients/provider turns can race it.
- All user-facing desktop text must exist in both Korean and English catalogs.
- Run all commands under Node 22.

---

### Task 1: Define and validate the repository-shared index

**Files:**

- Create: `src/core/capabilities/repo-shared.ts`
- Create: `test/core/capabilities/repo-shared.test.ts`
- Create: `docs/examples/repo-shared-capabilities/.rookery/capabilities.json`
- Create: `docs/examples/repo-shared-capabilities/.rookery/capabilities/team/capability.json`
- Create: `docs/examples/repo-shared-capabilities/.rookery/capabilities/team/instructions/team.md`
- Modify: `test/core/capabilities/example-pack.test.ts`

**Interfaces:**

- Produces: `readRepoSharedIndex(repoPath: string): RepoSharedIndexResult`.
- Produces: `RepoSharedIndexResult = { kind: "missing" } | { kind: "valid"; indexPath: string; entries: RepoSharedEntry[] } | { kind: "invalid"; indexPath: string; errors: string[] }`.
- Produces: `RepoSharedEntry = { declaredPath: string; sourcePath: string; disabled: boolean }`.

- [ ] **Step 1: Write failing pure parser tests**

  Cover missing index, valid sorted entries, default `disabled:false`, duplicate declared/canonical paths, unknown schema versions/keys, more than 256 entries, absolute paths, `..`, empty paths, file-vs-directory mismatch, and symlink escape.

  ```ts
  expect(readRepoSharedIndex(repo)).toEqual({
    kind: "valid",
    indexPath: path.join(repo, ".rookery", "capabilities.json"),
    entries: [{
      declaredPath: "team",
      sourcePath: fs.realpathSync.native(path.join(repo, ".rookery", "capabilities", "team")),
      disabled: false,
    }],
  });
  ```

- [ ] **Step 2: Run the parser test and confirm module failure**

  Run: `npx vitest run test/core/capabilities/repo-shared.test.ts`

  Expected: FAIL because `repo-shared.ts` does not exist.

- [ ] **Step 3: Implement the strict parser**

  Use an exact Zod schema:

  ```ts
  const repoSharedIndexSchema = z.object({
    schemaVersion: z.literal(1),
    packs: z.array(z.object({
      path: z.string().trim().min(1).max(240),
      disabled: z.boolean().optional(),
    }).strict()).max(256),
  }).strict();
  ```

  Resolve enabled and disabled entries under the canonical capabilities directory, reject lexical/canonical containment escapes, and return sorted normalized results. Parse/read/stat failures become `kind:"invalid"` with stable human-readable errors rather than throws.

- [ ] **Step 4: Add and validate the checked-in example**

  The example index contains one enabled `team` entry and one disabled tombstone. Its pack contains an instruction-only valid manifest so tests do not need credentials or processes.

- [ ] **Step 5: Run focused tests and typecheck**

  Run: `npx vitest run test/core/capabilities/repo-shared.test.ts test/core/capabilities/example-pack.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 6: Commit the index contract**

  ```bash
  git add src/core/capabilities/repo-shared.ts test/core/capabilities/repo-shared.test.ts docs/examples/repo-shared-capabilities test/core/capabilities/example-pack.test.ts
  git commit -m "feat: define repository shared capability indexes"
  ```

### Task 2: Reconcile discovered packs safely

**Files:**

- Modify: `src/core/capabilities/types.ts`
- Modify: `src/core/capabilities/registry.ts`
- Modify: `test/core/capabilities/registry.test.ts`
- Modify: `test/core/capabilities/resolver.test.ts`

**Interfaces:**

- Consumes: `readRepoSharedIndex` from Task 1.
- Produces: `CapabilityRegistry.reconcileRepoShared(repoId?: string): CapabilityLibrarySnapshot`.
- Produces: `CapabilityRegistry.invalidate(affected: CapabilityScopeRef[]): void` for persistence-owned cleanup that already removed rows.
- Extends: `CapabilityLibrarySnapshot` with `diagnostics: CapabilityDiagnostic[]`.
- Preserves: existing `refresh(instanceId?)` API; full refresh calls shared reconciliation first, and shared-instance refresh reconciles its owner repository.

- [ ] **Step 1: Add failing registry reconciliation tests**

  Prove:

  ```ts
  const first = registry.reconcileRepoShared("repo-1");
  expect(first.packs[0]).toMatchObject({
    sourceKind: "repo-shared",
    ownerRepoId: "repo-1",
    status: "untrusted",
  });
  expect(first.bindings).toEqual([]);
  ```

  Then trust/bind the pack, reconcile unchanged bytes, and assert instance id/trust/secret versions/binding timestamps stay unchanged. Modify a file and assert the same instance id becomes `untrusted` with reviewable changes. Cover disabled tombstone, removed index, invalid index fail-closed behavior, one invalid new pack beside one valid pack, and no mutation of local-directory rows.

- [ ] **Step 2: Run focused registry tests and confirm missing reconciliation**

  Run: `npx vitest run test/core/capabilities/registry.test.ts test/core/capabilities/resolver.test.ts`

  Expected: FAIL because shared reconciliation and Library diagnostics are absent.

- [ ] **Step 3: Add sanitized Library diagnostics**

  Extend the snapshot:

  ```ts
  export interface CapabilityLibrarySnapshot {
    generation: number;
    packs: CapabilityLibraryEntry[];
    bindings: CapabilityBinding[];
    diagnostics: CapabilityDiagnostic[];
  }
  ```

  Diagnostics contain only repo label/path, stable code/source, and validation text; never instruction/skill bodies or secret values.

- [ ] **Step 4: Implement one-pass reconciliation**

  For each selected registered repository:

  1. Read its index.
  2. On missing index, delete all owned `repo-shared` rows.
  3. On invalid index, retain existing rows but mark them invalid with the index diagnostic so no new runtime can resolve them.
  4. For each enabled valid entry, update the existing `(source_kind, source_path)` row in place or create one untrusted row with `owner_repo_id`.
  5. For each disabled/stale path, delete only the matching owned row.
  6. Validate every enabled pack independently; update valid siblings even when another sibling fails.
  7. Emit one generation change containing the union of all bindings that changed or disappeared.

  Do not call public `add`/`remove` from inside the loop because those emit per row. Factor private row create/update/delete helpers and publish once after the transaction-like reconciliation pass.

- [ ] **Step 5: Make Refresh authoritative**

  `refresh()` with no instance id reconciles every repository, then refreshes only local-directory/rookery-generated rows not already validated by reconciliation. Refreshing one repo-shared instance reconciles its owner repo. A removed source path returns the updated Library rather than an unknown-pack error when removal was discovered during that same request.

- [ ] **Step 6: Run registry/resolver tests and typecheck**

  Run: `npx vitest run test/core/capabilities/registry.test.ts test/core/capabilities/resolver.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 7: Commit registry reconciliation**

  ```bash
  git add src/core/capabilities/types.ts src/core/capabilities/registry.ts test/core/capabilities/registry.test.ts test/core/capabilities/resolver.test.ts
  git commit -m "feat: discover repository shared capability packs"
  ```

### Task 3: Connect repository lifecycle and filesystem watching

**Files:**

- Modify: `src/persistence/repositories.ts`
- Modify: `test/persistence/repositories.test.ts`
- Create: `src/daemon/capability-repo-watcher.ts`
- Create: `test/daemon/capability-repo-watcher.test.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/daemon/server.test.ts`

**Interfaces:**

- Produces: `Repositories.onRepoChanged(listener: (change: RepoChange) => void): () => void`.
- Produces: `RepoChange = { kind: "created" | "updated" | "removed"; repo: RepoRow; affected: CapabilityScopeRef[] }`.
- Produces: `CapabilityRepoWatcher.start(): void`, `reconcile(): void`, and `close(): void`.

- [ ] **Step 1: Add failing repository change tests**

  Assert that WebSocket/tool-agnostic persistence mutations publish created/updated/removed changes after successful writes only. For removal, `affected` must include every scope formerly bound through the repo or any owned shared pack, including rookery/session/worker bindings to an owned pack.

- [ ] **Step 2: Add failing watcher tests with fake watchers/timers**

  Prove one root watcher and one recursive `.rookery` watcher per registered repository, one reconciliation for a burst of relevant events, no reconciliation for unrelated root files, watcher replacement when `.rookery` is created/deleted, cleanup on repo removal, and complete cleanup on daemon shutdown.

- [ ] **Step 3: Run focused tests and confirm missing event/watcher APIs**

  Run: `npx vitest run test/persistence/repositories.test.ts test/daemon/capability-repo-watcher.test.ts`

  Expected: FAIL because the subscription and watcher do not exist.

- [ ] **Step 4: Implement repository mutation subscriptions**

  Add a listener set to `Repositories`. `createRepo`/`updateRepo` publish after their DB write. `removeRepo` computes affected scopes before its existing cleanup transaction, commits removal, then publishes the captured change. Listener exceptions are isolated so a watcher cannot fail repository CRUD.

- [ ] **Step 5: Implement the debounced watcher**

  Watch each repo root non-recursively for `.rookery` creation/removal and watch an existing `.rookery` directory recursively for index/pack changes. Debounce per repo for 200 ms, call `registry.reconcileRepoShared(repo.id)`, and refresh watcher topology. A watch setup failure leaves manual Refresh authoritative and emits one sanitized process warning. The injected watch/timer functions make tests deterministic.

- [ ] **Step 6: Wire boot, runtime, and shutdown**

  In `startDaemon()`:

  ```ts
  capabilityRegistry.reconcileRepoShared();
  const capabilityRepoWatcher = new CapabilityRepoWatcher({ repos, registry: capabilityRegistry });
  capabilityRepoWatcher.start();
  ```

  Register the repository mutation listener through the watcher. Created/updated repos reconcile and refresh watcher topology; removed repos call `capabilityRegistry.invalidate(change.affected)` after persistence cleanup. Call `capabilityRepoWatcher.close()` before `db.close()`.

- [ ] **Step 7: Run daemon/persistence tests and typecheck**

  Run: `npx vitest run test/persistence/repositories.test.ts test/daemon/capability-repo-watcher.test.ts test/daemon/server.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 8: Commit watcher/lifecycle integration**

  ```bash
  git add src/persistence/repositories.ts test/persistence/repositories.test.ts src/daemon/capability-repo-watcher.ts test/daemon/capability-repo-watcher.test.ts src/daemon/server.ts test/daemon/server.test.ts
  git commit -m "feat: watch repository shared capabilities"
  ```

### Task 4: Show shared sources and diagnostics in the desktop

**Files:**

- Modify: `apps/desktop/src/renderer/components/capabilities/CapabilityLibraryTab.tsx`
- Modify: `apps/desktop/src/renderer/components/capabilities/CapabilityAssignmentsTab.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/capabilities.ts`
- Modify: `apps/desktop/test/capability-library-tab.test.tsx`
- Modify: `apps/desktop/test/capability-assignments-tab.test.tsx`

**Interfaces:**

- Consumes: `CapabilityLibrarySnapshot.diagnostics` and existing `sourceKind`/`ownerRepoId`.

- [ ] **Step 1: Add failing shared Library tests**

  Assert repository-shared source badges, owner repository label, discovered-untrusted review, digest-change warning, disabled/removed disappearance, and partial diagnostics beside healthy packs. Assert the Remove action is absent for repo-shared packs because the checked-in index owns discovery; local packs retain Remove.

- [ ] **Step 2: Add failing Assignments tests**

  Assert `repo-shared` is selectable only when the selected pack is owned by the selected repository and that changing pack/repo clears an invalid pair before save.

- [ ] **Step 3: Run focused desktop tests and confirm failure**

  Run: `npm -w apps/desktop test -- capability-library-tab.test.tsx capability-assignments-tab.test.tsx`

  Expected: FAIL because shared source/diagnostic behavior is not rendered.

- [ ] **Step 4: Implement source-aware Library and Assignments UI**

  Render a localized source badge and repo label. Show Library diagnostics in a non-blocking warning section. Explain that shared packs are edited in the repository and removed through the index. Filter repo-shared scope targets to `pack.ownerRepoId` and prevent a stale invalid selection from reaching the daemon.

- [ ] **Step 5: Add matching Korean/English catalog entries**

  Cover repository-shared labels, owner, index-controlled removal, index/pack diagnostics, and automatic discovery/trust guidance.

- [ ] **Step 6: Run desktop focused gates**

  Run: `npm -w apps/desktop test -- capability-library-tab.test.tsx capability-assignments-tab.test.tsx && npm -w apps/desktop run typecheck`

  Expected: PASS.

- [ ] **Step 7: Commit desktop shared-pack UX**

  ```bash
  git add apps/desktop/src/renderer/components/capabilities/CapabilityLibraryTab.tsx apps/desktop/src/renderer/components/capabilities/CapabilityAssignmentsTab.tsx apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts apps/desktop/src/renderer/i18n/locales/en/capabilities.ts apps/desktop/test/capability-library-tab.test.tsx apps/desktop/test/capability-assignments-tab.test.tsx
  git commit -m "feat: surface repository shared capabilities"
  ```

### Task 5: Garbage-collect immutable runtime revisions at boot

**Files:**

- Modify: `src/daemon/capability-runtime.ts`
- Modify: `test/daemon/capability-runtime.test.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/daemon/server.test.ts`

**Interfaces:**

- Produces: `gcCapabilityRuntime(home: string, liveRevisions: ReadonlySet<string>): void`.

- [ ] **Step 1: Add failing GC tests**

  Create complete 64-hex revision directories, incomplete revisions, `.tmp-*` staging directories, unrelated files, and symlinks. Assert GC keeps exactly the named complete revisions, removes other managed revision/staging directories without following symlinks, preserves unrelated entries, and never throws on missing/unreadable paths.

- [ ] **Step 2: Run focused test and confirm missing function**

  Run: `npx vitest run test/daemon/capability-runtime.test.ts`

  Expected: FAIL because `gcCapabilityRuntime` is absent.

- [ ] **Step 3: Implement boot-safe GC**

  Only names matching `/^[a-f0-9]{64}$/` or `.tmp-` are owned. Use `lstat`, never traverse a symlink, and best-effort `rmSync(..., {recursive:true, force:true})`. Keep a revision only when it is in `liveRevisions` and has a valid schema-2 `.complete.json` marker for the same revision.

- [ ] **Step 4: Compute desired revisions at daemon boot**

  After shared discovery and `CapabilityService` composition, resolve every authoritative session and worker target, collect secret-free desired revisions, and call GC before accepting WebSocket clients. Invalid targets contribute diagnostics but do not abort daemon startup.

- [ ] **Step 5: Run runtime/server tests and typecheck**

  Run: `npx vitest run test/daemon/capability-runtime.test.ts test/daemon/server.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 6: Commit runtime GC**

  ```bash
  git add src/daemon/capability-runtime.ts test/daemon/capability-runtime.test.ts src/daemon/server.ts test/daemon/server.test.ts
  git commit -m "fix: reclaim stale capability runtimes"
  ```

### Task 6: Document, smoke, and audit Slice 5B

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/reference/data-model.md`
- Modify: `docs/reference/protocol.md`
- Modify: `docs/superpowers/specs/2026-07-13-capability-center-design.md`
- Modify: `scripts/smoke-capability-center-slice5.mjs`

**Interfaces:**

- Extends the Slice 5A smoke with repository-shared discovery and watcher evidence.

- [ ] **Step 1: Extend the isolated smoke**

  The smoke writes the pack under the temporary repo's `.rookery/capabilities`, registers only the repository, observes automatic untrusted discovery, trusts/binds it, verifies both providers, changes an instruction without sending `capabilities.refresh`, waits for watcher-driven `capabilities.changed`, proves the digest becomes untrusted, re-trusts/reloads, and confirms the new revision. Removing the index must remove the discovered pack while preserving an independently registered local pack.

- [ ] **Step 2: Update evergreen documentation and the accepted design**

  Document exact index JSON, path containment, tombstones, trust invalidation, watcher/manual-refresh behavior, removal ownership, boot GC, and Slice 5 completion. Remove statements that repository-shared discovery/runtime GC remain unshipped.

- [ ] **Step 3: Run stale-boundary and diff audits**

  Run:

  ```bash
  rg -n "repository-shared discovery remains|worker hot reload.*later|Slice 5 remains unshipped" src test apps/desktop docs README.md AGENTS.md
  git diff --check
  ```

  Expected: no stale shipped-boundary claims or whitespace errors.

- [ ] **Step 4: Run full Slice 5 gates**

  Run:

  ```bash
  npm run typecheck
  npm test
  npm -w apps/desktop run typecheck
  npm -w apps/desktop test
  npm run build
  npm run smoke:capabilities:slice5
  ```

  Expected: all PASS.

- [ ] **Step 5: Audit every Slice 5 acceptance criterion**

  Map direct test or live-smoke evidence to busy reload refusal, when-idle scheduling, provider-session preservation, reload retry, shared discovery, exact-digest trust, watcher invalidation, tombstones, repo removal ownership, runtime GC, UI diagnostics, and secret boundaries. Add evidence for every missing mapping before completion.

- [ ] **Step 6: Commit final docs and smoke evidence**

  ```bash
  git add README.md AGENTS.md docs/reference/data-model.md docs/reference/protocol.md docs/superpowers/specs/2026-07-13-capability-center-design.md scripts/smoke-capability-center-slice5.mjs
  git commit -m "docs: complete capability center slice five"
  ```

## Completion evidence

- Registering a repository discovers valid indexed packs without creating bindings or trust.
- A changed shared digest cannot affect any newly opened/reloaded runtime until the user re-trusts it.
- Invalid siblings/indexes surface diagnostics while healthy Library entries remain available.
- Watchers and manual Refresh converge to the same authoritative Library state.
- Disabled/stale shared entries and repository removal clean only repository-owned capability state.
- Old immutable runtime revisions are reclaimed only at a boot boundary and current desired revisions remain intact.
- Full root/desktop gates and the real Claude/Codex Slice 5 smoke pass.
