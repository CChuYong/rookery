# Modal Explicit Dismissal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent draft-bearing desktop dialogs from losing user input through Escape, and keep the Worker Spawn dialog open until the daemon confirms that the spawn succeeded.

**Architecture:** Make the shared modal-key hook require an explicit Escape policy. Draft-bearing forms choose `ignore`, while confirmation-only dialogs retain `close`; a small topmost-modal registry ensures only the newest active dialog handles global modal shortcuts. Worker spawning becomes an awaitable renderer contract so dismissal follows the `fleet.spawn` acknowledgement instead of the click.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Electron renderer.

---

### Task 1: Encode explicit modal keyboard policy

**Files:**
- Modify: `apps/desktop/src/renderer/lib/useModalKeys.ts`
- Create: `apps/desktop/test/use-modal-keys.test.tsx`

- [x] Add tests proving `escape: "ignore"` consumes Escape without closing, `escape: "close"` calls the close callback, Cmd/Ctrl+Enter submits, and only the topmost mounted modal handles a shortcut.
- [x] Replace the positional hook API with a discriminated options type that requires every caller to choose an Escape policy.
- [x] Keep callbacks fresh without re-registering listeners, and unregister the shared window listener when no modal hooks remain.
- [x] Run `npm -w apps/desktop test -- use-modal-keys.test.tsx`.

### Task 2: Protect form drafts while preserving confirmation behavior

**Files:**
- Modify: `apps/desktop/src/renderer/components/WorkerSpawnModal.tsx`
- Modify: `apps/desktop/src/renderer/components/RepoModal.tsx`
- Modify: `apps/desktop/src/renderer/components/ForkDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/RunAutomationDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/FileTree.tsx`
- Modify: `apps/desktop/src/renderer/components/capabilities/SkillImportDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/capabilities/McpPackBuilderDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/OnboardingModal.tsx`
- Modify: `apps/desktop/src/renderer/components/RestartDaemonDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/SettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/ui/confirm-dialog.tsx`
- Modify: `apps/desktop/test/spawn-modal.test.tsx`
- Modify: `apps/desktop/test/repo-modal.test.tsx`
- Modify: `apps/desktop/test/fork-dialog.test.tsx`
- Modify: `apps/desktop/test/run-automation-dialog.test.tsx`
- Modify: `apps/desktop/test/file-tree.test.tsx`
- Modify: `apps/desktop/test/mcp-pack-builder-dialog.test.tsx`
- Modify: `apps/desktop/test/rookery-tab.test.tsx`

- [x] Update all shared-hook callers to choose `ignore` for draft-bearing forms and `close` for confirmation/onboarding flows.
- [x] Add or adjust component regressions proving Escape leaves representative form values and dialogs intact, while explicit Cancel still closes through the exit transition.
- [x] Preserve nested UI semantics such as Escape closing only the Worker Spawn source-results dropdown.
- [x] Run the affected desktop test files.

### Task 3: Dismiss Worker Spawn only after daemon success

**Files:**
- Modify: `apps/desktop/src/renderer/components/WorkerSpawnModal.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/test/spawn-modal.test.tsx`

- [x] Change `onSpawn` to an awaitable callback, guard duplicate submissions, and show the existing button loading state.
- [x] Await `fleet.spawn`; on failure show the existing toast, rethrow to the modal, and retain every field. Treat the post-spawn fleet refresh as best-effort so a refresh failure cannot invite a duplicate spawn.
- [x] Add tests for pending, rejected, and resolved spawn promises, including preserved prompt text after failure.
- [x] Run the Worker Spawn tests.

### Task 4: Full verification and review

**Files:**
- Review: all files above

- [x] Run `npm -w apps/desktop run typecheck`.
- [x] Run `npm -w apps/desktop test`.
- [x] Run `npm -w apps/desktop run build`.
- [x] Inspect `git diff --check`, the final diff, and worktree status for unrelated changes.
