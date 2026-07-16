# Dynamic Workflow Phases Implementation Plan

> **Follow-up:** `2026-07-16-dynamic-workflow-live-phases.md` adds Claude's raw live `task_progress.workflow_progress` as the primary source; the run snapshot described here remains fallback/enrichment.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect Claude Dynamic Workflow phase and agent-label metadata from the provider-owned run snapshot and render agents grouped by phase in the desktop Activity panel.

**Architecture:** The daemon will derive and validate the sibling `<sdkSessionId>/workflows/<runId>.json` path only after the existing transcript directory has passed containment checks. A bounded parser will extract only phase definitions and per-agent `{agentId,label,phaseIndex,phaseTitle,model}` metadata, merge it into the live journal/transcript registry, and expose the sanitized fields through existing workflow events and snapshots. The renderer will group agents by declared phase while retaining the current flat fallback for runs without metadata.

**Tech Stack:** TypeScript, Node.js filesystem ports, Claude Agent SDK local workflow artifacts, React, Zustand, Vitest, Testing Library.

## Global Constraints

- Activate Node 22 before every build or test command.
- Never execute or import the provider-owned workflow script to discover phases.
- Never send `script`, prompts, results, logs, previews, or filesystem paths over `CoreEvent` or WebSocket.
- Continue treating `journal.jsonl` as the authority for agent membership and completion; the run snapshot enriches metadata.
- Read the run snapshot with a hard byte limit and degrade phase metadata independently without breaking workflow observation.
- Multiple phases may be active concurrently; do not model the UI as a single-current-step wizard.
- Preserve summary-only behavior and all existing Dynamic Workflow reconnect/history semantics.
- The existing uncommitted Dynamic Workflow Activity changes are in scope and must not be reset or overwritten.

---

### Task 1: Parse sanitized run-phase metadata

**Files:**
- Modify: `src/core/workflow-activity.ts`
- Modify: `src/core/claude-workflow-transcript.ts`
- Test: `test/core/claude-workflow-transcript.test.ts`

**Interfaces:**
- Consumes: the provider-owned run JSON object containing `phases` and `workflowProgress`.
- Produces: `WorkflowPhaseSummary`, optional agent `label`/`phaseIndex`/`phaseTitle`/`model`, and `parseWorkflowRunState(text)`.

- [x] **Step 1: Write the failing parser test**

```ts
expect(parseWorkflowRunState(JSON.stringify({
  phases: [{ title: "Recon", detail: "Inspect", model: "opus" }],
  workflowProgress: [
    { type: "workflow_agent", agentId: "a1", label: "code:core", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8", state: "progress" },
  ],
  script: "must not escape",
  logs: ["must not escape"],
}))).toEqual({
  phases: [{ index: 1, title: "Recon", detail: "Inspect", model: "opus" }],
  agents: [{ agentId: "a1", label: "code:core", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8" }],
});
```

- [x] **Step 2: Run the parser test and verify it fails**

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npx vitest run test/core/claude-workflow-transcript.test.ts`

Expected: FAIL because `parseWorkflowRunState` and phase fields do not exist.

- [x] **Step 3: Add bounded provider-neutral types and parser**

```ts
export interface WorkflowPhaseSummary {
  index: number;
  title: string;
  detail?: string;
  model?: string;
}

export type WorkflowRunStateMetadata = {
  phases: WorkflowPhaseSummary[];
  agents: Array<Pick<WorkflowAgentSummary, "agentId" | "label" | "phaseIndex" | "phaseTitle" | "model">>;
};
```

The parser must accept only plain objects, cap phase/agent collection sizes, validate ids and positive integer indices, truncate every string field, deduplicate agents by `agentId`, and return no unknown provider fields.

- [x] **Step 4: Run the parser test and verify it passes**

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npx vitest run test/core/claude-workflow-transcript.test.ts`

Expected: PASS.

### Task 2: Securely observe and merge the run snapshot

**Files:**
- Modify: `src/daemon/claude-workflow-registry.ts`
- Test: `test/daemon/claude-workflow-registry.test.ts`

**Interfaces:**
- Consumes: `parseWorkflowRunState(text)` from Task 1 and the existing one-second reconciliation loop.
- Produces: `WorkflowRunSnapshot.phases` and phase-enriched `WorkflowAgentSummary` events/snapshots.

- [x] **Step 1: Write failing registry tests**

```ts
files.files.set("/claude/sdk-1/workflows/wf-1.json", JSON.stringify({
  phases: [{ title: "Recon" }, { title: "Judge" }],
  workflowProgress: [
    { type: "workflow_agent", agentId: "a1", label: "reader", phaseIndex: 1, phaseTitle: "Recon", model: "opus", state: "progress" },
  ],
}));
// After launch + flush, the run has ordered phases and agent a1 has exact label/phase metadata.
```

Add a second test whose run-state `realpath` escapes the validated SDK session; assert the run remains live from its journal, phase data stays empty, and no path appears in the snapshot.

- [x] **Step 2: Run the registry test and verify it fails**

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npx vitest run test/daemon/claude-workflow-registry.test.ts`

Expected: FAIL because the registry does not locate or read the run snapshot.

- [x] **Step 3: Derive and validate the state file path**

After transcript validation, derive `<sessionRoot>/workflows/<runId>.json`, require its real path to equal the exact derived path, require its parent to remain under the validated session root, and reject symlinks/traversal. Do not use `launch.scriptPath` as the authority.

- [x] **Step 4: Add bounded polling and metadata merge**

Read at most 16 MiB from byte zero when `{size,mtimeMs}` changes. On each reconciliation and final drain, parse the snapshot, replace declared phases, and merge only label/phase/model fields into journal-owned agents. Missing, oversized, malformed, or escaped state files must leave journal observation operational.

- [x] **Step 5: Run registry and protocol tests**

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npx vitest run test/daemon/claude-workflow-registry.test.ts test/protocol/messages.test.ts apps/desktop/test/store-reduce.test.ts`

Expected: PASS.

### Task 3: Render phase-grouped workflow activity

**Files:**
- Modify: `apps/desktop/src/renderer/views/WorkflowRuns.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/workflowActivity.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/workflowActivity.ts`
- Test: `apps/desktop/test/workflow-activity.test.tsx`

**Interfaces:**
- Consumes: ordered `run.phases` and per-agent phase metadata from Tasks 1–2.
- Produces: concurrent phase sections with exact per-phase active/completed/stopped counts and labeled agent rows.

- [x] **Step 1: Write the failing renderer test**

```tsx
const phased = run({
  phases: [
    { index: 1, title: "Recon", detail: "Inspect code" },
    { index: 2, title: "Verify" },
  ],
  agents: [
    agent("a1", "running", 200, { label: "reader", phaseIndex: 1, phaseTitle: "Recon" }),
    agent("a2", "running", 210, { label: "checker", phaseIndex: 2, phaseTitle: "Verify" }),
  ],
});
```

Assert both phase headings are simultaneously visible, both agent labels render, exact counts render for each phase, and no percentage/current-step claim appears.

- [x] **Step 2: Run the renderer test and verify it fails**

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npm -w apps/desktop test -- --run test/workflow-activity.test.tsx`

Expected: FAIL because agents are grouped only by lifecycle status and labels are not rendered.

- [x] **Step 3: Implement phase sections and fallback**

Build ordered groups from declared phases, append discovered phase titles not present in the declarations, and place unmatched agents in a localized “Unassigned” group. Each phase header shows its title/detail and exact `active/completed/stopped/started` counts. Agent rows prefer `label` and retain the short agent id as secondary identity. Runs without phase metadata continue to use the existing flat active/completed/stopped layout.

- [x] **Step 4: Run renderer tests and typecheck**

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npm -w apps/desktop test -- --run test/workflow-activity.test.tsx test/i18n/catalog.test.ts test/i18n/used-keys.test.ts`

Expected: PASS.

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-dynamic-workflow-activity-design.md`
- Modify: `docs/architecture/master-worker-turn.md`
- Modify: `docs/reference/events.md`
- Modify: `docs/reference/protocol.md`

**Interfaces:**
- Consumes: the final implementation behavior.
- Produces: source-linked documentation of the run-snapshot observation path and sanitized phase fields.

- [x] **Step 1: Replace the obsolete non-goal and document the exact artifact**

Document `<sdkSessionId>/workflows/<runId>.json`, its `phases` and `workflowProgress` metadata, containment rules, independent degradation, concurrent phases, and forbidden fields.

- [x] **Step 2: Run focused and full verification**

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npm run typecheck`

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npm test`

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npm -w apps/desktop run typecheck`

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npm -w apps/desktop test -- --run`

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npm run build`

Run: `PATH=/Users/clover/.nvm/versions/node/v22.23.0/bin:$PATH npm -w apps/desktop run build`

Expected: every command exits 0.

- [x] **Step 3: Review the final diff without committing unrelated work**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; only the existing Dynamic Workflow Activity change set plus this phase-collection extension is present.
