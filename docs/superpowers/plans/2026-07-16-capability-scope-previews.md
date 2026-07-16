# Capability Scope Defaults and Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Rookery-wide capability defaults and safe Effective previews for Rookery and registered repositories alongside existing live session and worker targets.

**Architecture:** Extend the public target union with strict, request-scoped preview targets, then resolve them through the existing precedence resolver using daemon-authoritative repository data. Keep preview projection in `CapabilityService` so runtime inspection, generated homes, invocation actions, and applied-state claims stay impossible. Reuse one renderer scope-binding editor for Rookery and repository settings, and make Capability Center own a local Effective target selection with deep links from both settings surfaces.

**Tech Stack:** Node.js 22, TypeScript, Zod protocol schemas, Vitest, React 18, Electron/Vite, Tailwind CSS, SQLite-backed capability registry.

## Global Constraints

- Preview input accepts only the exact target fields in the design; cwd, origin, home id, worktree, and secret values are rejected.
- Repository paths and labels come only from authoritative registered repository records.
- Rookery previews are scope-only and do not probe provider-native inventory.
- Repository previews may perform read-only provider inventory at the authoritative repository path, using the base Codex environment.
- Preview resolution must not inspect/apply runtime state, materialize generated provider homes, spawn provider conversations or MCP processes, or mutate bindings, trust, or secrets.
- Preview launchable entries stay `desired`, expose no invocation action, and never report an applied revision.
- Common Rookery and repository settings support only UI-origin Master/Worker audiences; custom overlap stays read-only and links to Assignments.
- All new user-visible strings must exist in Korean and English catalogs.
- No database migration or new dependency is allowed.

---

## File structure

- `src/core/capabilities/types.ts`: public live/preview target contracts and nullable preview cwd in snapshots.
- `src/core/capabilities/service.ts`: authoritative target resolution, provider probe policy, and preview-safe state projection.
- `src/protocol/messages.ts`: strict request validation for all four target kinds.
- `src/daemon/server.ts`: authoritative repo metadata and live-only Codex environment wiring.
- `test/core/capabilities/service.test.ts`, `test/protocol/messages.test.ts`, `test/daemon/connection.test.ts`: preview authority and safety regression tests.
- `apps/desktop/src/renderer/components/capabilities/capability-target.ts`: stable target keys, labels, and default preview construction.
- `apps/desktop/src/renderer/components/capabilities/capability-scope-state.ts`: lossless/simple binding-state projection shared by settings surfaces.
- `apps/desktop/src/renderer/components/capabilities/CapabilityScopeBindings.tsx`: common Catalog-backed scope editor.
- `apps/desktop/src/renderer/components/repository-settings/RepositoryCapabilitiesSection.tsx`: repository wrapper and inheritance copy.
- `apps/desktop/src/renderer/components/repository-settings/RepositorySettingsPage.tsx`: repository Effective-preview deep link.
- `apps/desktop/src/renderer/components/SettingsPage.tsx`: Rookery Capabilities tab and deep link.
- `apps/desktop/src/renderer/components/CapabilitiesPage.tsx`: grouped target selector and preview controls.
- `apps/desktop/src/renderer/App.tsx`: local deep-link target routing and settings API wiring.
- `apps/desktop/src/renderer/i18n/locales/{en,ko}/{capabilities,repositorySettings,settings}.ts`: bilingual UI copy.
- Renderer tests beside the existing capability/settings suites: selector, inheritance, mutation, stale response, and navigation coverage.
- `scripts/smoke-capability-scope-previews.mjs`: isolated daemon smoke for scope defaults and non-mutating preview.
- `package.json`, `README.md`, `AGENTS.md`, `docs/reference/protocol.md`, and capability design docs: commands, contracts, and completed-slice status.

---

### Task 1: Core preview target and resolution boundary

**Files:**
- Modify: `src/core/capabilities/types.ts`
- Modify: `src/core/capabilities/service.ts`
- Test: `test/core/capabilities/service.test.ts`

**Interfaces:**
- Consumes: existing `CapabilityResolver.resolve(target: ResolvedCapabilityTarget)` and `rookeryCapabilities({ targetKind })`.
- Produces: `CapabilityLiveTarget`, `CapabilityPreviewTarget`, `CapabilityTarget`, and `CapabilityService.snapshot(target)` behavior for `rookery` and `repo` previews.
- Preserves: `CapabilityService.resolveManaged(target: CapabilityLiveTarget): ResolvedAgentCapabilities` as a live-only runtime port.

- [x] **Step 1: Write failing core tests for Rookery preview safety**

Add a fixture with resolver, provider, runtime, and environment spies and assert the public response and negative calls:

```ts
it("resolves a scope-only rookery preview without probing or touching runtime", async () => {
  const target = { kind: "rookery", provider: "codex", agent: "worker" } as const;
  const snapshot = await service.snapshot(target);

  expect(snapshot.target).toEqual({
    ...target,
    label: "Rookery defaults",
    cwd: null,
  });
  expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
    kind: "worker",
    provider: "codex",
    origin: "ui",
  }));
  expect(listClaudeCommands).not.toHaveBeenCalled();
  expect(listCodexCapabilities).not.toHaveBeenCalled();
  expect(codexEnvForTarget).not.toHaveBeenCalled();
  expect(runtimeState.inspect).not.toHaveBeenCalled();
  expect(snapshot.appliedRevision).toBeUndefined();
  expect(snapshot.entries.every((entry) => !entry.invocation)).toBe(true);
});
```

- [x] **Step 2: Write failing core tests for authoritative repository preview**

Cover registered-id lookup, precedence input, base-environment provider probe, desired projection, and unknown ids:

```ts
it("previews a registered repo at its authoritative path", async () => {
  const target = { kind: "repo", id: "repo-1", provider: "codex", agent: "master" } as const;
  const snapshot = await service.snapshot(target);

  expect(listCodexCapabilities).toHaveBeenCalledWith({ target, cwd: "/repos/one" });
  expect(codexEnvForTarget).not.toHaveBeenCalled();
  expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
    kind: "master",
    repoId: "repo-1",
    cwd: "/repos/one",
    origin: "ui",
  }));
  expect(snapshot.entries.filter((entry) => entry.state === "applied")).toEqual([]);
  expect(runtimeState.inspect).not.toHaveBeenCalled();
});

it("rejects an unknown repo preview instead of accepting a client path", async () => {
  await expect(service.snapshot({ kind: "repo", id: "missing", provider: "claude", agent: "worker" }))
    .rejects.toThrow("unknown capability target: repo:missing");
});
```

- [x] **Step 3: Run the focused tests and verify failure**

Run: `npm test -- test/core/capabilities/service.test.ts`

Expected: FAIL because preview targets are not assignable/resolvable and snapshots require a string cwd.

- [x] **Step 4: Add the live/preview target types and snapshot contract**

Implement the public union exactly:

```ts
export type CapabilityLiveTarget =
  | { kind: "session"; id: string }
  | { kind: "worker"; id: string };

export type CapabilityPreviewTarget =
  | { kind: "rookery"; provider: "claude" | "codex"; agent: "master" | "worker" }
  | { kind: "repo"; id: string; provider: "claude" | "codex"; agent: "master" | "worker" };

export type CapabilityTarget = CapabilityLiveTarget | CapabilityPreviewTarget;
```

Change the enriched snapshot target cwd to `cwd: string | null` and add an optional `name` to `CapabilityRepoRecord` for authoritative labels.

- [x] **Step 5: Implement preview resolution and projection**

Split `resolveTarget` so live targets keep their existing records while preview targets create non-persisted resolver inputs:

```ts
private resolvePreviewTarget(target: CapabilityPreviewTarget): ResolvedTargetView {
  if (target.kind === "rookery") {
    return {
      preview: true,
      label: "Rookery defaults",
      provider: target.provider,
      cwd: null,
      desired: {
        kind: target.agent,
        id: `preview:rookery:${target.provider}:${target.agent}`,
        provider: target.provider,
        origin: "ui",
        cwd: "",
      },
    };
  }
  const repo = this.deps.listRepos?.().find((candidate) => candidate.id === target.id);
  if (!repo) throw new Error(`unknown capability target: repo:${target.id}`);
  return {
    preview: true,
    label: repo.name?.trim() || repo.path,
    provider: target.provider,
    cwd: repo.path,
    desired: {
      kind: target.agent,
      id: `preview:repo:${repo.id}:${target.provider}:${target.agent}`,
      provider: target.provider,
      origin: "ui",
      cwd: repo.path,
      repoId: repo.id,
    },
  };
}
```

For preview snapshots, skip provider discovery only for `rookery`, never call `codexEnvForTarget`, skip `runtimeState.inspect`, map provider/managed launchable entries to `desired`, and remove every invocation. Keep live projection unchanged. Type `resolveManaged` and `codexEnvForTarget` with `CapabilityLiveTarget`.

- [x] **Step 6: Run focused core tests and typecheck**

Run: `npm test -- test/core/capabilities/service.test.ts && npm run typecheck`

Expected: service tests PASS and the typecheck identifies only downstream protocol/renderer exhaustiveness to address in later tasks.

- [x] **Step 7: Commit the core boundary**

```bash
git add src/core/capabilities/types.ts src/core/capabilities/service.ts test/core/capabilities/service.test.ts
git commit -m "feat: add safe capability scope previews"
```

---

### Task 2: Strict protocol and daemon authority

**Files:**
- Modify: `src/protocol/messages.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/protocol/messages.test.ts`
- Modify: `test/daemon/connection.test.ts`
- Modify: `test/core/capabilities/service.test.ts`

**Interfaces:**
- Consumes: `CapabilityTarget` and `CapabilityLiveTarget` from Task 1.
- Produces: strict `capabilities.get.target` validation and daemon-provided `{ id, path, name }` repository records.

- [x] **Step 1: Write failing strict-schema tests**

Add accepted live/preview cases and rejected injected fields:

```ts
expect(parseClientMessage({
  id: "request-1",
  type: "capabilities.get",
  target: { kind: "rookery", provider: "claude", agent: "master" },
}).type).toBe("capabilities.get");

expect(() => parseClientMessage({
  id: "request-2",
  type: "capabilities.get",
  target: { kind: "repo", id: "repo-1", provider: "codex", agent: "worker", cwd: "/tmp/injected" },
})).toThrow();

expect(() => parseClientMessage({
  id: "request-3",
  type: "capabilities.get",
  target: { kind: "rookery", provider: "claude", agent: "master", origin: "slack" },
})).toThrow();
```

- [x] **Step 2: Write failing connection tests for correlated preview responses/errors**

```ts
it("returns a correlated repo preview snapshot", async () => {
  send({ id: "preview-1", type: "capabilities.get", target: {
    kind: "repo", id: "repo-1", provider: "claude", agent: "master",
  }});
  await expect(response("preview-1")).resolves.toMatchObject({
    id: "preview-1",
    type: "capabilities.snapshot",
    snapshot: { target: { kind: "repo", id: "repo-1" } },
  });
});
```

Also assert an unknown repository returns the existing correlated request-error response and does not close the connection.

- [x] **Step 3: Run protocol and connection tests to verify failure**

Run: `npm test -- test/protocol/messages.test.ts test/daemon/connection.test.ts`

Expected: FAIL because the Zod target union contains only session/worker.

- [x] **Step 4: Implement exact strict target schemas**

Use strict discriminated objects:

```ts
const capabilityTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), id: nonEmptyString }).strict(),
  z.object({ kind: z.literal("worker"), id: nonEmptyString }).strict(),
  z.object({
    kind: z.literal("rookery"),
    provider: z.enum(["claude", "codex"]),
    agent: z.enum(["master", "worker"]),
  }).strict(),
  z.object({
    kind: z.literal("repo"),
    id: nonEmptyString,
    provider: z.enum(["claude", "codex"]),
    agent: z.enum(["master", "worker"]),
  }).strict(),
]);
```

Do not add aliases or optional cwd/origin fields.

- [x] **Step 5: Restrict daemon environment lookup to live targets**

Return repository names from the daemon list port and keep Codex target homes live-only:

```ts
listRepos: () => store.listRepos().map((repo) => ({
  id: repo.id,
  path: repo.path,
  name: repo.name,
})),
codexEnvForTarget: (target: CapabilityLiveTarget) => {
  // existing session/worker generated-home lookup remains unchanged
},
```

Repository previews reach `listCodexCapabilities` without the `env` property. Rookery previews never reach either provider list port.

- [x] **Step 6: Run the protocol/daemon/core tests**

Run: `npm test -- test/protocol/messages.test.ts test/daemon/connection.test.ts test/core/capabilities/service.test.ts`

Expected: PASS.

- [x] **Step 7: Commit the public transport boundary**

```bash
git add src/protocol/messages.ts src/daemon/server.ts test/protocol/messages.test.ts test/daemon/connection.test.ts test/core/capabilities/service.test.ts
git commit -m "feat: expose authoritative capability previews"
```

---

### Task 3: Shared scope editor and Rookery defaults settings

**Files:**
- Create: `apps/desktop/src/renderer/components/capabilities/capability-scope-state.ts`
- Create: `apps/desktop/src/renderer/components/capabilities/CapabilityScopeBindings.tsx`
- Modify: `apps/desktop/src/renderer/components/repository-settings/RepositoryCapabilitiesSection.tsx`
- Delete: `apps/desktop/src/renderer/components/repository-settings/repo-capability-state.ts`
- Modify: `apps/desktop/src/renderer/components/SettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/settings.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/settings.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/repositorySettings.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/repositorySettings.ts`
- Test: `apps/desktop/src/renderer/components/repository-settings/repo-capability-state.test.ts`
- Test: `apps/desktop/src/renderer/components/repository-settings/repository-capabilities-section.test.tsx`
- Test: `apps/desktop/src/renderer/components/settings-page.test.tsx`

**Interfaces:**
- Consumes: `CapabilityCenterApi.quickSetBinding(input)` and sanitized `CapabilityLibrarySnapshot.bindings`.
- Produces: `capabilityScopeState(bindings, scopeKind, scopeRef, packInstanceId)`, `CapabilityScopeBindings`, and optional Settings capability props.

- [x] **Step 1: Write failing pure-state tests for both scopes and inheritance**

Define the shared projection contract and cover absent/simple/custom state:

```ts
expect(capabilityScopeState([], "rookery", "", "pack-1")).toEqual({
  mode: "inherit",
  agents: ["master", "worker"],
  custom: false,
});

expect(repositoryCapabilityInheritance(bindings, "pack-1")).toEqual({
  mode: "enabled",
  agents: ["master"],
  custom: false,
});
```

Retain the existing mixed-origin, Side, enabled/disabled overlap, and unrelated-audience expectations so quick editing remains lossless.

- [x] **Step 2: Write failing component tests for Rookery mutation and repo inheritance copy**

Render the shared editor at Rookery scope, choose enabled + Worker, save, and assert:

```ts
expect(api.quickSetBinding).toHaveBeenCalledWith({
  packInstanceId: "pack-1",
  scopeKind: "rookery",
  scopeRef: "",
  mode: "enabled",
  agents: ["worker"],
});
```

At repository scope, verify inherited Rookery enabled/disabled/custom/no-default copy and that direct repo modes say they override the default. Verify custom rows cannot save and open Assignments.

- [x] **Step 3: Run the state/component tests to verify failure**

Run: `npm test --prefix apps/desktop -- src/renderer/components/repository-settings/repo-capability-state.test.ts src/renderer/components/repository-settings/repository-capabilities-section.test.tsx src/renderer/components/settings-page.test.tsx`

Expected: FAIL because only the repository-local component/state exists and Settings has no Capabilities tab.

- [x] **Step 4: Implement the shared state projection**

Move the existing simple/custom algorithm behind a scope-neutral signature:

```ts
export interface CapabilityScopeState {
  mode: CapabilityQuickBindingMode;
  agents: Array<"master" | "worker">;
  custom: boolean;
}

export function capabilityScopeState(
  bindings: CapabilityBinding[],
  scopeKind: "rookery" | "repo-local",
  scopeRef: string,
  packInstanceId: string,
): CapabilityScopeState;

export function repositoryCapabilityInheritance(
  bindings: CapabilityBinding[],
  packInstanceId: string,
): CapabilityScopeState {
  return capabilityScopeState(bindings, "rookery", "", packInstanceId);
}
```

Filter exact scope/ref/pack first, recognize only UI-origin non-empty Master/Worker audiences as simple, and return `custom: true` for overlapping mixed origins, Side audiences, or conflicting enabled/disabled bindings.

- [x] **Step 5: Extract the common Catalog-backed scope editor**

Give the shared component explicit scope-specific copy rather than branching on repository internals:

```ts
export interface CapabilityScopeBindingsProps {
  scopeKind: "rookery" | "repo-local";
  scopeRef: string;
  api: CapabilityCenterApi;
  generation: number;
  title: string;
  description: string;
  inheritLabel: string;
  inheritance(pack: CapabilityLibraryEntry, library: CapabilityLibrarySnapshot, direct: CapabilityScopeState): string | null;
  onOpenCatalog(): void;
  onOpenAdvancedAssignments(): void;
  onPreviewEffective(): void;
}
```

The row calls `quickSetBinding({ packInstanceId, scopeKind, scopeRef, mode, agents })`, keeps search/loading/retry/trust/secret/custom behavior, displays `inheritance(...)`, and exposes Preview Effective next to Assignments.

- [x] **Step 6: Wrap the shared editor for Repository Settings**

Keep `RepositoryCapabilitiesSection` as a thin repo-specific wrapper. Its inheritance formatter uses `repositoryCapabilityInheritance`; direct enabled/disabled reports an override, inherited simple state reports mode and Master/Worker audience, absent reports no default, and inherited custom reports custom with the advanced link.

- [x] **Step 7: Add Rookery Capabilities to Settings**

Extend Settings props without breaking non-capability test fixtures:

```ts
capabilityApi?: CapabilityCenterApi;
capabilityGeneration?: number;
onOpenCapabilityCatalog?: () => void;
onOpenCapabilityAssignments?: () => void;
onPreviewCapabilities?: () => void;
```

When `capabilityApi` is present, render a `capabilities` tab and `CapabilityScopeBindings` with `scopeKind="rookery"`, `scopeRef=""`, “Not set” inherit copy, and the provided navigation callbacks. Hide the ordinary settings save footer while this tab is active.

- [x] **Step 8: Add complete Korean and English copy**

Add matching keys for the Settings tab/title/description/not-set/default explanation, common preview action, repository direct override, inherited enabled/disabled/audience, no default, and inherited custom. Do not inline English-only UI strings except provider brand names.

- [x] **Step 9: Run renderer tests, catalog parity, and typecheck**

Run: `npm test --prefix apps/desktop -- src/renderer/components/repository-settings/repo-capability-state.test.ts src/renderer/components/repository-settings/repository-capabilities-section.test.tsx src/renderer/components/settings-page.test.tsx src/renderer/i18n/catalogs.test.ts src/renderer/i18n/used-keys.test.ts && npm run typecheck --prefix apps/desktop`

Expected: PASS.

- [x] **Step 10: Commit the shared settings surface**

```bash
git add apps/desktop/src/renderer/components/capabilities apps/desktop/src/renderer/components/repository-settings apps/desktop/src/renderer/components/SettingsPage.tsx apps/desktop/src/renderer/i18n
git commit -m "feat: manage rookery capability defaults"
```

---

### Task 4: Effective target selector and settings deep links

**Files:**
- Create: `apps/desktop/src/renderer/components/capabilities/capability-target.ts`
- Modify: `apps/desktop/src/renderer/components/capabilities/types.ts`
- Modify: `apps/desktop/src/renderer/components/CapabilitiesPage.tsx`
- Modify: `apps/desktop/src/renderer/components/repository-settings/RepositorySettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/capabilities.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts`
- Test: `apps/desktop/src/renderer/components/capability-target.test.ts`
- Test: `apps/desktop/src/renderer/components/capabilities-page.test.tsx`
- Test: `apps/desktop/src/renderer/components/repository-settings/repository-settings-page.test.tsx`
- Test: the existing App routing test suite that covers overlays.

**Interfaces:**
- Consumes: Task 1 target union, existing `CapabilityTargetOptions`, and Task 3 preview callbacks.
- Produces: local grouped target selection and `CapabilityPreviewTarget` deep-link overrides in App.

- [x] **Step 1: Write failing helper tests for stable target identity and defaults**

```ts
expect(capabilityTargetKey({ kind: "rookery", provider: "claude", agent: "master" }))
  .toBe("rookery:claude:master");
expect(capabilityTargetKey({ kind: "repo", id: "repo-1", provider: "codex", agent: "worker" }))
  .toBe("repo:repo-1:codex:worker");
expect(defaultCapabilityPreview()).toEqual({ kind: "rookery", provider: "claude", agent: "master" });
```

- [x] **Step 2: Write failing page tests for all target classes and preview hints**

Render repos/sessions/workers, then assert the selector includes Rookery, each repo, session, and worker. Selecting a repo and then Codex + Worker must call:

```ts
expect(api.loadSnapshot).toHaveBeenLastCalledWith({
  kind: "repo",
  id: "repo-1",
  provider: "codex",
  agent: "worker",
});
```

Verify no incoming live target defaults to Rookery · Claude · Master, live target prop changes cancel stale requests, preview headers show Preview, Rookery shows the scope-only explanation, nullable cwd does not render an empty path, and worker reload controls appear only for a live worker.

- [x] **Step 3: Write failing navigation tests for settings deep links**

Click Preview Effective in Repository Settings and Rookery Settings and assert App opens Capability Center with, respectively:

```ts
{ kind: "repo", id: "repo-1", provider: "claude", agent: "master" }
{ kind: "rookery", provider: "claude", agent: "master" }
```

Also assert normal slash-command/capability navigation clears a stale settings preview override and continues to use the active live target.

- [x] **Step 4: Run focused renderer tests to verify failure**

Run: `npm test --prefix apps/desktop -- src/renderer/components/capability-target.test.ts src/renderer/components/capabilities-page.test.tsx src/renderer/components/repository-settings/repository-settings-page.test.tsx`

Expected: FAIL because Capability Center still relies only on the active live target prop.

- [x] **Step 5: Implement target helpers and local selector state**

Provide exhaustive helpers:

```ts
export function defaultCapabilityPreview(): CapabilityPreviewTarget {
  return { kind: "rookery", provider: "claude", agent: "master" };
}

export function capabilityTargetKey(target: CapabilityTarget): string {
  if (target.kind === "session" || target.kind === "worker") return `${target.kind}:${target.id}`;
  if (target.kind === "repo") return `repo:${target.id}:${target.provider}:${target.agent}`;
  return `rookery:${target.provider}:${target.agent}`;
}
```

`CapabilitiesPage` initializes `selectedTarget` from the prop or default preview, synchronizes when the external prop key changes, and performs every load/reload/filter reset against `selectedTarget`. The grouped base selector changes target class/id; provider and agent selects appear only for preview kinds and preserve the selected preview scope.

- [x] **Step 6: Render accurate preview metadata**

Add target badges for Rookery preview, repository preview, live session, and live worker. Show provider and agent for previews, a localized Preview badge, nullable cwd only when present, and a localized scope-only notice for Rookery. Do not display applied-revision-none for previews as if runtime inspection occurred.

- [x] **Step 7: Wire App-local preview deep links**

Add non-persisted state:

```ts
const [capabilityPreviewTarget, setCapabilityPreviewTarget] = useState<CapabilityPreviewTarget | null>(null);
const displayedCapabilityTarget = capabilityPreviewTarget ?? capabilityTarget;
```

Repository Preview sets the repo/Claude/Master target and opens Effective; Rookery Preview sets Rookery/Claude/Master. Catalog, Assignments, slash-command, and ordinary capability open helpers clear the override. Pass capability API/generation/navigation callbacks into Settings and the repo preview callback into Repository Settings.

- [x] **Step 8: Add matching selector and preview copy to both catalogs**

Add keys for target label, Rookery/repository/session/worker groups, provider and agent control labels, Preview badge, and Rookery scope-only notice. Keep key sets identical between Korean and English.

- [x] **Step 9: Run the renderer tests and desktop build**

Run: `npm test --prefix apps/desktop -- src/renderer/components/capability-target.test.ts src/renderer/components/capabilities-page.test.tsx src/renderer/components/repository-settings/repository-settings-page.test.tsx src/renderer/i18n/catalogs.test.ts src/renderer/i18n/used-keys.test.ts && npm run typecheck --prefix apps/desktop && npm run build --prefix apps/desktop`

Expected: PASS.

- [x] **Step 10: Commit Effective navigation**

```bash
git add apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/components/CapabilitiesPage.tsx apps/desktop/src/renderer/components/capabilities apps/desktop/src/renderer/components/repository-settings apps/desktop/src/renderer/i18n
git commit -m "feat: preview effective capabilities by scope"
```

---

### Task 5: Smoke coverage, documentation, and release gates

**Files:**
- Create: `scripts/smoke-capability-scope-previews.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/reference/protocol.md`
- Modify: `docs/superpowers/specs/2026-07-16-capability-scope-previews-design.md`
- Modify: the existing capability-center design status document that lists delivered slices.
- Modify: `docs/superpowers/plans/2026-07-16-capability-scope-previews.md`

**Interfaces:**
- Consumes: public WebSocket protocol and isolated Rookery home conventions used by existing smoke scripts.
- Produces: `npm run smoke:capabilities:slice9` and a verification record for reviewers.

- [x] **Step 1: Write the isolated daemon smoke script**

Following `scripts/smoke-capability-catalog.mjs`, create a temporary Rookery home and repo, start the built daemon on an isolated port, create/trust a generated skill, quick-set a Rookery Master default, and request Rookery Claude Master/Worker previews. Assert:

```js
assert.equal(master.snapshot.target.kind, "rookery");
assert.equal(master.snapshot.target.cwd, null);
assert.equal(master.snapshot.appliedRevision, undefined);
assert(master.snapshot.entries.some((entry) => entry.managed?.packId === packId && entry.state === "desired"));
assert(!master.snapshot.entries.some((entry) => entry.invocation));
assert(!worker.snapshot.entries.some((entry) => entry.managed?.packId === packId));
```

Capture the library before/after both preview calls and deep-equal bindings/trust/secret configured flags. Search daemon output, protocol responses, and generated files for a sentinel secret value and fail if found. Always terminate the child and remove the temporary home in `finally`.

- [x] **Step 2: Add and run the Slice 9 smoke command**

Add:

```json
"smoke:capabilities:slice9": "node scripts/smoke-capability-scope-previews.mjs"
```

Run: `npm run build && npm run smoke:capabilities:slice9`

Expected: exits 0 with a concise success summary and no secret sentinel output.

- [x] **Step 3: Update public and contributor documentation**

Document the target contract and strict fields in `docs/reference/protocol.md`; explain Rookery defaults, repo overrides, Effective previews, scope-only Rookery inventory, and the smoke command in README/AGENTS. Mark the design `implemented` only after all gates pass and add Slice 9 to the delivered-slice status without claiming persistence or provider-native global inventory.

- [x] **Step 4: Run every automated gate**

Run in Node 22:

```bash
npm test
npm run typecheck
npm run build
npm test --prefix apps/desktop
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
npm run smoke:capabilities:slice9
```

Expected: all commands PASS with zero failed tests and zero TypeScript errors.

- [x] **Step 5: Perform an isolated Electron visual smoke**

Launch the branch with an isolated Rookery home/daemon port. Verify in both Korean and English: Settings > Capabilities default editing, Catalog/Assignments links, Rookery preview default, all grouped selector options, Claude/Codex and Master/Worker hint changes, repo inherited/default/override copy, repo Preview Effective deep link, live worker reload controls, and no renderer/daemon errors. Stop only the isolated branch app and daemon.

- [x] **Step 6: Record verification and commit docs/smoke**

Check completed plan boxes, append exact test counts and smoke result, then commit:

```bash
git add scripts/smoke-capability-scope-previews.mjs package.json README.md AGENTS.md docs
git commit -m "docs: complete capability scope previews"
```

- [x] **Step 7: Final worktree audit**

Run: `git status --short && git log --oneline --decorate -8`

Expected: clean worktree and a reviewable sequence of Slice 9 commits on `feat/capability-scope-previews`.

---

## Verification record

Completed on 2026-07-16 with Node 22:

- Root Vitest: 101 files, 1,206 tests passed.
- Desktop Vitest: 140 files, 1,061 tests passed. Existing React `act()` and jsdom
  canvas warnings remained non-failing.
- Root and desktop TypeScript typechecks passed.
- Root TypeScript build and desktop Electron/Vite production build passed.
- `npm run smoke:capabilities:slice9` passed through an isolated production daemon
  and WebSocket, including strict target rejection, Rookery Master/Worker audience
  projection, non-materialization, unchanged Library state, and secret boundaries.
- An isolated Electron app on its own Rookery home and daemon/debug ports verified
  English and Korean Rookery settings, Catalog-backed default editing, Rookery and
  repository Effective previews, Claude/Codex and Master/Worker changes, repository
  inheritance copy and deep linking, and grouped preview/live-session targets. The
  renderer test suite covers live-worker selection and reload-only-on-live behavior.
  No renderer/daemon runtime error was observed; Vite emitted only its existing
  missing Monaco source-map development warning. The isolated app and daemon were stopped.

## Self-review

- Spec coverage: Tasks 1–2 cover strict preview inputs, authoritative repositories, resolver precedence, provider-probe policy, runtime/home/secret safety, and unchanged live behavior. Tasks 3–4 cover Rookery defaults, shared lossless mutation, repository inheritance, selector UX, and deep links. Task 5 covers protocol/docs, bilingual catalogs, isolated daemon/Electron smoke, and full gates.
- Placeholder scan: the plan contains no deferred implementation markers or unspecified error-handling steps; each test/implementation action has concrete assertions, interfaces, commands, and expected results.
- Type consistency: preview targets consistently use `provider` plus `agent`; live targets retain `id`; only snapshot-enriched cwd is nullable; `resolveManaged` and generated Codex environment ports accept only `CapabilityLiveTarget`; shared scope mutation uses the existing `CapabilityQuickBindingInput` names.
