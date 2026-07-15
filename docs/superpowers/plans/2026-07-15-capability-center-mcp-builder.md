# Capability Center MCP Pack Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create a multi-server MCP capability pack in Capability Center, save its write-only secrets, and bind it to a registered repository without hand-writing `capability.json`.

**Architecture:** The renderer owns an accessible draft editor and compiles it into one strict provider-neutral request. The daemon writes only a public `capability.json` into a Rookery-owned directory through an injected filesystem port, validates and registers it through the existing registry, stores secret values through the existing write-only boundary, and creates an untrusted repo-local binding. Existing digest review remains mandatory before the pack can execute.

**Tech Stack:** TypeScript, Node 22, Zod, React 18, Zustand-connected WebSocket client, Vitest, Testing Library, Electron/Vite.

## Global Constraints

- Use Node 22 / ABI 127 for every install, typecheck, test, build, daemon, and Electron command.
- The renderer may runtime-import only types through `@daemon/*`; all data mutations travel over the authenticated WebSocket.
- Generated packs live only under `<ROOKERY_HOME>/capability-packs/`; directories are `0700`, `capability.json` is `0600`, and creation uses staging plus atomic rename.
- Secret values may appear only in the authenticated create request and daemon-only registry setter; they never enter the generated manifest, response, event, diagnostic, log, argv, or rendered text.
- Creation never auto-trusts a digest. The resulting card stays `untrusted`, is already bound to the selected repo, and requires the existing expand/review/trust action before runtime use.
- The first UI slice creates packs but does not edit them. A user can delete and recreate a generated pack; deletion also removes its Rookery-owned directory.
- The builder supports multiple stdio and streamable-HTTP servers, public environment/header pairs, secret environment/header pairs, HTTP bearer auth, argument boundaries, tool allow/deny lists, optional cwd, and `required`.
- Side remains excluded from generated MCP audiences. The builder offers master and worker only and fixes the request origin to UI; broader audiences remain editable in Assignments.
- All new renderer copy exists in matching Korean/English catalogs with identical keys.

---

### Task 1: Domain contract and strict protocol schema

**Files:**
- Modify: `src/core/capabilities/types.ts`
- Modify: `src/protocol/messages.ts`
- Modify: `test/protocol/messages.test.ts`

**Interfaces:**
- Produces: `CapabilityMcpPackCreateInput` and `CapabilityMcpPackCreateResult`.
- Produces: client message `capabilities.mcpPack.create` and server message `capabilities.mcpPack.result`.
- Consumes: the existing `McpServerSpec`, `CapabilityLibraryEntry`, and `CapabilityBinding` shapes.

- [ ] **Step 1: Write failing protocol tests for a multi-server request.**

Add a valid request containing one stdio server, one HTTP server, two write-only secret values, one repository id, and `agents:["master","worker"]`. Assert parsing preserves argument boundaries and secret refs. Add invalid fixtures proving an empty server list, duplicate/invalid ids, an empty secret value, a non-HTTP URL, a missing stdio command, and `agents:["side"]` are rejected.

```ts
const parsed = clientMessageSchema.parse({
  type: "capabilities.mcpPack.create",
  reqId: "q1",
  input: {
    id: "repo-tools",
    displayName: "Repo Tools",
    version: "1.0.0",
    description: "Repository MCP servers",
    repoId: "repo-1",
    agents: ["master", "worker"],
    mcpServers: [
      { id: "db", transport: "stdio", command: "npx", args: ["-y", "db-mcp"], secretEnv: { TOKEN: { source: "rookery-secret", key: "db-token" } } },
      { id: "docs", transport: "streamable-http", url: "https://example.test/mcp", auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } } },
    ],
    secretValues: { "db-token": "db-value", "docs-token": "docs-value" },
  },
});
expect(parsed.input.mcpServers[0]?.args).toEqual(["-y", "db-mcp"]);
```

- [ ] **Step 2: Run the protocol test and verify it fails.**

Run: `npx vitest run test/protocol/messages.test.ts`

Expected: FAIL because `capabilities.mcpPack.create` is not in the discriminated union.

- [ ] **Step 3: Add the domain types and strict Zod request.**

Add these exact domain shapes:

```ts
export interface CapabilityMcpPackCreateInput {
  id: string;
  displayName: string;
  version: string;
  description: string;
  repoId: string;
  agents: Array<"master" | "worker">;
  mcpServers: McpServerSpec[];
  secretValues?: Record<string, string>;
}

export interface CapabilityMcpPackCreateResult {
  pack: CapabilityLibraryEntry;
  binding: CapabilityBinding;
}
```

In `messages.ts`, define strict secret-ref, common MCP, stdio MCP, HTTP MCP, and create-input schemas with the same limits as `manifest.ts`. Refine the create input so MCP ids are unique case-insensitively and every `secretValues` key is declared by a `rookery-secret` ref. Add the request/result mappings without defining any response field that can hold secret values.

- [ ] **Step 4: Run focused tests and root typecheck.**

Run: `npx vitest run test/protocol/messages.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the public contract.**

```bash
git add src/core/capabilities/types.ts src/protocol/messages.ts test/protocol/messages.test.ts
git commit -m "feat: define generated mcp pack requests"
```

### Task 2: Rookery-owned generated pack filesystem

**Files:**
- Create: `src/daemon/generated-capability-pack-store.ts`
- Create: `test/daemon/generated-capability-pack-store.test.ts`

**Interfaces:**
- Produces: `GeneratedCapabilityPackStore.create(manifest: CapabilityPackManifest): string`.
- Produces: `GeneratedCapabilityPackStore.remove(sourcePath: string): void`.
- Consumes: the existing `validateCapabilityPack()` validator before a staged directory becomes authoritative.

- [ ] **Step 1: Write failing store tests.**

Cover: a valid MCP-only manifest becomes `<root>/<id>-<uuid>/capability.json`; root/pack/file modes are `0700/0700/0600` on POSIX; creation validates before rename; invalid manifests leave no staging directory; two identical logical ids get separate paths; removal deletes only a direct child; outside paths, nested descendants, and replacement symlinks are rejected or unlinked without following them.

```ts
const store = new GeneratedCapabilityPackStore(path.join(home, "capability-packs"), { id: () => "one" });
const created = store.create({
  schemaVersion: 1,
  id: "repo-tools",
  displayName: "Repo Tools",
  version: "1.0.0",
  description: "MCPs",
  mcpServers: [{ id: "docs", transport: "streamable-http", url: "https://example.test/mcp" }],
});
expect(JSON.parse(fs.readFileSync(path.join(created, "capability.json"), "utf8"))).not.toHaveProperty("secretValues");
```

- [ ] **Step 2: Run the store test and verify the missing module failure.**

Run: `npx vitest run test/daemon/generated-capability-pack-store.test.ts`

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement staging, validation, atomic rename, and contained cleanup.**

The constructor canonicalizes the generated root after creating and hardening it. `create()` uses `fs.mkdtempSync(path.join(root, ".staging-"))`, writes formatted JSON with mode `0600`, runs `validateCapabilityPack(staging)`, and renames to `<manifest.id>-<id()>`. Any error recursively removes staging. `remove()` accepts only a direct child of the canonical root; a symlink is unlinked and a real directory is recursively removed.

- [ ] **Step 4: Run focused tests and root typecheck.**

Run: `npx vitest run test/daemon/generated-capability-pack-store.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the owned filesystem boundary.**

```bash
git add src/daemon/generated-capability-pack-store.ts test/daemon/generated-capability-pack-store.test.ts
git commit -m "feat: materialize generated capability packs"
```

### Task 3: Atomic-enough create, secret, binding, and rollback orchestration

**Files:**
- Modify: `src/core/capabilities/service.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/core/capabilities/service.test.ts`
- Modify: `test/daemon/server.test.ts`

**Interfaces:**
- Consumes: an injected `generatedPacks` port with `create()` and `remove()`.
- Produces: `CapabilityService.createMcpPack(input): CapabilityMcpPackCreateResult`.
- Changes: `CapabilityService.removePack()` deletes the owned source only for `sourceKind:"rookery-generated"`.

- [ ] **Step 1: Write failing service tests.**

Assert successful creation: writes an MCP-only manifest, registers `sourceKind:"rookery-generated"`, stores each declared non-empty secret, creates one enabled `repo-local` binding with agents from input and origins `["ui"]`, returns only configured booleans, and remains untrusted. Assert failures in registration, undeclared secret storage, or binding authority remove the registry row and generated path. Assert removal cleans generated paths but never calls the generated-store remover for local-directory or repo-shared packs.

```ts
const result = service.createMcpPack(input);
expect(result.pack).toMatchObject({ sourceKind: "rookery-generated", status: "untrusted" });
expect(result.binding).toMatchObject({ scopeKind: "repo-local", scopeRef: "repo-1", audience: { agents: ["master", "worker"], origins: ["ui"] } });
expect(JSON.stringify(result)).not.toContain("actual-secret-value");
```

- [ ] **Step 2: Run focused tests and verify the service has no create method.**

Run: `npx vitest run test/core/capabilities/service.test.ts test/daemon/server.test.ts`

Expected: FAIL on missing `createMcpPack` and missing composition.

- [ ] **Step 3: Add the injected port and orchestration.**

Define the port beside `CapabilityServiceDeps`:

```ts
export interface GeneratedCapabilityPackPort {
  create(manifest: CapabilityPackManifest): string;
  remove(sourcePath: string): void;
}
```

`createMcpPack()` creates the public manifest, registers it, sets supplied secrets only through `registry.setSecret`, and creates a UUID binding. On any failure it removes an added registry row and the generated source without masking the original error. `startDaemon()` injects `new GeneratedCapabilityPackStore(path.join(config.home, "capability-packs"))`.

- [ ] **Step 4: Run focused tests and typecheck.**

Run: `npx vitest run test/core/capabilities/service.test.ts test/daemon/server.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the service transaction boundary.**

```bash
git add src/core/capabilities/service.ts src/daemon/server.ts test/core/capabilities/service.test.ts test/daemon/server.test.ts
git commit -m "feat: create repo mcp capability packs"
```

### Task 4: WebSocket routing and secret-safe response

**Files:**
- Modify: `src/daemon/connection.ts`
- Modify: `test/daemon/connection.test.ts`
- Modify: `docs/reference/protocol.md`

**Interfaces:**
- Consumes: `CapabilityProvider.createMcpPack(input)`.
- Produces: correlated `capabilities.mcpPack.result {pack,binding}`.

- [ ] **Step 1: Write a failing connection test.**

Send a create request containing the sentinel `uniquely-sensitive-mcp-secret`, assert the provider receives it, assert the correlated result contains the sanitized pack and binding, and assert every serialized server message/event omits the sentinel. Add an error case proving validation/service failures return a correlated error and no echo of the request body.

- [ ] **Step 2: Run the connection test and verify no route exists.**

Run: `npx vitest run test/daemon/connection.test.ts`

Expected: FAIL because the request is not routed.

- [ ] **Step 3: Add the provider method, route, result, and protocol documentation.**

Extend `CapabilityProvider`, dispatch `msg.input` directly to the service, and return only its sanitized result. Document the create input, automatic repo-local/UI binding, untrusted result, write-only request values, and generated source cleanup.

- [ ] **Step 4: Run focused tests and root gates.**

Run: `npx vitest run test/protocol/messages.test.ts test/daemon/connection.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the transport boundary.**

```bash
git add src/daemon/connection.ts test/daemon/connection.test.ts docs/reference/protocol.md
git commit -m "feat: expose mcp pack creation"
```

### Task 5: Pure renderer draft compiler

**Files:**
- Create: `apps/desktop/src/renderer/lib/mcp-pack-draft.ts`
- Create: `apps/desktop/test/mcp-pack-draft.test.ts`

**Interfaces:**
- Produces: `createEmptyMcpServerDraft(transport)` and `compileMcpPackDraft(draft)`.
- Consumes: UI-only draft rows and emits one `CapabilityMcpPackCreateInput` with no empty optional fields.

- [ ] **Step 1: Write failing draft compiler tests.**

Cover id slugging, display-name-to-id behavior, multiple transports, newline-preserved stdio args, comma/newline tool lists, public key/value rows, secret target/key/value rows, HTTP bearer auth, secret deduplication, omitted blank fields, duplicate MCP ids, duplicate public/secret target keys, missing repo/agents/server endpoint, and partial secret rows.

```ts
const result = compileMcpPackDraft(draft);
expect(result).toEqual({
  ok: true,
  input: expect.objectContaining({
    repoId: "repo-1",
    mcpServers: expect.arrayContaining([
      expect.objectContaining({ id: "db", command: "npx", args: ["-y", "db-mcp"] }),
    ]),
    secretValues: { "db-token": "actual-secret-value" },
  }),
});
```

- [ ] **Step 2: Run the draft test and verify the missing module failure.**

Run: `npm -w apps/desktop test -- --run test/mcp-pack-draft.test.ts`

Expected: FAIL because the compiler module does not exist.

- [ ] **Step 3: Implement typed drafts and deterministic compilation.**

Return `{ok:true,input}` or `{ok:false,issues:Array<{code:string;serverIndex?:number}>}` rather than throwing. Trim identifiers/keys/endpoints, preserve each non-empty args line as one argument, dedupe tool names, reject key collisions, and collect secret values in the top-level write-only map while placing only refs in each server spec.

- [ ] **Step 4: Run draft tests and desktop typecheck.**

Run: `npm -w apps/desktop test -- --run test/mcp-pack-draft.test.ts && npm -w apps/desktop run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the UI compiler.**

```bash
git add apps/desktop/src/renderer/lib/mcp-pack-draft.ts apps/desktop/test/mcp-pack-draft.test.ts
git commit -m "feat: compile mcp pack drafts"
```

### Task 6: Multi-server MCP pack builder dialog

**Files:**
- Create: `apps/desktop/src/renderer/components/capabilities/McpPackBuilderDialog.tsx`
- Create: `apps/desktop/test/mcp-pack-builder-dialog.test.tsx`
- Create: `apps/desktop/src/renderer/i18n/locales/ko/mcpPackBuilder.ts`
- Create: `apps/desktop/src/renderer/i18n/locales/en/mcpPackBuilder.ts`

**Interfaces:**
- Consumes: registered repository options and `CapabilityCenterApi.createMcpPack(input)`.
- Produces: `onCreated(result)` only after the daemon confirms pack, secrets, and binding.

- [ ] **Step 1: Write failing interaction tests.**

Assert the dialog: selects a repo; auto-generates an editable id from display name; starts with one HTTP server; adds/removes/switches multiple server cards; edits HTTP URL/bearer/header fields and stdio command/args/env fields; masks secret values; shows localized validation issues; disables double-submit; calls create with the compiled input; preserves the form on rejection; closes and emits the result on success; closes on Escape; and never renders a secret value as text.

- [ ] **Step 2: Run the dialog test and verify the component is absent.**

Run: `npm -w apps/desktop test -- --run test/mcp-pack-builder-dialog.test.tsx`

Expected: FAIL because the dialog module does not exist.

- [ ] **Step 3: Implement the accessible dialog and reusable row editors.**

Use the existing `Input`, `Select`, `Textarea`, `Button`, `useFocusTrap`, `useDismissTransition`, and `useModalKeys` primitives. Keep all secret inputs `type="password" autocomplete="new-password"`. Render public and secret key/value rows inside each server card, a `required` checkbox, tool allow/deny inputs, repo/agent selection, and an explicit message that the generated pack remains blocked until digest review.

- [ ] **Step 4: Add Korean/English copy and run i18n gates.**

Run: `npm -w apps/desktop test -- --run test/mcp-pack-builder-dialog.test.tsx test/i18n/catalog.test.ts test/i18n/used-keys.test.ts && npm -w apps/desktop run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the builder dialog.**

```bash
git add apps/desktop/src/renderer/components/capabilities/McpPackBuilderDialog.tsx apps/desktop/test/mcp-pack-builder-dialog.test.tsx apps/desktop/src/renderer/i18n/locales/ko/mcpPackBuilder.ts apps/desktop/src/renderer/i18n/locales/en/mcpPackBuilder.ts
git commit -m "feat: add mcp pack builder dialog"
```

### Task 7: Library integration and generated-pack handoff

**Files:**
- Modify: `apps/desktop/src/renderer/components/capabilities/types.ts`
- Modify: `apps/desktop/src/renderer/components/capabilities/CapabilityLibraryTab.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/capabilities.ts`
- Modify: `apps/desktop/test/capability-library-tab.test.tsx`

**Interfaces:**
- Consumes: `capabilities.mcpPack.create` through `CapabilityCenterApi.createMcpPack`.
- Produces: the Library `MCP pack 만들기` entry point and a visible post-create review/trust handoff.

- [ ] **Step 1: Write failing Library integration tests.**

Assert the new button opens the dialog with authoritative repo options; zero repos shows a register-repo hint and disables creation; success reloads the Library, highlights the returned generated pack, reports that its repo binding and secrets are saved, and tells the user to expand/review/trust; cancellation and create failure do not mutate Library state. Existing directory-add, refresh, trust, secret, and remove tests must remain green.

- [ ] **Step 2: Run focused tests and verify the entry point is absent.**

Run: `npm -w apps/desktop test -- --run test/capability-library-tab.test.tsx test/mcp-pack-builder-dialog.test.tsx`

Expected: FAIL on missing create button/API method.

- [ ] **Step 3: Wire the API and Library state.**

Add `createMcpPack(input): Promise<CapabilityMcpPackCreateResult>` to `CapabilityCenterApi`. App sends the new request. `CapabilityLibraryTab` receives `repos`, owns dialog open state and `createdInstanceId`, reloads after success, and adds a success callout above the highlighted card. Pass `targets.repos` from `CapabilitiesPage`.

- [ ] **Step 4: Run all focused desktop tests and typecheck.**

Run: `npm -w apps/desktop test -- --run test/capability-library-tab.test.tsx test/mcp-pack-builder-dialog.test.tsx test/capabilities-page.test.tsx && npm -w apps/desktop run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the end-to-end desktop flow.**

```bash
git add apps/desktop/src/renderer/components/capabilities/types.ts apps/desktop/src/renderer/components/capabilities/CapabilityLibraryTab.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts apps/desktop/src/renderer/i18n/locales/en/capabilities.ts apps/desktop/test/capability-library-tab.test.tsx
git commit -m "feat: create repo mcp packs from library"
```

### Task 8: Evergreen docs, complete verification, and isolated smoke

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-07-13-capability-center-design.md`
- Modify: `docs/reference/protocol.md` if verification finds drift from Task 4.

**Interfaces:**
- Documents: exact create/review/trust lifecycle, repo-local binding, write-only secret handling, and create-only limitation.

- [ ] **Step 1: Update evergreen and accepted-design documentation.**

Document the Library builder, supported stdio/HTTP fields, generated location, automatic repo-local/UI binding, mandatory digest review, runtime application timing, generated cleanup, and that generated-pack editing is not in this slice.

- [ ] **Step 2: Run every required gate under Node 22.**

```bash
npm run typecheck
npm test
npm run build
npm -w apps/desktop run typecheck
npm -w apps/desktop test
npm -w apps/desktop run build
```

Expected: all root and desktop tests pass; both typechecks and both builds succeed.

- [ ] **Step 3: Run an isolated generated-pack smoke.**

Use a temporary `ROOKERY_HOME`, in-memory/test repository data, and the real `GeneratedCapabilityPackStore` plus registry/service. Create two harmless MCP declarations with sentinel secret values, verify the generated manifest contains refs but no values, verify the returned result contains only configured booleans, trust the exact digest, resolve the repo target, and remove the pack. Assert the generated directory is gone and no sentinel exists in logs, responses, events, or generated files.

- [ ] **Step 4: Audit the actual exit criteria.**

Run `git diff --check`; confirm the worktree has no generated artifacts; inspect protocol fixtures for strict validation; inspect every response/event for secret absence; inspect removal containment tests; inspect the dialog with Korean and English catalogs; and verify existing local-directory/repo-shared pack behavior is unchanged.

- [ ] **Step 5: Commit docs and verification updates.**

```bash
git add README.md AGENTS.md docs/superpowers/specs/2026-07-13-capability-center-design.md docs/reference/protocol.md
git commit -m "docs: explain generated mcp packs"
```

## Self-Review

- Spec coverage: Tasks 1–4 cover strict public contract, owned file creation, repo binding, secrets, rollback, removal, and transport. Tasks 5–7 cover every promised UI field, multiple servers, repo selection, failure handling, localization, and trust handoff. Task 8 covers docs, regression gates, and the secret-safe lifecycle smoke.
- Scope discipline: generated-pack editing, automatic trust, Side MCP, arbitrary origins, marketplace installation, and repo-shared file generation are explicitly excluded.
- Placeholder scan: no implementation step relies on TBD/TODO or an unnamed error-handling task.
- Type consistency: `CapabilityMcpPackCreateInput`, `CapabilityMcpPackCreateResult`, `createMcpPack`, `GeneratedCapabilityPackStore.create/remove`, and `CapabilityCenterApi.createMcpPack` use the same names across all tasks.
