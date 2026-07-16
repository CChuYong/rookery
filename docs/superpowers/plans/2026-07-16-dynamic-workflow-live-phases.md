# Dynamic Workflow Live Phases Implementation Plan

> **For Claude/Codex:** Execute this plan inline and preserve the existing uncommitted Dynamic Workflow Activity work.

**Goal:** Show Claude Dynamic Workflow phases and exact agent-to-phase grouping while a run is active by consuming the same live progress payload used by Claude Code's `/workflows` UI.

**Architecture:** Decode the undocumented-but-installed CLI `system/task_progress.workflow_progress` array at the Claude adapter boundary into the existing provider-neutral workflow metadata shape. The daemon registry merges that live metadata immediately, while the validated sibling run JSON remains a terminal/recovery enrichment source for phase detail/model fields. Journal and per-agent transcript files remain authoritative for agent membership, status, activity, and history.

**Tech Stack:** TypeScript, Claude Agent SDK raw system messages, Vitest, Electron/React existing Activity UI.

---

## Constraints

- Do not execute workflow scripts or infer a single exclusive current phase; phases may overlap.
- Allowlist only phase title/index and agent identity/grouping metadata. Never forward prompts, results, logs, or previews.
- Bound array sizes, identifiers, and strings at the Claude adapter boundary.
- Preserve the validated run-state JSON polling path as fallback/enrichment.
- Keep Dynamic Workflow activity separate from native `worker.nested` agents.

### Task 1: Extract and test a reusable live progress parser

**Files:**

- Modify: `src/core/claude-workflow-transcript.ts`
- Test: `test/core/claude-workflow-transcript.test.ts`

- [x] Add `parseWorkflowProgress(value, declaredPhases?)` that accepts only `workflow_phase` and `workflow_agent` entries and returns `WorkflowRunStateMetadata`.
- [x] Reuse it from `parseWorkflowRunState` so live and completed snapshot decoding have identical validation and privacy behavior.
- [x] Test duplicate agent updates, malformed ids/indexes, bounds, and removal of prompt/result/tool-summary content.

### Task 2: Decode live progress from Claude task frames

**Files:**

- Modify: `src/core/workflow-activity.ts`
- Modify: `src/core/claude-backend.ts`
- Modify: `test/helpers/fake-query.ts`
- Test: `test/core/claude-backend.test.ts`

- [x] Add optional provider-neutral `progress` metadata to `WorkflowTaskUpdate`.
- [x] Read raw `workflow_progress` only for known `local_workflow` task ids and attach sanitized metadata to the progress event.
- [x] Prove unrelated task progress remains ignored and unsafe fields never cross the backend seam.

### Task 3: Merge live phases into the daemon registry

**Files:**

- Modify: `src/daemon/claude-workflow-registry.ts`
- Test: `test/daemon/claude-workflow-registry.test.ts`

- [x] Merge live phases by index while preserving richer detail/model values already read from a run-state snapshot.
- [x] Merge live agent label/phase/model metadata and apply it immediately to agents already discovered by the journal.
- [x] Preserve metadata for agents not yet present so the next journal `started` record is grouped on its first event.
- [x] Test that phase groups and exact agent mapping are available while the sibling run JSON is absent.

### Task 4: Document the live source and verify the product

**Files:**

- Modify: `docs/superpowers/specs/2026-07-16-dynamic-workflow-activity-design.md`
- Modify: `docs/architecture/master-worker-turn.md`
- Modify: `docs/reference/protocol.md`

- [x] Document raw `task_progress.workflow_progress` as the live primary source and the completed sibling JSON as fallback/enrichment.
- [x] Run focused parser/backend/registry tests.
- [x] Activate Node 22, then run root typecheck/tests/build and desktop typecheck/tests/build.
- [x] Restart `./scripts/dev.sh`, verify daemon health, and leave the app running for the user.
