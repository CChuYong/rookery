# Capability Center Slice 6 Command Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace string-only slash suggestions with context-safe command actions, Capability Center deep links, and provider-lowered managed-skill invocation.

**Architecture:** A new transport-neutral command-action registry under `src/core/capabilities/` projects only invocable snapshot entries plus Rookery client actions into structured candidates. The daemon resolves existing session/worker targets authoritatively and sends candidates over the existing `commands.list` request; the desktop executes the attached action instead of guessing from display text. Capability Center accepts an initial tab/kind route so slash actions can open an exact filtered view.

**Tech Stack:** TypeScript, Zod, Vitest, React 18, Zustand, Electron WebSocket protocol, Tailwind CSS.

## Global Constraints

- Use Node 22 for every install, typecheck, build, and test command.
- Core capability modules must not import WebSocket, Electron, Slack, or renderer code.
- `commands.list` must derive existing session/worker context from authoritative daemon rows; a client may not spoof provider or cwd for an existing target.
- Slash preview must contain only actions or skills executable in the selected context.
- Managed Claude skill invocation lowers to `/<skill>`; managed Codex skill invocation lowers to `$<skill>`.
- Provider TUI-only inventory without an SDK/app-server invocation is never projected into composer candidates.
- `/capabilities`, `/skills`, `/hooks`, and `/mcp` open Capability Center; `/btw` and `/side` use the same action registry.
- New user-facing desktop copy must have matching Korean and English catalog keys.
- No secret value, skill body, or instruction body may enter command candidates, protocol events, logs, or tests.

---

### Task 1: Provider-neutral command action registry

**Files:**
- Create: `src/core/capabilities/commands.ts`
- Create: `test/core/capabilities/commands.test.ts`
- Modify: `src/core/capabilities/types.ts`
- Modify: `src/core/capabilities/builtins.ts`
- Modify: `test/core/capabilities/builtins.test.ts`

**Interfaces:**
- Consumes: `CapabilitySnapshot`, `CapabilityEntry`, `CapabilityKind`, and the target provider/kind already present on snapshots.
- Produces: `CommandAction`, `CommandCandidate`, `rookeryCommandEntries(targetKind)`, and `commandCandidates(snapshot)`.

- [ ] **Step 1: Write failing registry tests.**

Cover all six Rookery actions, deterministic ordering/deduplication, client-action metadata, Claude `/<skill>` lowering, Codex `$<skill>` lowering, omission of blocked/pending-reload/non-invocable entries, and built-in-name precedence over a colliding provider entry. Assert candidates contain only identifiers, display metadata, and structured actions.

- [ ] **Step 2: Run the tests and verify the missing module/type failures.**

Run: `PATH="$HOME/.nvm/versions/node/v22.*/bin:$PATH" npx vitest run test/core/capabilities/commands.test.ts test/core/capabilities/builtins.test.ts`

Expected: FAIL because `src/core/capabilities/commands.ts`, `CommandAction`, and `CommandCandidate` do not exist.

- [ ] **Step 3: Add the canonical action/candidate contracts and pure projection.**

Use these exact public shapes:

```ts
export type CommandAction =
  | { type: "insert-prompt"; text: string }
  | { type: "open-capability-center"; tab?: "effective" | "assignments" | "library"; kind?: CapabilityKind }
  | { type: "open-panel"; panel: "side" | "btw" }
  | { type: "daemon-request"; method: string }
  | { type: "provider-request"; provider: "claude" | "codex"; method: string };

export interface CommandCandidate {
  id: string;
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  action: CommandAction;
}
```

Add the optional inventory metadata from the accepted spec:

```ts
invocation?: {
  type: "prompt" | "client-action" | "daemon-action" | "provider-action" | "tool";
  name?: string;
};
```

The registry owns the six Rookery definitions. `rookeryCapabilities()` reuses their inventory entries instead of maintaining a second list. `commandCandidates()` accepts only entries with explicit invocation metadata, maps prompt invocation to `insert-prompt`, maps built-in ids to their exact client actions, drops name collisions after higher-priority built-ins/native entries win, and sorts by normalized name then id.

- [ ] **Step 4: Run focused tests and typecheck.**

Run: `npx vitest run test/core/capabilities/commands.test.ts test/core/capabilities/builtins.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the core registry.**

```bash
git add src/core/capabilities/commands.ts src/core/capabilities/types.ts src/core/capabilities/builtins.ts test/core/capabilities/commands.test.ts test/core/capabilities/builtins.test.ts
git commit -m "feat: register capability command actions"
```

### Task 2: Truthful provider and managed-skill invocability

**Files:**
- Modify: `src/core/capabilities/service.ts`
- Modify: `src/core/capabilities/builtins.ts`
- Modify: `src/core/codex-capabilities-provider.ts`
- Modify: `test/core/capabilities/service.test.ts`
- Modify: `test/core/capabilities/builtins.test.ts`
- Modify: `test/core/codex-capabilities-provider.test.ts`

**Interfaces:**
- Consumes: runtime-projected `CapabilityEntry.state`, target kind/provider, and provider structured inventory.
- Produces: `CapabilityEntry.invocation` only when that exact snapshot entry can execute now or on the submitted master turn.

- [ ] **Step 1: Write failing invocability tests.**

Assert Claude `supportedCommands()` entries carry prompt invocation; enabled Codex `skills/list` entries carry `$name` prompt invocation while disabled ones do not; a managed master skill is invocable when applied or pending-next-turn; a managed worker skill is invocable only when applied; desired-without-runtime, pending-reload, blocked, unavailable, suppressed, and error entries have no invocation.

- [ ] **Step 2: Run focused tests and verify missing invocation metadata.**

Run: `npx vitest run test/core/capabilities/builtins.test.ts test/core/capabilities/service.test.ts test/core/codex-capabilities-provider.test.ts`

Expected: FAIL on the new invocation assertions.

- [ ] **Step 3: Project invocation at authoritative boundaries.**

`claudeCommandCapabilities()` adds `{ type: "prompt", name: "/<normalized>" }`. `mapSkillsResponse()` adds `{ type: "prompt", name: "$<name>" }` only for enabled skills. `CapabilityService.projectRuntimeEntries()` receives the resolved target and adds provider-lowered prompt invocation to managed skills only after final runtime state is known; it never marks MCP, instructions, suppressed entries, or stale workers invocable.

- [ ] **Step 4: Run focused tests and root typecheck.**

Run: `npx vitest run test/core/capabilities/builtins.test.ts test/core/capabilities/service.test.ts test/core/codex-capabilities-provider.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit truthful invocation projection.**

```bash
git add src/core/capabilities/service.ts src/core/capabilities/builtins.ts src/core/codex-capabilities-provider.ts test/core/capabilities/service.test.ts test/core/capabilities/builtins.test.ts test/core/codex-capabilities-provider.test.ts
git commit -m "feat: project invocable capability skills"
```

### Task 3: Authoritative command candidate protocol

**Files:**
- Modify: `src/protocol/messages.ts`
- Modify: `src/daemon/connection.ts`
- Modify: `test/protocol/messages.test.ts`
- Modify: `test/daemon/connection.test.ts`
- Modify: `docs/reference/protocol.md`

**Interfaces:**
- Consumes: `CapabilitySnapshotProvider.snapshot(target)` and `commandCandidates(snapshot)` for existing contexts; `CommandProvider.forCwd(cwd)` only for a not-yet-created Claude session.
- Produces: `commands.result.commands: CommandCandidate[]`; `commands.list` accepts optional `sessionId` in addition to `workerId` and cold `cwd`/`provider` hints.

- [ ] **Step 1: Write failing protocol and connection tests.**

Prove: `sessionId` parses; worker/session ids select authoritative capability snapshots; client cwd/provider hints cannot override an existing target; unknown ids fail; Codex cold preview does not run a Claude probe; cold Claude preview maps supported commands only to `insert-prompt`; and no inventory entry without invocation becomes a candidate.

- [ ] **Step 2: Run focused tests and verify the old string-only response fails.**

Run: `npx vitest run test/protocol/messages.test.ts test/daemon/connection.test.ts`

Expected: FAIL because `commands.list` lacks `sessionId` and the response lacks structured actions.

- [ ] **Step 3: Route command discovery through the action registry.**

Reject requests containing both `sessionId` and `workerId`. For either existing target, call `capabilities.snapshot()` once and project it. For cold previews, preserve the current cwd/default-cwd Claude probe but wrap each returned command in an explicit `insert-prompt` action; return no Codex cold candidates. Update the protocol reference table and request notes.

- [ ] **Step 4: Run focused tests and root typecheck.**

Run: `npx vitest run test/protocol/messages.test.ts test/daemon/connection.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the protocol boundary.**

```bash
git add src/protocol/messages.ts src/daemon/connection.ts test/protocol/messages.test.ts test/daemon/connection.test.ts docs/reference/protocol.md
git commit -m "feat: serve contextual command actions"
```

### Task 4: Execute actions in the shared desktop composer

**Files:**
- Modify: `apps/desktop/src/renderer/components/PromptEditor.tsx`
- Modify: `apps/desktop/src/renderer/components/Composer.tsx`
- Modify: `apps/desktop/src/renderer/components/ConversationPane.tsx`
- Modify: `apps/desktop/src/renderer/views/Conversation.tsx`
- Modify: `apps/desktop/src/renderer/store/store.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/test/prompt-editor.test.tsx`
- Modify: `apps/desktop/test/composer-draft.test.tsx`
- Modify: `apps/desktop/test/conversation-pane.test.tsx`
- Modify: `apps/desktop/test/store-reduce.test.ts`

**Interfaces:**
- Consumes: `CommandCandidate.action` from the daemon.
- Produces: `onCommandAction(action, argument?)`; insert actions edit the prompt, zero-argument client actions execute on selection or submit, and panel actions collect/validate a question before opening Side.

- [ ] **Step 1: Write failing editor/composer/pane tests.**

Assert: managed skill selection inserts exactly the provider-lowered action text; selecting `/skills` executes its client action and clears the slash token without sending a prompt; typing `/mcp` then Enter executes the same action; `/side <question>` and `/btw <question>` dispatch their registry action; empty panel arguments do nothing; unknown manual text still sends normally; and `ConversationPane` no longer synthesizes local side candidates.

- [ ] **Step 2: Run desktop focused tests and verify old hard-coded behavior fails.**

Run: `npm -w apps/desktop test -- --run test/prompt-editor.test.tsx test/composer-draft.test.tsx test/conversation-pane.test.tsx test/store-reduce.test.ts`

Expected: FAIL because candidates have no action callback and Side parsing is hard-coded.

- [ ] **Step 3: Implement generic selection and submit dispatch.**

Use `CommandCandidate` as the renderer `SlashCommand` type. `PromptEditor` inserts only `insert-prompt.text`; argument-taking actions insert their display command for continued typing; zero-argument actions call `onCommandAction` immediately. `Composer` matches an exact leading slash name/alias against the provided candidates, dispatches non-prompt actions with the remaining argument, and removes `parseSideCommand`. `ConversationPane` handles `open-panel` by calling its existing Side lifecycle and forwards all other actions to App.

- [ ] **Step 4: Refresh structured candidates after context, capability, or provider command changes.**

App sends `sessionId` or `workerId` on `commands.list`, includes `capabilityGeneration` in the refresh effect, and re-requests the authoritative list on `commands.changed`. The Zustand store must not replace structured candidates with the event's legacy raw provider strings. Automation surfaces receive only `insert-prompt` candidates because they cannot perform navigation or open Side.

- [ ] **Step 5: Run focused desktop tests and desktop typecheck.**

Run: `npm -w apps/desktop test -- --run test/prompt-editor.test.tsx test/composer-draft.test.tsx test/conversation-pane.test.tsx test/store-reduce.test.ts && npm -w apps/desktop run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit generic desktop action execution.**

```bash
git add apps/desktop/src/renderer/components/PromptEditor.tsx apps/desktop/src/renderer/components/Composer.tsx apps/desktop/src/renderer/components/ConversationPane.tsx apps/desktop/src/renderer/views/Conversation.tsx apps/desktop/src/renderer/store/store.ts apps/desktop/src/renderer/App.tsx apps/desktop/test/prompt-editor.test.tsx apps/desktop/test/composer-draft.test.tsx apps/desktop/test/conversation-pane.test.tsx apps/desktop/test/store-reduce.test.ts
git commit -m "feat: execute command actions in chat"
```

### Task 5: Capability Center deep links, documentation, and complete verification

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/CapabilitiesPage.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/composer.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/composer.ts`
- Modify: `apps/desktop/test/capabilities-page.test.tsx`
- Modify: `apps/desktop/test/app.test.tsx`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-07-13-capability-center-design.md`

**Interfaces:**
- Consumes: `open-capability-center` actions carrying `tab` and optional exact `CapabilityKind`.
- Produces: route state passed as `initialTab`/`initialKind`, exact effective-entry filtering for `/skills`, `/hooks`, and `/mcp`, and localized built-in candidate descriptions.

- [ ] **Step 1: Write failing deep-link tests.**

Assert `/capabilities` opens Effective/all, `/skills` opens Effective with only `kind:"skill"`, `/hooks` only hooks, and `/mcp` only MCP entries. Assert changing the target clears an ordinary manual filter but preserves a newly supplied deep-link route. Add App-level proof that the command callback navigates to the overlay and passes the route.

- [ ] **Step 2: Run focused desktop tests and verify initial route props are absent.**

Run: `npm -w apps/desktop test -- --run test/capabilities-page.test.tsx test/app.test.tsx`

Expected: FAIL because Capability Center has no initial tab/kind route.

- [ ] **Step 3: Add exact-kind deep-link state and localized descriptions.**

App stores the last requested Center route immediately before `navigate({ overlay: "capabilities" })`. `CapabilitiesPage` initializes/resets `tab` and an optional exact-kind filter from props; clicking a category clears exact-kind mode. Map the six Rookery command ids to existing Side copy or new `composer.commandCapabilities`, `composer.commandSkills`, `composer.commandHooks`, and `composer.commandMcp` keys in both catalogs.

- [ ] **Step 4: Update evergreen and accepted-design documentation.**

Document the structured registry, authoritative target lookup, managed skill lowering (`/name` Claude, `$name` Codex), exact Center deep links, and invocable-only rule. Mark Slice 6 implemented and update the implementation-status paragraph and remaining-slices wording without claiming management of provider-native TUI commands.

- [ ] **Step 5: Run the complete required gates.**

Run from the repository root with Node 22:

```bash
npm run typecheck
npm test
npm run build
npm -w apps/desktop run typecheck
npm -w apps/desktop test
```

Expected: all root and desktop tests pass, both typechecks pass, and the root build succeeds.

- [ ] **Step 6: Audit the actual Slice 6 exit criteria.**

Inspect the final protocol response and tests to prove every candidate has an action; inspect managed Claude/Codex skill candidates to prove provider lowering; inspect blocked/pending-reload/TUI-only fixtures to prove omission; inspect `/btw` and `/side` to prove no component-local command list remains; inspect each deep link to prove its exact Center filter; run `git diff --check` and confirm the worktree contains no unrelated changes.

- [ ] **Step 7: Commit docs and verification changes.**

```bash
git add apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/components/CapabilitiesPage.tsx apps/desktop/src/renderer/i18n/locales/ko/composer.ts apps/desktop/src/renderer/i18n/locales/en/composer.ts apps/desktop/test/capabilities-page.test.tsx apps/desktop/test/app.test.tsx README.md AGENTS.md docs/superpowers/specs/2026-07-13-capability-center-design.md
git commit -m "docs: finish capability command actions"
```

## Self-Review

- Spec coverage: all four Slice 6 bullets map to Tasks 1–5; the exit criterion is explicitly audited in Task 5.
- Placeholder scan: every mutation names its contract, files, command, and expected result with no deferred fill-ins.
- Type consistency: `CommandCandidate` is the single daemon/protocol/renderer candidate shape; `CommandAction` is shared end-to-end; `CapabilityEntry.invocation` remains inventory metadata and is not conflated with client execution.
- Scope boundary: daemon/provider action variants are defined for registry completeness but no unsupported action is advertised; only `insert-prompt`, `open-capability-center`, and `open-panel` are emitted in this slice.
