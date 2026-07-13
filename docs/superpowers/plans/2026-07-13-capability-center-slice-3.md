# Capability Center Slice 3: Claude Application Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Compile trusted managed capability packs into an isolated Claude runtime and apply the desired revision to Claude masters on each turn and to newly opened or resumed Claude workers.

**Architecture:** The resolver will expose a secret-free internal runtime projection alongside the existing UI projection. A daemon-owned materializer will copy and revalidate each selected pack into an immutable revision directory, generate one local Claude plugin per pack, and resolve write-only secrets only into the spawned child environment. `MasterAgent` and `Worker` will pass the resolved projection through the provider-neutral backend options; `ClaudeBackend` will merge generated plugins, instructions, and environment aliases with its existing options. An in-memory runtime-state service will publish desired/applied drift without persisting provider processes or secret-bearing data.

**Tech Stack:** TypeScript, Node.js 22 filesystem APIs, Claude Agent SDK local plugin options, Zod, Vitest, React 18, Electron/Vite.

---

## Scope guardrails

- Implement Claude master and worker application only. Codex compilation remains Slice 4.
- Track worker drift, but do not add non-terminal worker reload controls; reload remains Slice 5.
- Do not discover `.rookery/capabilities.json`; repository-shared discovery remains Slice 5.
- Do not add slash actions or managed-skill composer invocation; command actions remain Slice 6.
- Never mutate `~/.claude`, a repository's `.claude` directory, or the user's provider configuration.
- Never serialize instruction bodies or secret values into protocol messages, events, logs, revisions, generated configuration, or argv.

### Task 1: Define runtime projections and desired/applied state

**Files:**
- Create: `src/core/capabilities/runtime-state.ts`
- Modify: `src/core/capabilities/types.ts`
- Modify: `src/core/capabilities/resolver.ts`
- Modify: `src/core/events.ts`
- Test: `test/core/capabilities/runtime-state.test.ts`
- Test: `test/core/capabilities/resolver.test.ts`

**Step 1: Write failing runtime-state tests**

Cover master `pending-next-turn -> current`, worker `pending-reload -> current`, blocked and error states, idempotent event emission, and the guarantee that emitted events contain revisions and target identifiers only.

**Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run test/core/capabilities/runtime-state.test.ts`
Expected: FAIL because the runtime-state module and event member do not exist.

**Step 3: Add secret-free runtime types**

Add flat instruction/skill/MCP runtime entries with pack instance id, logical pack id, trusted digest, source path, public spec, and generated MCP name. Extend `CapabilityState` with `pending-next-turn` and `pending-reload`, and add `appliedRevision` to snapshots. Do not add secret values to any exported projection.

**Step 4: Implement in-memory runtime state**

Store desired/applied revision and a sanitized error per `master:<id>` or `worker:<id>`. Derive `current`, `pending-next-turn`, `pending-reload`, `blocked`, or `error`, emit `capabilities.runtime` only on an actual transition, and keep all state process-local.

**Step 5: Extend resolver output**

Build a deterministic runtime projection only from enabled, trusted entries. Omit optional MCP servers with missing requirements, suppress Side MCP, and retain required-missing blocking. Use deterministic `rookery__<pack-id>__<server-id>` names. Preserve the existing secret-free revision algorithm.

**Step 6: Run focused tests**

Run: `npx vitest run test/core/capabilities/runtime-state.test.ts test/core/capabilities/resolver.test.ts`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/core/capabilities/types.ts src/core/capabilities/resolver.ts src/core/capabilities/runtime-state.ts src/core/events.ts test/core/capabilities/runtime-state.test.ts test/core/capabilities/resolver.test.ts
git commit -m "feat: track capability runtime revisions"
```

### Task 2: Build the Claude compiler and immutable runtime materializer

**Files:**
- Create: `src/core/claude-capabilities.ts`
- Create: `src/daemon/capability-runtime.ts`
- Modify: `src/core/capabilities/registry.ts`
- Test: `test/core/claude-capabilities.test.ts`
- Test: `test/daemon/capability-runtime.test.ts`

**Step 1: Write failing pure compiler tests**

Assert deterministic plugin manifest and MCP JSON output for stdio and streamable HTTP servers, generated names, relative cwd rebasing, instruction ordering, tool timeout lowering, and `${ROOKERY_CAP_SECRET_*}` references without values.

**Step 2: Write failing materializer tests**

Use a temporary pack to assert revision layout, one local plugin per pack, copied skill resources/scripts, `0700` directories, `0600` metadata files, immutable reuse, environment-only secret values, and no secret values in any generated file. Change source content without registry refresh and assert exact-digest revalidation rejects materialization.

**Step 3: Run the focused tests and confirm failure**

Run: `npx vitest run test/core/claude-capabilities.test.ts test/daemon/capability-runtime.test.ts`
Expected: FAIL because compiler/materializer modules do not exist.

**Step 4: Implement pure Claude lowering**

Generate safe plugin names, `.claude-plugin/plugin.json`, `.mcp.json`, deterministic environment aliases, and joined instruction fragments. Keep public configuration and environment references in files; return secret values only in an in-memory environment overlay. Surface unsupported/lossy Claude fields as diagnostics rather than silently discarding them.

**Step 5: Implement atomic materialization**

Stage under the runtime parent, copy each whole source pack, validate the staged copy, require its digest to equal the trusted resolver digest, build plugins from that immutable staged source, harden modes, then atomically rename to `capability-runtime/<revision>`. Reuse an existing complete revision directory without rewriting it.

**Step 6: Add the registry's daemon-only secret accessor**

Expose one explicitly internal method that reads a declared Rookery secret by pack instance/key. Keep every Library/protocol projection unchanged and write-only.

**Step 7: Run focused tests and typecheck**

Run: `npx vitest run test/core/claude-capabilities.test.ts test/daemon/capability-runtime.test.ts test/core/capabilities/registry.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

**Step 8: Commit**

```bash
git add src/core/claude-capabilities.ts src/daemon/capability-runtime.ts src/core/capabilities/registry.ts test/core/claude-capabilities.test.ts test/daemon/capability-runtime.test.ts
git commit -m "feat: materialize claude capability plugins"
```

### Task 3: Pass managed capabilities through the Claude backend

**Files:**
- Modify: `src/core/agent-backend.ts`
- Modify: `src/core/claude-backend.ts`
- Modify: `src/core/codex-backend.ts`
- Test: `test/core/claude-backend.test.ts`
- Test: `test/core/provider-neutral.test.ts`

**Step 1: Write failing backend option tests**

Capture SDK `query()` options and assert generated local plugins are additive, managed instructions append after the caller's existing prompt, the environment is merged rather than replaced, existing direct master MCP servers remain untouched, and native `settingSources` are not disabled. Verify no secret enters query argv-facing MCP JSON.

**Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run test/core/claude-backend.test.ts test/core/provider-neutral.test.ts`
Expected: FAIL because `AgentSessionOptions` cannot carry the resolved projection and Claude has no compiler hook.

**Step 3: Extend the provider-neutral session options**

Add `runtimeKey` and optional resolved managed capabilities. Codex accepts and ignores the projection in this slice; no Codex home or config is created.

**Step 4: Merge compiled options in ClaudeBackend**

Inject a synchronous compiler/materializer callback into `ClaudeBackend`. Merge plugins, appended instructions, and the child environment overlay with existing options while preserving the direct Rookery MCP tool path and native filesystem settings.

**Step 5: Run focused tests and typecheck**

Run: `npx vitest run test/core/claude-backend.test.ts test/core/provider-neutral.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/core/agent-backend.ts src/core/claude-backend.ts src/core/codex-backend.ts test/core/claude-backend.test.ts test/core/provider-neutral.test.ts
git commit -m "feat: load managed capabilities in claude backend"
```

### Task 4: Apply revisions to masters and workers

**Files:**
- Modify: `src/core/master-agent.ts`
- Modify: `src/core/worker.ts`
- Modify: `src/core/session-manager.ts`
- Modify: `src/core/fleet-orchestrator.ts`
- Test: `test/core/master-agent.test.ts`
- Test: `test/core/worker.test.ts`
- Test: `test/core/session-manager.test.ts`
- Test: `test/core/fleet-orchestrator.test.ts`

**Step 1: Write failing master tests**

Resolve twice around a binding/revision change and assert each turn passes the latest revision while preserving per-turn model/effort behavior. Assert blocked compilation fails before a provider stream starts and runtime state records a sanitized error.

**Step 2: Write failing worker tests**

Assert a new worker and a lazily resumed worker resolve exactly once before `openSession`, pass `runtimeKey`, and confirm the applied revision on provider initialization. Assert later registry changes do not mutate the live stream or trigger an automatic restart.

**Step 3: Run focused tests and confirm failure**

Run: `npx vitest run test/core/master-agent.test.ts test/core/worker.test.ts test/core/session-manager.test.ts test/core/fleet-orchestrator.test.ts`
Expected: FAIL because agents do not resolve or report managed runtime revisions.

**Step 4: Wire master next-turn resolution**

Inject a target-bound resolver into each master. Resolve inside the serialized turn immediately before `startTurn`, pass the projection and runtime key, mark desired before spawn, mark applied after successful stream creation, and record a sanitized runtime error on failure.

**Step 5: Wire worker initial/resume resolution**

Inject a target-bound resolver and runtime callbacks through the factory. Resolve at the start of `consume()` only, pass the projection to `openSession`, and mark applied on the first provider event. Preserve the same resolved revision for the life of that stream.

**Step 6: Run focused tests and typecheck**

Run: `npx vitest run test/core/master-agent.test.ts test/core/worker.test.ts test/core/session-manager.test.ts test/core/fleet-orchestrator.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/core/master-agent.ts src/core/worker.ts src/core/session-manager.ts src/core/fleet-orchestrator.ts test/core/master-agent.test.ts test/core/worker.test.ts test/core/session-manager.test.ts test/core/fleet-orchestrator.test.ts
git commit -m "feat: apply claude capabilities to agents"
```

### Task 5: Compose the daemon and expose effective runtime state

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `src/core/capabilities/service.ts`
- Modify: `apps/desktop/src/renderer/store/reduce.ts`
- Modify: `apps/desktop/src/renderer/components/CapabilitiesPage.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/capabilities.ts`
- Test: `test/core/capabilities/service.test.ts`
- Test: `test/daemon/server.test.ts`
- Test: `apps/desktop/test/store/reduce.test.ts`
- Test: `apps/desktop/test/components/CapabilitiesPage.test.tsx`

**Step 1: Write failing service and UI tests**

Assert authoritative Claude snapshots expose `appliedRevision`, map managed desired entries to `applied`, `pending-next-turn`, `pending-reload`, or `error`, leave Codex entries desired, and retain blocked/unavailable/suppressed states. Assert a runtime event invalidates the open Effective view and both locales render desired/applied drift.

**Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run test/core/capabilities/service.test.ts test/daemon/server.test.ts`
Expected: FAIL because runtime state is not composed or projected.

Run: `npm -w apps/desktop test -- --run test/store/reduce.test.ts test/components/CapabilitiesPage.test.tsx`
Expected: FAIL because the renderer does not handle runtime events or new states.

**Step 3: Compose registry, resolver, runtime state, and materializer**

Create them before agent factories in `startDaemon()`. Inject target-bound resolvers into `SessionManager` and the worker factory, and inject the materializer into `ClaudeBackend`. Keep Codex backend configuration unchanged.

**Step 4: Project runtime state into snapshots**

For Claude targets only, attach the applied revision, remap managed desired entries according to drift/error state, add a sanitized runtime diagnostic when needed, and keep native/builtin contributions unchanged.

**Step 5: Update the Effective UI**

Handle `capabilities.runtime` as a monotonic invalidation, display desired and applied revision summaries, add localized pending labels, and preserve stale-response protection and the existing three-tab layout.

**Step 6: Run focused and workspace checks**

Run: `npx vitest run test/core/capabilities/service.test.ts test/daemon/server.test.ts`
Expected: PASS.

Run: `npm -w apps/desktop run typecheck && npm -w apps/desktop test -- --run test/store/reduce.test.ts test/components/CapabilitiesPage.test.tsx`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/daemon/server.ts src/core/capabilities/service.ts apps/desktop/src/renderer/store/reduce.ts apps/desktop/src/renderer/components/CapabilitiesPage.tsx apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts apps/desktop/src/renderer/i18n/locales/en/capabilities.ts test/core/capabilities/service.test.ts test/daemon/server.test.ts apps/desktop/test/store/reduce.test.ts apps/desktop/test/components/CapabilitiesPage.test.tsx
git commit -m "feat: surface claude capability runtime state"
```

### Task 6: Update durable documentation and examples

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/reference/protocol.md`
- Modify: `docs/reference/events.md`
- Modify: `docs/architecture/master-worker-turn.md`
- Modify: `docs/superpowers/specs/2026-07-13-capability-center-design.md`
- Test: `test/core/capabilities/example-pack.test.ts`

**Step 1: Document the shipped Slice 3 boundary**

Replace desired-only warnings with the exact Claude runtime layout, secret/environment boundary, master next-turn behavior, worker initial/resume behavior, applied revision semantics, and explicit Slice 4/5 exclusions.

**Step 2: Run documentation-sensitive tests and placeholder scans**

Run: `npx vitest run test/core/capabilities/example-pack.test.ts`
Expected: PASS.

Run: `rg -n "TODO|FIXME|placeholder|Slice 2 is desired-only|does not add appliedRevision" src test apps/desktop docs AGENTS.md README.md`
Expected: no new implementation placeholders and no stale Slice 2 runtime claims in current reference text.

**Step 3: Commit**

```bash
git add AGENTS.md README.md docs/reference/protocol.md docs/reference/events.md docs/architecture/master-worker-turn.md docs/superpowers/specs/2026-07-13-capability-center-design.md test/core/capabilities/example-pack.test.ts
git commit -m "docs: describe claude capability application"
```

### Task 7: Full verification and live Claude smoke

**Files:**
- Create if useful: `scripts/smoke-capability-runtime.mjs`
- Modify if created: `package.json`

**Step 1: Activate the required runtime**

Run: `source ~/.nvm/nvm.sh && nvm use 22`
Expected: Node 22 / ABI 127.

**Step 2: Run all automated gates**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

Run: `npm -w apps/desktop run typecheck`
Expected: PASS.

Run: `npm -w apps/desktop test`
Expected: PASS.

Run: `npm -w apps/desktop run build`
Expected: PASS.

**Step 3: Run an isolated live master smoke**

Use a temporary `ROOKERY_HOME`, register and trust a harmless pack containing an instruction, a skill, and a local read-only MCP fixture, bind it to a Claude UI master, run a turn, and verify the instruction, skill catalog, MCP tool, generated runtime path, and matching desired/applied revision. Inspect generated files and captured process arguments to prove no secret value appears.

**Step 4: Run an isolated live worker smoke**

Spawn a Claude worker with the same applicable binding, verify it applies on initial open, exercise the harmless MCP/skill, restart the isolated daemon, lazily resume the worker, and verify the same revision is compiled/applied without creating another git worktree.

**Step 5: Audit the diff and security boundary**

Run: `git diff --check && git status --short && git diff --stat 5c71f55...HEAD`
Expected: no whitespace errors, only Slice 3 files, and no generated runtime artifacts tracked.

Run: `rg -n "secretValue|secret_value|ROOKERY_CAP_SECRET" src test apps/desktop docs`
Expected: secret-value reads occur only at the internal registry/materializer boundary; UI/protocol/events contain aliases, configured state, versions, or test sentinels only.

Review every changed type for provider neutrality and every event/protocol projection for secret safety. Confirm Codex homes/config and worker reload paths are untouched.

**Step 6: Commit smoke support if added**

```bash
git add scripts/smoke-capability-runtime.mjs package.json
git commit -m "test: add claude capability runtime smoke"
```

**Step 7: Final branch audit**

Run: `git status --short --branch && git log --oneline 5c71f55..HEAD`
Expected: clean worktree and a reviewable sequence of focused Slice 3 commits.
