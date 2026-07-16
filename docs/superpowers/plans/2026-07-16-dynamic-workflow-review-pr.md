# Dynamic Workflow Review and PR Implementation Plan

> **For agentic workers:** Execute inline in the current workspace. Do not delegate; repository instructions reserve this review for the primary agent.

**Goal:** Review the complete Dynamic Workflow Activity change set, correct any material findings, and publish a focused pull request with verified evidence.

**Architecture:** Treat `origin/main...working-tree` as one feature slice spanning Claude decoding, daemon observation/protocol, and Electron rendering. Review each trust boundary and lifecycle independently, then run the complete Node 22 verification matrix before committing only Workflow-related files and creating the PR.

**Tech Stack:** TypeScript, Claude Agent SDK raw messages, Node 22, Vitest, Electron/React/Zustand, GitHub CLI.

## Global Constraints

- Preserve unrelated user changes and exclude them from the commit.
- Do not publish if a correctness, security, lifecycle, reconnect, or localization finding remains open.
- Keep raw paths, prompts, results, scripts, logs, and previews out of CoreEvents and WebSocket payloads.
- Dynamic Workflow activity must remain separate from `worker.nested` and must not drive Worker state.
- Use the existing full Node 22 typecheck/test/build gates for root and desktop.

---

### Task 1: Establish the PR boundary and review the complete diff

**Files:**

- Review: all paths from `git diff --name-status origin/main...HEAD` plus the current working tree
- Exclude: any file not attributable to Dynamic Workflow Activity

- [x] Inspect branch ancestry, existing PR state, and commits relative to `origin/main`.
- [x] Map every changed/untracked file to the Workflow feature or exclude it.
- [x] Review provider decoding, parser bounds/privacy, path containment, watcher/drain races, protocol ownership, reconnect reducers, UI grouping, inline tool state, i18n, and cleanup.
- [x] Run targeted tests for any suspected edge and fix findings with regression coverage.

### Task 2: Run release-quality verification

**Files:**

- Verify: root TypeScript/tests/build
- Verify: `apps/desktop` TypeScript/tests/build

- [x] Run `nvm exec 22 npm run typecheck` and `nvm exec 22 npm -w apps/desktop run typecheck`; expect exit 0.
- [x] Run `nvm exec 22 npm test` and `nvm exec 22 npm -w apps/desktop test`; expect all suites pass.
- [x] Run `nvm exec 22 npm run build` and `nvm exec 22 npm -w apps/desktop run build`; expect exit 0.
- [x] Run `git diff --check`; expect no output.

### Task 3: Publish the focused PR

**Files:**

- Stage: only reviewed Workflow feature source, tests, docs, and repository guidance

- [x] Create or switch to a Workflow-focused branch without rewriting unrelated history.
- [x] Stage the reviewed file allowlist and inspect `git diff --cached --stat` plus `git diff --cached`.
- [x] Commit with a concise feature message and the repository's required co-author trailer.
- [x] Push the branch to `origin` and create a GitHub PR targeting `main` with summary, architecture/privacy notes, and verification evidence.
- [x] Confirm the PR URL and initial checks/status.
