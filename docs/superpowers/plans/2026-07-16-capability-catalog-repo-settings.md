# Capability Catalog and Repository Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use task-list syntax for tracking.

**Goal:** Ship Slice 8: lightweight single-MCP and Skill registration, a capability-first Catalog, and an extensible full-page Repository Settings surface for repo-local bindings.

**Architecture:** Keep packs as the existing trust/runtime unit by generating singleton packs for simple MCP and Skill entries. Add one transactional quick-binding operation for the common repo-local/UI audience, then project packs into catalog rows in the renderer. Route Repository Settings as a repository-keyed full-page location with a section registry so future repo policy pages extend the shell rather than replace it.

**Tech Stack:** TypeScript NodeNext, Zod protocol schemas, better-sqlite3 transactions, React 18, Zustand navigation, Tailwind CSS, Vitest/jsdom.

## Global Constraints

- Use Node 22 / ABI 127 for every build and test command.
- Never modify the user's `~/.claude` or `~/.codex` configuration.
- Never serialize secret values into protocol results, events, logs, generated public manifests, child argv, or renderer state.
- Preserve exact-digest trust and keep newly generated catalog entries untrusted until review.
- New renderer strings must exist with identical key sets in Korean and English.
- Relative NodeNext imports include `.js`; type-only imports use `import type`.
- Do not render dead future Repository Settings sections; extend through the section registry later.

---

### Task 1: Generated singleton MCP and Skill services

**Files:**
- Modify: `src/core/capabilities/types.ts`
- Modify: `src/daemon/generated-capability-pack-store.ts`
- Modify: `src/core/capabilities/service.ts`
- Test: `test/daemon/generated-capability-pack-store.test.ts`
- Test: `test/core/capabilities/service.test.ts`

**Interfaces:**
- Consumes: existing `McpServerSpec`, `CapabilityPackManifest`, `CapabilityRegistry`, and `GeneratedCapabilityPackStore.create/remove`.
- Produces: `CapabilityMcpCreateInput`, `CapabilitySkillCreateInput`, `CapabilityCatalogCreateResult`, `GeneratedCapabilityPackPort.createSkill()`, `CapabilityService.createMcp()` and `CapabilityService.createSkill()`.

- [x] **Step 1: Add failing generated Skill store tests**

Add cases that create a temporary Skill directory with valid frontmatter, verify the final
generated pack contains `capability.json` plus `skill/SKILL.md`, verify modes are private,
and assert an escaping symlink or invalid Skill leaves neither staging nor final output.

- [x] **Step 2: Run the focused store test and confirm failure**

Run: `npx vitest run test/daemon/generated-capability-pack-store.test.ts`

Expected: FAIL because `createSkill` does not exist.

- [x] **Step 3: Implement singleton types and safe Skill staging**

Add these public inputs:

```ts
export interface CapabilityMcpCreateInput {
  id: string;
  displayName: string;
  description: string;
  mcpServer: McpServerSpec;
  secretValues?: Record<string, string>;
}

export interface CapabilitySkillCreateInput {
  id: string;
  displayName: string;
  description: string;
  sourcePath: string;
}

export interface CapabilityCatalogCreateResult {
  pack: CapabilityLibraryEntry;
}
```

Extend the generated store with:

```ts
createSkill(manifest: CapabilityPackManifest, sourcePath: string): string;
```

Copy into staging with `dereference: false`, validate the staged pack through
`validateCapabilityPack`, apply the same `0700` directory and `0600` manifest policy as
MCP generation, then atomically rename.

- [x] **Step 4: Add failing service lifecycle tests**

Cover MCP and Skill creation without a binding, write-only secret configuration,
untrusted result projection, generated-store rollback, registry rollback, and source-path
validation failures.

- [x] **Step 5: Implement service creation and rollback**

Implement:

```ts
createMcp(input: CapabilityMcpCreateInput): CapabilityCatalogCreateResult;
createSkill(input: CapabilitySkillCreateInput): CapabilityCatalogCreateResult;
```

Both methods create schema-version-1 singleton manifests at version `1.0.0`, register as
`rookery-generated`, store only declared secret values, create no binding, and remove both
registry state and owned files on any failure.

- [x] **Step 6: Run focused root tests**

Run:

```bash
npx vitest run test/daemon/generated-capability-pack-store.test.ts
npx vitest run test/core/capabilities/service.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit the service slice**

```bash
git add src/core/capabilities/types.ts src/daemon/generated-capability-pack-store.ts test/daemon/generated-capability-pack-store.test.ts src/core/capabilities/service.ts test/core/capabilities/service.test.ts
git commit -m "feat: add lightweight capability registration"
```

### Task 2: Transactional quick assignment and protocol

**Files:**
- Modify: `src/core/capabilities/types.ts`
- Modify: `src/persistence/repositories.ts`
- Modify: `src/core/capabilities/registry.ts`
- Modify: `src/core/capabilities/service.ts`
- Modify: `src/protocol/messages.ts`
- Modify: `src/daemon/connection.ts`
- Test: `test/persistence/repositories.test.ts`
- Test: `test/core/capabilities/registry.test.ts`
- Test: `test/core/capabilities/service.test.ts`
- Test: `test/protocol/messages.test.ts`
- Test: `test/daemon/connection.test.ts`

**Interfaces:**
- Consumes: existing binding scope authority and audience-overlap rules.
- Produces: `CapabilityQuickBindingInput`, `CapabilityQuickBindingMode`, `Repositories.replaceCapabilityUiBinding()`, `CapabilityRegistry.quickSetBinding()`, and three correlated protocol requests.

- [x] **Step 1: Write failing repository transaction tests**

Cover canonical replacement of multiple UI-only master/worker bindings, inherit deletion,
enabled/disabled creation, preservation of Slack-only peers, and rejection of a mixed
UI+Slack or Side binding without changing any rows.

- [x] **Step 2: Run repository tests and confirm failure**

Run: `npx vitest run test/persistence/repositories.test.ts -t "quick capability binding"`

Expected: FAIL because `replaceCapabilityUiBinding` does not exist.

- [x] **Step 3: Implement the transactional repository primitive**

Add:

```ts
export type CapabilityQuickBindingMode = "inherit" | "enabled" | "disabled";

export interface CapabilityQuickBindingInput {
  packInstanceId: string;
  scopeKind: "rookery" | "repo-local";
  scopeRef: string;
  mode: CapabilityQuickBindingMode;
  agents: Array<"master" | "worker">;
}
```

`replaceCapabilityUiBinding(id, input)` must preflight custom overlaps, then use one
`this.db.transaction()` to delete simple peers and optionally insert a canonical
`origins:["ui"]` binding.

- [x] **Step 4: Add registry/service authority tests**

Verify unknown packs/repos are rejected, Rookery requires an empty ref, repo-local requires
an authoritative repo id, no event is emitted on custom conflict, and successful changes
emit the exact affected scope.

- [x] **Step 5: Implement registry and service quick binding**

Use the registry id generator for the replacement id and return `CapabilityBinding | null`.
Do not expose persistence directly to the connection.

- [x] **Step 6: Add protocol and connection tests**

Add strict schemas and correlated secret-safe responses for:

```ts
{ type: "capabilities.mcp.create", reqId, input }
{ type: "capabilities.skill.create", reqId, input }
{ type: "capabilities.binding.quickSet", reqId, input }
```

Expected results carry only sanitized `pack` and `binding` projections.

- [x] **Step 7: Implement protocol routing**

Decode all three inputs strictly, call the service, and reply with
`capabilities.catalog.create.result` or `capabilities.binding.quickSet.result` using the
original `reqId`.

- [x] **Step 8: Run focused protocol/core tests**

Run:

```bash
npx vitest run test/persistence/repositories.test.ts test/core/capabilities/registry.test.ts test/core/capabilities/service.test.ts test/protocol/messages.test.ts test/daemon/connection.test.ts
```

Expected: PASS.

- [x] **Step 9: Commit protocol and assignment**

```bash
git add src/core/capabilities/types.ts src/persistence/repositories.ts src/core/capabilities/registry.ts src/core/capabilities/service.ts src/protocol/messages.ts src/daemon/connection.ts test/persistence/repositories.test.ts test/core/capabilities/registry.test.ts test/core/capabilities/service.test.ts test/protocol/messages.test.ts test/daemon/connection.test.ts
git commit -m "feat: add repository capability quick assignments"
```

### Task 3: Capability-first Catalog UI

**Files:**
- Create: `apps/desktop/src/renderer/components/capabilities/catalog.ts`
- Create: `apps/desktop/src/renderer/components/capabilities/McpCapabilityDialog.tsx`
- Create: `apps/desktop/src/renderer/components/capabilities/SkillImportDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/capabilities/CapabilityLibraryTab.tsx`
- Modify: `apps/desktop/src/renderer/components/capabilities/types.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/capabilities.ts`
- Create: `apps/desktop/src/renderer/i18n/locales/ko/capabilityCatalog.ts`
- Create: `apps/desktop/src/renderer/i18n/locales/en/capabilityCatalog.ts`
- Test: `apps/desktop/test/capability-catalog.test.ts`
- Test: `apps/desktop/test/capability-library-tab.test.tsx`

**Interfaces:**
- Consumes: Task 1/2 protocol methods through `CapabilityCenterApi`.
- Produces: `catalogKind(pack)`, single-MCP and Skill dialogs, and a capability-first Catalog list while preserving pack review controls.

- [x] **Step 1: Write failing catalog projection tests**

Assert one-MCP manifests map to `mcp`, one-Skill manifests map to `skill`, and instruction,
empty, or multi-item manifests map to `bundle`, with deterministic search text.

- [x] **Step 2: Implement catalog projection helpers**

Export:

```ts
export type CapabilityCatalogKind = "mcp" | "skill" | "bundle";
export function catalogKind(pack: CapabilityLibraryEntry): CapabilityCatalogKind;
export function catalogSearchText(pack: CapabilityLibraryEntry): string;
```

- [x] **Step 3: Write failing dialog and Catalog component tests**

Cover strict stdio/HTTP draft compilation, password fields never repopulating, MCP create
without repos, Skill directory selection/import, cancel/retry preservation, kind filters,
and the highlighted review-before-trust handoff.

- [x] **Step 4: Implement lightweight dialogs and API adapters**

`McpCapabilityDialog` reuses the existing MCP draft compiler for exactly one server and
submits `CapabilityMcpCreateInput`. `SkillImportDialog` obtains a directory through
`pickDirectory`, validates non-empty id/name/path fields client-side, and submits
`CapabilitySkillCreateInput`.

- [x] **Step 5: Refactor Library into Catalog presentation**

Relabel the tab and heading as Catalog, add MCP/Skill/Bundle filter controls and search,
render kind badges, keep `PackCard` review/trust/secret/source controls, and retain
Build MCP Pack plus Import Pack as advanced actions.

- [x] **Step 6: Run focused desktop tests**

Run:

```bash
npm -w apps/desktop test -- capability-catalog.test.ts capability-library-tab.test.tsx
```

Expected: PASS.

- [x] **Step 7: Commit the Catalog UI**

```bash
git add apps/desktop/src/renderer/components/capabilities apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/i18n/locales apps/desktop/test/capability-catalog.test.ts apps/desktop/test/capability-library-tab.test.tsx
git commit -m "feat: add capability catalog registration flows"
```

### Task 4: Repository-keyed full-page navigation shell

**Files:**
- Modify: `apps/desktop/src/renderer/store/navigation.ts`
- Modify: `apps/desktop/src/renderer/store/store.ts`
- Modify: `apps/desktop/src/renderer/lib/view-state.ts`
- Modify: `apps/desktop/src/renderer/views/RepoTree.tsx`
- Create: `apps/desktop/src/renderer/components/repository-settings/RepositorySettingsPage.tsx`
- Create: `apps/desktop/src/renderer/components/repository-settings/sections.ts`
- Create: `apps/desktop/src/renderer/i18n/locales/ko/repositorySettings.ts`
- Create: `apps/desktop/src/renderer/i18n/locales/en/repositorySettings.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Test: `apps/desktop/test/navigation.test.ts`
- Test: `apps/desktop/test/repo-tree.test.tsx`
- Create: `apps/desktop/test/repository-settings-page.test.tsx`

**Interfaces:**
- Consumes: authoritative `Store.repos` rows.
- Produces: `Overlay:"repoSettings"`, `Location.repoId`, `onRepoSettings(repoId)`, and an extensible full-page section registry.

- [x] **Step 1: Write failing navigation tests**

Cover repository id in equality, navigate/back/forward/reset, opening without changing the
active session/worker axes, and rejection of a stale restored repo id.

- [x] **Step 2: Implement repository-keyed location state**

Extend the location shape:

```ts
export type Overlay = "settings" | "newSession" | "automation" | "capabilities" | "repoSettings" | null;

export interface Location {
  overlay: Overlay;
  showRepos: boolean;
  sessionId: string | null;
  subId: string | null;
  repoId: string | null;
}
```

Update all location constructors, restore validation, and App navigation calls so unrelated
navigation clears stale `repoId` while back/forward restores it.

- [x] **Step 3: Write failing RepoTree affordance tests**

Assert each registered repo header exposes one localized settings button, clicking passes
the authoritative repo id, the click does not fold the group or spawn a worker, and orphan
groups have no settings affordance.

- [x] **Step 4: Implement RepoTree settings entry**

Add `onRepoSettings(id: string)` and render a `Settings2` button beside the existing spawn
and remove actions. Change the local Repo type to carry `id` separately from `name`.

- [x] **Step 5: Write and implement the full-page shell tests**

Verify the repository name/path header, Capabilities section registry, selected-section
styling, close callback, and absence of dead Worktrees/Hooks/Branches entries.

- [x] **Step 6: Implement the page and section registry**

Define:

```ts
export type RepositorySettingsSectionId = "capabilities";
export const repositorySettingsSections: readonly RepositorySettingsSection[];
```

The page uses a full-height two-column layout: fixed settings navigation and a scrollable
section body.

- [x] **Step 7: Run navigation/shell tests**

Run:

```bash
npm -w apps/desktop test -- navigation.test.ts repo-tree.test.tsx repository-settings-page.test.tsx
```

Expected: PASS.

- [x] **Step 8: Commit the Repository Settings shell**

```bash
git add apps/desktop/src/renderer/store apps/desktop/src/renderer/lib/view-state.ts apps/desktop/src/renderer/views/RepoTree.tsx apps/desktop/src/renderer/components/repository-settings apps/desktop/src/renderer/i18n/locales apps/desktop/src/renderer/App.tsx apps/desktop/test/navigation.test.ts apps/desktop/test/repo-tree.test.tsx apps/desktop/test/repository-settings-page.test.tsx
git commit -m "feat: add full-page repository settings"
```

### Task 5: Repository Capabilities section

**Files:**
- Create: `apps/desktop/src/renderer/components/repository-settings/repo-capability-state.ts`
- Create: `apps/desktop/src/renderer/components/repository-settings/RepositoryCapabilitiesSection.tsx`
- Modify: `apps/desktop/src/renderer/components/repository-settings/RepositorySettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/components/capabilities/types.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/repositorySettings.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/repositorySettings.ts`
- Create: `apps/desktop/test/repo-capability-state.test.ts`
- Create: `apps/desktop/test/repository-capabilities-section.test.tsx`

**Interfaces:**
- Consumes: sanitized Library snapshot, `catalogKind`, and `CapabilityCenterApi.quickSetBinding`.
- Produces: deterministic direct/custom assignment projection and the full repository catalog binding UI.

- [x] **Step 1: Write failing assignment projection tests**

Cover no direct override (`inherit`), one/multiple simple enabled bindings, disabled
tombstones, mixed enabled state (`custom`), mixed-origin/Side custom overlap, unrelated
repo/global binding exclusion, and master/worker audience union.

- [x] **Step 2: Implement pure assignment projection**

Export:

```ts
export type RepoCapabilityMode = CapabilityQuickBindingMode | "custom";
export interface RepoCapabilityAssignmentState {
  mode: RepoCapabilityMode;
  agents: Array<"master" | "worker">;
  bindingIds: string[];
}
export function repoCapabilityState(bindings: CapabilityBinding[], packInstanceId: string, repoId: string): RepoCapabilityAssignmentState;
```

- [x] **Step 3: Write failing section interaction tests**

Cover load/empty/error/retry, searchable MCP/Skill/Bundle rows, trust and secret status,
inherit/enabled/disabled mode changes, master/worker selection, per-row pending/error,
custom state lockout, and advanced Assignments navigation.

- [x] **Step 4: Implement the Repository Capabilities section**

Load on mount and capability generation changes. Submit exact quick inputs:

```ts
{
  packInstanceId: pack.instanceId,
  scopeKind: "repo-local",
  scopeRef: repo.id,
  mode,
  agents,
}
```

Refresh from the correlated result/event, keep secret values out of component state, and
show that running workers adopt changes through the existing pending-reload flow.

- [x] **Step 5: Wire Repository Settings and advanced deep link**

Pass the same memoized `CapabilityCenterApi` used by Capability Center. The advanced link
sets the Capability Center route to Assignments before navigating away from Repository
Settings.

- [x] **Step 6: Run focused section tests**

Run:

```bash
npm -w apps/desktop test -- repo-capability-state.test.ts repository-capabilities-section.test.tsx repository-settings-page.test.tsx
```

Expected: PASS.

- [x] **Step 7: Commit repo capability binding UI**

```bash
git add apps/desktop/src/renderer/components/repository-settings apps/desktop/src/renderer/components/capabilities/types.ts apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/i18n/locales apps/desktop/test/repo-capability-state.test.ts apps/desktop/test/repository-capabilities-section.test.tsx apps/desktop/test/repository-settings-page.test.tsx
git commit -m "feat: bind catalog capabilities in repository settings"
```

### Task 6: Documentation, regression gates, and live smoke

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-capability-center-design.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/reference/protocol.md`
- Modify: `docs/reference/data-model.md`
- Modify: `docs/superpowers/plans/2026-07-16-capability-catalog-repo-settings.md`

**Interfaces:**
- Consumes: all Slice 8 behavior.
- Produces: current architecture documentation and completion evidence.

- [x] **Step 1: Update evergreen and slice documentation**

Mark Slice 8 implemented only after verification. Document singleton generated packs,
quick-binding custom-conflict rules, new protocol messages, no schema migration, and the
Repository Settings extension point.

- [x] **Step 2: Run root gates under Node 22**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: typecheck PASS, all root test files/tests PASS, build exits 0.

- [x] **Step 3: Run desktop gates**

Run:

```bash
npm -w apps/desktop run typecheck
npm -w apps/desktop test
npm -w apps/desktop run build
```

Expected: typecheck PASS, all desktop test files/tests PASS, Electron Vite build exits 0.

- [x] **Step 4: Run a daemon lifecycle smoke**

Use an isolated `ROOKERY_HOME` and temp Skill fixture. Create one MCP and one Skill through
the WebSocket protocol, assert neither has a binding, trust them, quick-enable both for a
registered repo, quick-disable one, inherit it again, and scan every response/generated
file/log for sentinel secret values.

Expected: all lifecycle assertions PASS and the isolated home is removed.

- [x] **Step 5: Run an Electron visual smoke**

Launch the branch app, verify Catalog registration controls, repo header settings button,
full-page Repository Settings shell, capability rows, all three modes, Korean/English
layout, close/back navigation, and no renderer/daemon error.

- [x] **Step 6: Self-review plan/spec coverage and mark checkboxes**

Compare all eight acceptance criteria in
`docs/superpowers/specs/2026-07-16-capability-catalog-repo-settings-design.md` against source,
tests, and live outputs. Mark every completed plan checkbox and leave none checked without
authoritative evidence.

- [x] **Step 7: Commit docs and verification record**

```bash
git add AGENTS.md README.md docs
git commit -m "docs: document capability catalog and repository settings"
```

## Verification record

Completed on 2026-07-16 with Node 22:

- root typecheck and build passed;
- root suite passed: 101 files, 1,202 tests;
- desktop typecheck and Electron Vite build passed;
- desktop suite passed: 139 files, 1,056 tests;
- `npm run smoke:capabilities:slice8` passed against an isolated production daemon and
  WebSocket, including MCP/Skill creation, initial unbound/untrusted state, trust,
  enable/disable/inherit transitions, cleanup, and sentinel-secret scanning;
- isolated Electron dev smoke passed for English and Korean Catalog/Repository Settings
  layouts, repository settings entry and close navigation, singleton MCP/Skill rows,
  all three assignment modes, Master/Worker controls, and clean renderer/daemon logs.

All eight Slice 8 acceptance criteria in the design specification were compared against
the implementation, focused coverage, full suites, and live outputs before this plan was
marked complete.
