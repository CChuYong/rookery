# Capability Center Slice 4 — Codex Application and Worker Isolation

**Goal:** Apply trusted capability packs to Codex masters and workers through Rookery-owned, target-specific `CODEX_HOME` directories without mutating the user's real Codex configuration or leaking one target's bindings or secrets into another.

**Architecture:** A pure Codex compiler lowers the provider-neutral resolved manifest into deterministic skill and MCP configuration plus secret alias bindings. The daemon's existing immutable capability runtime copies and revalidates trusted pack bytes once per revision, materializes public Codex artifacts, resolves secret values only into the provider child environment, and combines them with a per-master or per-worker home. Codex backend runtime ports request this launch projection before spawn; workers use their own home for initial open/resume/fork, while masters continue to combine their per-session home with the Rookery MCP bridge.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Codex app-server JSON-RPC, TOML generation, SQLite-backed target resolution.

---

## Task 1: Pin the Codex lowering contract with pure tests

**Files:**

- Create: `src/core/codex/codex-capabilities.ts`
- Create: `test/core/codex/codex-capabilities.test.ts`

1. Add failing tests for deterministic skill paths, instruction ordering, stdio/HTTP MCP lowering, reserved names, timeouts, tool filters, and generated secret aliases.
2. Implement a pure compiler that emits no secret values and rejects blocked manifests.
3. For stdio secret environment variables, emit an immutable launcher descriptor and alias mapping; for HTTP credentials, use Codex's environment-backed bearer/header fields.
4. Run the focused compiler tests and commit.

## Task 2: Extend immutable runtime and target-home materialization

**Files:**

- Modify: `src/daemon/capability-runtime.ts`
- Modify: `src/daemon/codex-home.ts`
- Modify: `test/daemon/capability-runtime.test.ts`
- Modify: `test/daemon/codex-home.test.ts`

1. Add failing tests proving trusted pack bytes are copied immutably, generated files are mode-hardened, and secrets appear only in launch environment values.
2. Materialize Codex revision artifacts alongside Claude artifacts and expose a Codex launch projection containing config blocks, instruction append text, and environment aliases.
3. Generalize Codex homes to explicit master and worker targets under `codex-homes/<session-id>` and `codex-homes/worker-<worker-id>`.
4. Preserve the user's base `config.toml`, append only Rookery-owned bridge/managed sections, keep auth symlink/provisioning behavior, and atomically replace mode-`0600` config.
5. Extend rollout seeding, target cleanup, and boot-only orphan GC to workers, with partial-copy cleanup on failure.
6. Run focused daemon tests and commit.

## Task 3: Apply managed capabilities in Codex backend streams

**Files:**

- Modify: `src/core/codex/codex-backend.ts`
- Modify: `test/core/codex/codex-backend.test.ts`

1. Add failing tests showing a worker's runtime projection is resolved before spawn, merged with configured provider env, and reused for resume without exposing secrets in argv/events.
2. Add failing master tests showing bridge and managed config share the same target home and resolve before child spawn.
3. Inject provider-neutral daemon runtime ports into the backend; require `runtimeKey` with managed capabilities and fail before spawn when materialization fails.
4. Pass per-target environment overrides through both long-lived worker streams and ephemeral master turns.
5. Keep read-only Side MCP suppression intact and run focused backend tests.

## Task 4: Wire authoritative master/worker targets and runtime state

**Files:**

- Modify: `src/core/session-manager.ts`
- Modify: `src/core/capabilities/service.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/core/session-manager.test.ts`
- Modify: `test/core/capabilities/service.test.ts`
- Modify: `test/daemon/server.test.ts`

1. Add failing tests that Codex masters resolve on every turn and Codex workers resolve on initial/lazy-resumed open.
2. Remove the Claude-only gates around managed capability resolvers and desired/applied runtime projection.
3. Compose Codex master and worker home materializers in `startDaemon()`, using authoritative target ids/cwd/repo relationships and the same write-only secret resolver as Claude.
4. Ensure runtime failures block provider spawn and successful initialization advances the applied revision exactly as existing provider-neutral state reporting specifies.
5. Run focused core/daemon tests and commit.

## Task 5: Isolate worker fork, cleanup, and inventory

**Files:**

- Modify: `src/core/fleet-orchestrator.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/core/codex-capabilities-provider.ts`
- Modify: `test/core/fleet-orchestrator.test.ts`
- Modify: `test/core/codex-capabilities-provider.test.ts`
- Modify: `test/daemon/connection.test.ts`

1. Add lifecycle hooks that give a same-provider Codex fork both source and new worker ids before the native fork call.
2. Run `thread/fork` in the source worker home, copy the returned fork rollout and its referenced ancestors into the new worker home, then recompile against the new worker's bindings on lazy resume.
3. Keep cross-provider handoff on a fresh target home with existing transcript seeding.
4. Remove worker homes only at permanent discard/delete ownership boundaries and sweep orphan homes once at boot from authoritative worker rows.
5. Probe Codex native inventory using the selected target's exact effective home/environment so the Center describes what that target will run.
6. Run focused lifecycle and inventory tests and commit.

## Task 6: Update generic UI state and documentation

**Files:**

- Modify: `apps/desktop/src/renderer/components/CapabilityCenter.tsx` only if provider-gated behavior remains
- Modify: relevant desktop tests only if UI behavior changes
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/reference/protocol.md`
- Modify: `docs/architecture/master-worker-turn.md`
- Modify: `docs/superpowers/specs/2026-07-13-capability-center-design.md`

1. Confirm the existing provider-neutral Effective UI renders Codex `applied`, `pending-next-turn`, `pending-reload`, blocked, and error states; add tests only for uncovered behavior.
2. Document per-worker Codex homes, auth/provisioning, immutable managed config, secret boundaries, fork semantics, and cleanup ownership.
3. Update Slice 4 delivery notes and remove Slice 3's Codex desired-only wording.
4. Run desktop typecheck/tests if any UI code or fixtures change and commit.

## Task 7: Full gates and isolated live Codex smoke

**Files:**

- Create: `scripts/smoke-capability-center-codex.mjs`
- Modify: `package.json` if a dedicated smoke script is registered

1. Run Node 22 gates: root typecheck/tests and desktop typecheck/tests.
2. Start an isolated daemon home against the installed Codex app-server and register one local pack containing an instruction, a skill, and a harmless local stdio MCP server with a test secret.
3. Exercise a Codex master and Codex worker, then resume and same-provider fork the worker.
4. Prove the instruction/skill/MCP behavior, distinct target homes, target-specific config, preserved rollout context, cleanup, and desired/applied state.
5. Scan generated config, argv/event captures, and daemon output to prove the secret value is absent; compare the user's real Codex config/auth metadata before and after.
   Secret-bearing launches must also prevent Codex shell snapshots and model-invoked shell environments from persisting/exposing managed aliases.
6. Review `git diff`, ensure the worktree is clean of runtime/dependency artifacts, and commit the smoke evidence.

## Required completion evidence

- The same trusted pack works in a Codex master and worker through provider-native skill/MCP loading.
- Every Codex master and worker child uses a Rookery-owned, target-specific `CODEX_HOME`, regardless of in-app API-key configuration.
- Two workers with different resolved bindings cannot observe one another's config, aliases, rollout state, or secrets.
- Same-provider worker fork preserves Codex conversation state but recompiles target capabilities; cross-provider handoff starts with a fresh provider home.
- Permanent target deletion and boot GC reclaim only orphaned managed homes.
- Real user `~/.codex/config.toml` and auth data are never written.
- Secret values do not appear in TOML, argv, protocol/events, logs, or committed fixtures.
- All required automated gates and the isolated live Codex smoke pass.
