# Capability Center Slice 1 Implementation Plan

> For agentic workers: implement this plan task-by-task, preserving the provider-neutral snapshot contract and proving every task with the listed tests before moving on.

**Goal:** Add a read-only Capability Center that shows the effective capabilities of the selected Claude or Codex master/worker, including provenance, scope, evidence, state, and explicit partial-probe diagnostics.

**Architecture:** Introduce one provider-neutral `CapabilitySnapshot` contract in core. A capability service resolves an authoritative session/worker target and combines Rookery built-ins with provider-native inventory. Claude reuses the existing command catalog; Codex uses short-lived app-server structured list/read requests, with each probe isolated so one unsupported or failed method becomes a diagnostic instead of discarding the snapshot. The daemon exposes a single typed `capabilities.snapshot` request, and the desktop renders its result in an Effective-only overlay without persisting or mutating capability configuration.

**Tech Stack:** TypeScript, Node.js 22, Zod protocol validation, Codex app-server JSON-RPC, React 18, Zustand navigation, Tailwind CSS, Vitest, Testing Library.

**Global Constraints:** No database migration and no capability mutation in Slice 1. Never parse human-oriented CLI output when a structured RPC exists. Never report a probe failure as an empty successful inventory. Preserve the user's existing worktree changes. Put all user-facing desktop text in both `ko` and `en` catalogs. Use `apply_patch` for source edits. Run focused tests after each task, then root and desktop typechecks/tests and a live daemon/UI smoke test.

---

## Task 1: Define the provider-neutral snapshot and Rookery/Claude inventory

**Files:**

- Create: `src/core/capabilities/types.ts`
- Create: `src/core/capabilities/builtins.ts`
- Create: `test/core/capabilities/builtins.test.ts`

### Step 1: Write the failing mapper tests

Cover these behaviors in `test/core/capabilities/builtins.test.ts`:

```ts
it("describes Rookery local actions and master-only tools", () => {
  const master = rookeryCapabilities({ targetKind: "session" });
  expect(master.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
    "rookery.command.btw",
    "rookery.command.side",
    "rookery.tool.memory",
    "rookery.tool.repos",
    "rookery.tool.fleet",
  ]));

  const worker = rookeryCapabilities({ targetKind: "worker" });
  expect(worker.entries.map((entry) => entry.id)).not.toContain("rookery.tool.fleet");
});

it("maps Claude commands without losing source metadata", () => {
  expect(claudeCommandCapabilities([
    { name: "review", description: "Review changes", argumentHint: "[path]" },
  ])[0]).toMatchObject({
    id: "claude.command.review",
    kind: "command",
    provider: "claude",
    state: "applied",
    evidence: "runtime",
  });
});
```

Also assert stable IDs, command scope, source labels, descriptions, and argument hints.

### Step 2: Run the focused test and confirm the expected module-not-found failure

Run: `npx vitest run test/core/capabilities/builtins.test.ts`

Expected: FAIL because the capability modules do not exist.

### Step 3: Add the shared contract

Define these transport-safe types in `src/core/capabilities/types.ts`:

```ts
export type CapabilityTarget =
  | { kind: "session"; id: string }
  | { kind: "worker"; id: string };

export type CapabilityKind =
  | "instruction"
  | "skill"
  | "command"
  | "tool"
  | "mcp"
  | "hook"
  | "plugin"
  | "app";

export type CapabilityState = "applied" | "unavailable" | "blocked" | "error";
export type CapabilityEvidence = "runtime" | "declared" | "inferred";
export type CapabilityScope = "builtin" | "session" | "worker" | "repo" | "user" | "system" | "admin" | "plugin";

export interface CapabilityEntry {
  id: string;
  kind: CapabilityKind;
  name: string;
  description?: string;
  detail?: string;
  provider: "rookery" | "claude" | "codex";
  source: string;
  scope: CapabilityScope;
  state: CapabilityState;
  evidence: CapabilityEvidence;
}

export interface CapabilityDiagnostic {
  id: string;
  source: string;
  severity: "warning" | "error";
  message: string;
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

Keep the contract JSON-serializable and provider-neutral. Do not expose Codex RPC response shapes through it.

### Step 4: Implement deterministic built-in and Claude command mappers

In `src/core/capabilities/builtins.ts`:

- Return `/btw` and `/side` as Rookery client actions for both target kinds.
- Return the memory, repos, fleet, and schedule tool groups only for master/session targets, matching the tools Rookery actually composes into master turns.
- Map `SlashCommandInfo[]` to Claude command entries.
- Sort output deterministically by kind, then name, then ID.
- Return a diagnostic only when the caller supplies an actual discovery failure; an empty successful command list is not itself an error.

### Step 5: Run focused tests

Run: `npx vitest run test/core/capabilities/builtins.test.ts`

Expected: PASS.

### Step 6: Commit the contract task

```bash
git add src/core/capabilities/types.ts src/core/capabilities/builtins.ts test/core/capabilities/builtins.test.ts
git commit -m "feat: define capability snapshot inventory"
```

---

## Task 2: Add the tolerant Codex structured inventory adapter

**Files:**

- Create: `src/core/codex-capabilities-provider.ts`
- Create: `test/core/codex-capabilities-provider.test.ts`
- Modify: `test/helpers/fake-codex.ts`

### Step 1: Write failing pure-mapper tests

Add fixtures for current camelCase app-server responses and prove:

- `skills/list` maps enabled and disabled skills, preserving `scope`, `path`, and load errors.
- `hooks/list` maps enabled/trust state and surfaces warnings/errors.
- `mcpServerStatus/list` maps authentication state and tool counts.
- `plugin/list` emits installed plugins only and distinguishes enabled/disabled.
- `app/list` maps visible apps when supported.
- `config/read` maps active and disabled config layers as declared instruction/config capabilities.
- Missing fields are skipped defensively rather than causing the whole mapper to throw.

Example assertion:

```ts
expect(mapSkillsResponse({
  data: [{
    cwd: "/repo",
    skills: [{ name: "release", description: "Ship", path: "/repo/.agents/skills/release/SKILL.md", scope: "repo", enabled: true }],
    errors: [],
  }],
}).entries[0]).toMatchObject({
  id: "codex.skill.release./repo/.agents/skills/release/SKILL.md",
  kind: "skill",
  scope: "repo",
  state: "applied",
  evidence: "runtime",
});
```

### Step 2: Write failing adapter lifecycle and degradation tests

Extend `fakeCodexSpawn` with optional scripted responses/errors for `skills/list`, `hooks/list`, `mcpServerStatus/list`, `plugin/list`, `app/list`, and `config/read`.

Prove:

1. The child is initialized and each structured method receives the requested cwd.
2. The provider uses the configured Codex binary/env/API-key provisioning path.
3. One rejected/unsupported method produces one diagnostic while successful probes still contribute entries.
4. A handshake/spawn failure returns a snapshot contribution with diagnostics, never `null` and never a false-success empty result.
5. A hung request is bounded by `timeoutMs` and the client is always closed.
6. MCP pagination follows `nextCursor` with a finite safety bound.

### Step 3: Run the focused tests and confirm failure

Run: `npx vitest run test/core/codex-capabilities-provider.test.ts`

Expected: FAIL because the provider is not implemented and the fake does not script the inventory methods.

### Step 4: Implement pure response mappers

In `src/core/codex-capabilities-provider.ts`, keep response interfaces local and defensive. Export mapper functions only for unit testing. Each mapper must return:

```ts
interface CapabilityContribution {
  entries: CapabilityEntry[];
  diagnostics: CapabilityDiagnostic[];
}
```

Use structured source labels such as `Codex skills/list`, `Codex hooks/list`, and `Codex mcpServerStatus/list`. Include paths, matcher/command, auth status, or tool counts in `detail` without exposing secrets or raw config values.

### Step 5: Implement the short-lived provider

Expose:

```ts
export interface CodexCapabilitiesProvider {
  list(input: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<CapabilityContribution>;
}

export function makeCodexCapabilitiesProvider(opts: {
  spawn: CodexSpawn;
  env?: () => NodeJS.ProcessEnv | undefined;
  apiKey?: () => string | undefined;
  timeoutMs?: number;
}): CodexCapabilitiesProvider;
```

Implementation rules:

- Spawn one short-lived `CodexClient` for a snapshot.
- Initialize once using the same app-server handshake pattern as model/auth providers.
- Provision a configured API key through `account/login/start` before inventory calls.
- Run independent probes after initialization; wrap every request in its own timeout/catch.
- Request `skills/list` and `hooks/list` with `cwds: [cwd]`, `config/read` with `cwd` and layers, MCP status with bounded pagination, and plugin/app inventory with their structured methods.
- Treat unsupported experimental methods as diagnostics.
- Close the child in `finally`.
- Deterministically sort merged entries and diagnostics.

### Step 6: Run focused tests

Run: `npx vitest run test/core/codex-capabilities-provider.test.ts test/core/codex-models-provider.test.ts test/core/codex-auth-provider.test.ts`

Expected: PASS with no regressions in existing Codex providers.

### Step 7: Commit the Codex adapter task

```bash
git add src/core/codex-capabilities-provider.ts test/core/codex-capabilities-provider.test.ts test/helpers/fake-codex.ts
git commit -m "feat: inspect codex capabilities"
```

---

## Task 3: Resolve authoritative targets and expose `capabilities.snapshot`

**Files:**

- Create: `src/core/capabilities/service.ts`
- Create: `test/core/capabilities/service.test.ts`
- Modify: `src/protocol/messages.ts`
- Modify: `src/daemon/connection.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/protocol/messages.test.ts`
- Modify: `test/daemon/connection.test.ts`

### Step 1: Write failing capability-service tests

Build the service around narrow injected readers rather than concrete database classes:

```ts
export interface CapabilityServiceDeps {
  getSession(id: string): CapabilitySessionRecord | undefined;
  getWorker(id: string): CapabilityWorkerRecord | undefined;
  listClaudeCommands(input: { target: CapabilityTarget; cwd: string }): Promise<SlashCommandInfo[]>;
  listCodexCapabilities(input: { target: CapabilityTarget; cwd: string; env?: NodeJS.ProcessEnv }): Promise<CapabilityContribution>;
  codexEnvForTarget?(target: CapabilityTarget): NodeJS.ProcessEnv | undefined;
}
```

Test:

- Session IDs resolve provider, cwd, and label from the authoritative session row.
- Worker IDs resolve provider and use `worktree_path` before `repo_path`.
- Claude workers prefer live `fleet.listCommands(id)` through the injected command reader.
- Codex targets never invoke the Claude command probe.
- Rookery entries are present for both providers, with master-only entries absent from workers.
- Provider failures become diagnostics while Rookery entries remain.
- Unknown IDs throw `unknown capability target: <kind>:<id>`.
- Duplicate stable IDs are de-duplicated deterministically.

### Step 2: Run the service tests and confirm failure

Run: `npx vitest run test/core/capabilities/service.test.ts`

Expected: FAIL because the service does not exist.

### Step 3: Implement the service

Implement `CapabilityService.snapshot(target)` in `src/core/capabilities/service.ts`.

- Resolve target records on the daemon, never trust provider/cwd/label from the desktop.
- Merge Rookery and provider contributions.
- Convert provider exceptions to source-specific diagnostics.
- Stamp one ISO `generatedAt` after collection.
- Sort and de-duplicate entries; sort diagnostics.
- Keep the service read-only.

For a Codex master, `codexEnvForTarget` must prefer its materialized per-session `CODEX_HOME` when it exists, otherwise use the configured shared Codex environment. For workers, use the normal Codex environment because workers do not own per-session master homes.

### Step 4: Add failing protocol tests

Add this client request to the Zod union:

```ts
z.object({
  type: z.literal("capabilities.snapshot"),
  reqId: z.string(),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session"), id: z.string().min(1) }),
    z.object({ kind: z.literal("worker"), id: z.string().min(1) }),
  ]),
})
```

Add the result to `ServerMessage` and `RequestResultMap`. Tests must prove valid session/worker requests parse, invalid kinds/empty IDs reject, and the request map gives the desktop a `CapabilitySnapshot` result.

### Step 5: Add failing connection tests

Inject a narrow `CapabilitySnapshotProvider` into `Connection`, send both target variants, and assert:

- `snapshot(target)` receives exactly the validated target.
- The reply is `capabilities.snapshot.result` with the matching `reqId`.
- Provider exceptions return the existing `error` frame with the same `reqId`.

### Step 6: Implement protocol and daemon routing

In `src/daemon/connection.ts`:

```ts
export interface CapabilitySnapshotProvider {
  snapshot(target: CapabilityTarget): Promise<CapabilitySnapshot>;
}
```

Add the optional constructor dependency and switch case. In `src/daemon/server.ts`:

- Construct `makeCodexCapabilitiesProvider` with the configured Codex spawn/env/API-key resolvers.
- Construct `CapabilityService` after `sessions`, `fleet`, and `commandCatalog` are available.
- For Claude workers use `fleet.listCommands`; otherwise use `commandCatalog.forCwd`.
- Derive the Codex master home from `config.home/codex-homes/<sessionId>` only when it exists.
- Inject the service into every `Connection`.

### Step 7: Run focused tests

Run: `npx vitest run test/core/capabilities test/protocol/messages.test.ts test/daemon/connection.test.ts`

Expected: PASS.

### Step 8: Commit the daemon task

```bash
git add src/core/capabilities/service.ts test/core/capabilities/service.test.ts src/protocol/messages.ts src/daemon/connection.ts src/daemon/server.ts test/protocol/messages.test.ts test/daemon/connection.test.ts
git commit -m "feat: expose effective capability snapshots"
```

---

## Task 4: Build the read-only Effective Capability Center UI

**Files:**

- Create: `apps/desktop/src/renderer/components/CapabilitiesPage.tsx`
- Create: `apps/desktop/test/capabilities-page.test.tsx`
- Create: `apps/desktop/src/renderer/i18n/locales/en/capabilities.ts`
- Create: `apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/index.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/index.ts`
- Modify: `apps/desktop/src/renderer/store/navigation.ts`
- Modify: `apps/desktop/test/navigation.test.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: the existing desktop i18n key/parity tests as required by the locale registry

### Step 1: Write failing component tests

Render `CapabilitiesPage` with injected `loadSnapshot` and test:

1. It loads the selected session or worker target on mount.
2. The title identifies the provider and authoritative cwd.
3. Summary counts and category filters cover Instructions, Skills & Commands, Tools & MCP, Hooks, and Plugins & Apps.
4. Each row shows source, scope, state, and evidence.
5. Diagnostics are visible and do not hide successful entries.
6. Loading, no-target, empty, request-error, and retry states are explicit.
7. Stale responses from a previously selected target cannot overwrite a newer target.
8. The page exposes only the Effective view and has no install/enable/edit controls.

Use an injected loader:

```ts
interface CapabilitiesPageProps {
  target: CapabilityTarget | null;
  loadSnapshot(target: CapabilityTarget): Promise<CapabilitySnapshot>;
  onClose(): void;
}
```

### Step 2: Write the failing navigation test

Update the navigation fixture to accept `overlay: "capabilities"` and prove back/forward history restores it with the active session/worker IDs intact.

### Step 3: Run focused desktop tests and confirm failure

Run: `npm --workspace apps/desktop test -- capabilities-page.test.tsx navigation.test.ts`

Expected: FAIL because the component and overlay do not exist.

### Step 4: Add bilingual strings

Create the `capabilities` namespace in both locale trees and register it in each locale index. Include all titles, target/provider labels, filter labels, scope/state/evidence labels, diagnostics, loading/empty/error/retry text, and accessible names. Do not inline English or Korean strings in the component.

### Step 5: Implement the component

Build an Effective-only page consistent with existing Settings/Automation surfaces:

- Header: Capability Center title, `Effective` badge/tab, target label, provider, cwd, refresh, and close.
- Summary: applied/unavailable/blocked/error counts.
- Category filter row.
- Diagnostic callout list above inventory.
- Grouped capability cards/rows with kind icon, name/detail, provider source, scope, state, and evidence.
- Explicit loading, no target selected, no entries, request failure, and retry states.
- Abort/stale-response protection when target changes.

### Step 6: Wire the top-level overlay

In `store/navigation.ts`, add `"capabilities"` to `Overlay`.

In `App.tsx`:

- Add a top-level Capability Center rail button in both collapsed and expanded sidebars.
- Preserve the active session/worker while opening the overlay.
- Derive target as worker first when Repos/worker is active, otherwise the active session.
- Render `CapabilitiesPage` before daemon-down/content branches.
- Load via `client.request({ type: "capabilities.snapshot", target })`.
- Use the same toggle/close/history behavior as Settings and Automation.

Do not add `/capabilities` dispatch in Slice 1. Slash-command action dispatch belongs to the later command-registry slice; the rail entry is the Slice 1 entry point.

### Step 7: Run focused desktop tests

Run: `npm --workspace apps/desktop test -- capabilities-page.test.tsx navigation.test.ts i18n`

Expected: PASS, including locale key parity and used-key checks.

### Step 8: Commit the desktop task

```bash
git add apps/desktop/src/renderer/components/CapabilitiesPage.tsx apps/desktop/test/capabilities-page.test.tsx apps/desktop/src/renderer/i18n/locales apps/desktop/src/renderer/store/navigation.ts apps/desktop/test/navigation.test.ts apps/desktop/src/renderer/App.tsx apps/desktop/test/i18n
git commit -m "feat: add effective capability center"
```

---

## Task 5: Document, verify, and smoke-test Slice 1 end to end

**Files:**

- Modify: `docs/superpowers/specs/2026-07-13-capability-center-design.md`
- Modify: protocol/reference documentation only if the repository keeps a request catalog outside source
- Verify: all files changed by Tasks 1–4

### Step 1: Reconcile the design document with the shipped contract

Update the design status and any Slice 1 field/method names that changed during implementation. Record the intentional boundary: read-only Effective view now; desired state, bindings, mutations, and slash deep-link action dispatch remain later slices. Do not add aspirational behavior to the shipped checklist.

### Step 2: Run placeholder and whitespace scans

Run:

```bash
rg -n "TODO|TBD|FIXME|placeholder|coming soon|implement later" docs/superpowers/plans/2026-07-13-capability-center-slice-1.md docs/superpowers/specs/2026-07-13-capability-center-design.md src/core/capabilities src/core/codex-capabilities-provider.ts apps/desktop/src/renderer/components/CapabilitiesPage.tsx
git diff --check
```

Expected: no implementation placeholders and no whitespace errors. Contextual prose in the design may describe later slices, but no Slice 1 code path may be a stub.

### Step 3: Run root verification

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

### Step 4: Run desktop verification

Run:

```bash
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop test
npm --workspace apps/desktop run build
```

Expected: PASS.

### Step 5: Run a live daemon protocol smoke test

Start Rookery from this branch using an isolated temporary home/database and an ephemeral port. Through an authenticated WebSocket:

1. Create or identify one Claude session and request its capability snapshot.
2. Create or identify one Codex session rooted at the worktree and request its snapshot.
3. Assert both responses contain Rookery built-ins and authoritative target metadata.
4. Assert the Claude response contains command inventory or an explicit discovery diagnostic.
5. Assert the Codex response contains at least one structured-probe contribution or explicit per-probe diagnostics; no failed probe is silently represented as success.
6. Close the daemon cleanly and verify no child process remains.

If local provider auth is absent, treat explicit auth/probe diagnostics as the expected truthful outcome; do not waive missing Rookery entries or target metadata.

### Step 6: Run a live desktop smoke test

Launch the desktop from this branch, open Capability Center for a selected master and worker, and verify:

- the rail entry opens/closes through navigation history;
- provider, cwd, source, scope, state, and evidence are readable;
- partial diagnostics coexist with successful rows;
- switching selected targets refreshes without stale data;
- the page contains no mutation controls.

Capture any runtime error from the terminal or renderer console and fix it before proceeding.

### Step 7: Audit every Slice 1 acceptance criterion

Use the design document's Slice 1 exit criteria as a checklist. For each criterion, point to a passing automated test or live-smoke observation. If a criterion lacks evidence, add the missing test/fix rather than declaring completion.

### Step 8: Commit documentation and final fixes

```bash
git add docs/superpowers/specs/2026-07-13-capability-center-design.md docs/superpowers/plans/2026-07-13-capability-center-slice-1.md
git add <any-tested-final-fix-files>
git commit -m "docs: finalize capability center slice one"
```

### Step 9: Final branch audit

Run:

```bash
git status --short
git log --oneline --decorate -5
```

Expected: clean worktree, implementation commits present on `feat/capability-center-spec`, and no unrelated user files included.

---

## Execution record

Completed on 2026-07-13.

- Root verification: typecheck, 89 test files / 1,062 tests, and production build passed.
- Desktop verification: typecheck, 130 test files / 1,000 tests, and production build passed.
- Master live smoke: Claude returned 84 entries; Codex returned 55 entries; neither had
  diagnostics.
- Worker live smoke: Claude returned 80 entries and Codex returned 48 entries. Both used
  their authoritative temporary worktree cwd and only `/btw` and `/side` from Rookery.
- The Codex worker's delayed `app/list` returned an explicit per-probe timeout diagnostic;
  successful skills, hooks, MCP, plugins, instructions, and Rookery entries remained
  visible.
- Electron smoke opened the rail entry and rendered the read-only Effective view for the
  selected Codex session. No renderer or terminal runtime error appeared.
- Desired state, bindings, mutation controls, repo/Rookery previews, and slash deep-link
  dispatch remain intentionally out of Slice 1.
