# Desktop Responsive Layout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every desktop control usable and visually coherent at the supported 920×600 minimum window while preserving roomy multi-panel layouts at larger sizes.

**Architecture:** Introduce pure layout-budget functions plus one viewport hook so the shell can cap the resizable sidebar and compact Dockview without scattering magic numbers. Keep popup/modal containment local to each overlay, and use narrow component APIs (`compact`, calculated position) rather than a broad renderer rewrite. Protect the behavior with pure unit tests, component tests, and Electron visual QA at the exact failure combinations found during the audit.

**Tech Stack:** Electron, React 18, TypeScript, Tailwind CSS v4, Zustand, Dockview, Vitest/jsdom, Playwright-over-CDP visual QA.

## Global Constraints

- Activate Node 22 before every npm command because `better-sqlite3` targets ABI 127.
- Do not runtime-import daemon or `better-sqlite3` code from Electron main/renderer.
- Every new user-facing string must exist in both Korean and English catalogs.
- Preserve the user's saved layout where possible; responsive compaction must not persistently overwrite a roomy Dockview layout.
- Verify both English and Korean UI where text wrapping materially changes.
- Keep the root composition and WebSocket protocol unchanged; this is renderer-only layout work except for tests/docs.

---

### Task 1: Shell layout budget and responsive Dockview compaction

**Files:**
- Create: `apps/desktop/src/renderer/lib/layout-budget.ts`
- Create: `apps/desktop/src/renderer/lib/useViewportSize.ts`
- Modify: `apps/desktop/src/renderer/lib/useResizableWidth.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/workspace/WorkspaceDock.tsx`
- Modify: `apps/desktop/src/renderer/components/WorkspaceHeaders.tsx`
- Modify: `apps/desktop/src/renderer/globals.css`
- Create: `apps/desktop/test/lib/layout-budget.test.ts`
- Modify: `apps/desktop/test/workspace/default-template.test.ts`

**Interfaces:**
- Produces: `sidebarMaxForViewport(viewportWidth: number): number`, `isCompactSidebar(width: number): boolean`, `isShortViewport(height: number): boolean`, and `shouldCompactDock(mainWidth: number): boolean`.
- Produces: `useViewportSize(): { width: number; height: number }`.
- Extends: `WorkspaceDock` with `compact?: boolean`; compact mode temporarily removes Files/Git/Nested and restores them when space returns without persisting the temporary layout.

- [ ] **Step 1: Write failing layout-budget tests**

```ts
expect(sidebarMaxForViewport(840)).toBe(220);
expect(sidebarMaxForViewport(1168)).toBe(440);
expect(isCompactSidebar(239)).toBe(true);
expect(isShortViewport(600)).toBe(true);
expect(shouldCompactDock(619)).toBe(true);
expect(shouldCompactDock(720)).toBe(false);
```

- [ ] **Step 2: Run the focused tests and confirm missing exports fail**

Run: `npx vitest run test/lib/layout-budget.test.ts test/workspace/default-template.test.ts`
Expected: FAIL because the layout-budget module and compact-dock predicate do not exist.

- [ ] **Step 3: Implement the pure layout budget and viewport hook**

```ts
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 440;
export const MAIN_MIN_WIDTH = 620;
export const DOCK_COMPACT_WIDTH = 720;

export function sidebarMaxForViewport(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - MAIN_MIN_WIDTH));
}
export const isCompactSidebar = (width: number): boolean => width < 240;
export const isShortViewport = (height: number): boolean => height < 680;
export const shouldCompactDock = (mainWidth: number): boolean => mainWidth < DOCK_COMPACT_WIDTH;
```

`useViewportSize` reads `window.innerWidth/innerHeight`, subscribes to `resize`, and removes the listener on unmount.

- [ ] **Step 4: Make sidebar resizing honor the live maximum**

Return `width: clamp(width, opts.min, opts.max)` from `useResizableWidth`; use that clamped width as `startW`. In `App`, pass `min: SIDEBAR_MIN_WIDTH`, `max: sidebarMaxForViewport(viewport.width)`, derive compact/short flags, and pass them to Sessions, UsagePanel, and WorkspaceDock.

- [ ] **Step 5: Compact Dockview without destroying the saved roomy layout**

Track auto-removed right-group panel kinds in a ref. When `compact` becomes true, remove visible Files/Git/Nested with reconciliation enabled and suppress layout persistence. When it becomes false, reopen only those auto-removed kinds, clear the suppression flag, and persist the restored layout.

- [ ] **Step 6: Make workspace headers container-responsive**

Add semantic classes for eyebrow, provider, branch/session id, metrics, and controls. Add container queries that hide metrics/eyebrow below 720px and secondary identity fields below 520px while keeping status, title, and controls reachable.

- [ ] **Step 7: Run tests, typecheck, and commit**

Run: `npx vitest run test/lib/layout-budget.test.ts test/workspace/default-template.test.ts test/workspace-headers.test.tsx`
Run: `npm -w apps/desktop run typecheck`
Expected: PASS.

Commit: `fix(desktop): protect workspace layout at narrow widths`

---

### Task 2: Viewport-safe dialogs and popovers

**Files:**
- Modify: `apps/desktop/src/renderer/components/WorkerSpawnModal.tsx`
- Modify: `apps/desktop/src/renderer/components/RunAutomationDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/AttentionBell.tsx`
- Modify: `apps/desktop/test/spawn-modal.test.tsx`
- Modify: `apps/desktop/test/attention-bell.test.tsx`
- Create: `apps/desktop/test/run-automation-dialog.test.tsx`

**Interfaces:**
- Produces: `attentionPanelPosition(rect, viewport): { top?: number; bottom?: number; left: number }`.
- Keeps all modal callbacks and automation/worker payloads unchanged.

- [ ] **Step 1: Add failing containment tests**

```ts
expect(attentionPanelPosition({ left: 14, top: 480, bottom: 508 }, { width: 840, height: 547 }))
  .toMatchObject({ bottom: 73, left: 14 });
expect(screen.getByRole("dialog")).toHaveClass("max-h-[calc(100vh-2rem)]", "overflow-hidden");
```

The run-automation test renders an automation referencing all supported variables and asserts the dialog has a scrollable body plus fixed footer.

- [ ] **Step 2: Run tests and confirm they fail on current positioning/classes**

Run: `npx vitest run test/attention-bell.test.tsx test/spawn-modal.test.tsx test/run-automation-dialog.test.tsx`
Expected: FAIL for missing position helper and containment classes.

- [ ] **Step 3: Split WorkerSpawnModal into fixed header, scrollable body, and fixed footer**

Use an overlay with `p-4`, a `w-full max-w-[520px] max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col` panel, a `min-h-0 overflow-y-auto px-5` body, and a border-top footer. Keep the source result list nested inside the body scroll region.

- [ ] **Step 4: Apply the same bounded structure to RunAutomationDialog**

Keep title/description and action buttons visible; place only the generated variable fields in `min-h-0 overflow-y-auto`.

- [ ] **Step 5: Flip and clamp AttentionBell vertically**

Use the panel's maximum expected height to open downward only when it fits. Otherwise set `bottom` from the trigger's top edge. Clamp the list height to the remaining viewport and retain the existing horizontal clamp.

- [ ] **Step 6: Run tests, typecheck, and commit**

Run: `npx vitest run test/attention-bell.test.tsx test/spawn-modal.test.tsx test/run-automation-dialog.test.tsx`
Run: `npm -w apps/desktop run typecheck`
Expected: PASS.

Commit: `fix(desktop): keep dialogs and attention popover in viewport`

---

### Task 3: Sidebar density, overflow, and new-session wrapping

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/views/Sessions.tsx`
- Modify: `apps/desktop/src/renderer/views/RepoTree.tsx`
- Modify: `apps/desktop/src/renderer/components/UsagePanel.tsx`
- Modify: `apps/desktop/src/renderer/components/Composer.tsx`
- Modify: `apps/desktop/src/renderer/components/NewSessionPage.tsx`
- Modify: `apps/desktop/src/renderer/components/Tooltip.tsx` only if footer restructuring leaves an edge-clipped tooltip.
- Create: `apps/desktop/test/usage-panel.test.tsx`
- Modify: `apps/desktop/test/sessions.test.tsx` if present; otherwise create `apps/desktop/test/sessions-responsive.test.tsx`.

**Interfaces:**
- Extends: `Sessions` with `compact?: boolean` to replace the wide source tab row with a full-width source select.
- Extends: `UsagePanel` with `compact?: boolean`; compact mode starts collapsed but remains user-expandable.

- [ ] **Step 1: Add failing compact-mode component tests**

Assert compact Sessions renders one source select instead of the wide Segment, and compact UsagePanel initially hides meters but exposes an expand button that reveals them.

- [ ] **Step 2: Run focused tests and confirm compact props are unsupported**

Run: `npx vitest run test/sessions-responsive.test.tsx test/usage-panel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Isolate horizontal overflow**

Set Sessions and RepoTree scroll containers to `overflow-y-auto overflow-x-hidden`. In compact Sessions render a full-width source `<Select>` with localized labels/counts; retain the existing Segment at normal width.

- [ ] **Step 4: Make usage collapsible in short viewports**

Keep the provider header visible, add a chevron disclosure button, and render meter/stat rows only when `!compact || expanded`. Reset to collapsed when entering compact mode without changing provider selection.

- [ ] **Step 5: Separate footer status and action rows**

Replace the mixed wrapping row with a clipped status row and a right-aligned action row so daemon/Slack text cannot push action icons or top-tooltips outside the sidebar.

- [ ] **Step 6: Polish narrow composer/new-session flow**

Give composer selects bounded flex bases, keep attach/send grouped at the line end, and use compact heading/padding classes when the shell reports narrow space. The send action must stay visible on every wrapped line.

- [ ] **Step 7: Run tests, typecheck, and commit**

Run: `npx vitest run test/sessions-responsive.test.tsx test/usage-panel.test.tsx test/new-session-page-provider.test.tsx`
Run: `npm -w apps/desktop run typecheck`
Expected: PASS.

Commit: `fix(desktop): compact sidebar and new-session controls`

---

### Task 4: Electron visual QA and full regression gate

**Files:**
- Modify only if QA finds a remaining defect in the files above.

**Interfaces:**
- No new interfaces; this task proves the complete behavior.

- [ ] **Step 1: Build the root daemon with Node 22**

Run: `npm run build`
Expected: TypeScript build succeeds and `dist/index.js` is executable.

- [ ] **Step 2: Launch Electron with a CDP port**

Run: `ROOKERY_DEBUG_PORT=9225 npm -w apps/desktop run dev`
Expected: Electron starts and exposes the renderer page.

- [ ] **Step 3: Verify the failure matrix with screenshots and bounding boxes**

Check:
- 920×600 with sidebar preferred widths 220, 252, and 440.
- Sidebar expanded/collapsed.
- Master and worker pages with right Dockview group open and auto-compacted.
- New session in English and Korean.
- Worker spawn direct and Linear modes; dialog bounds must remain inside the viewport and footer must be reachable.
- Attention queue from the collapsed bottom rail; panel must open upward and remain inside the viewport.
- 1280×800; roomy saved sidebar/Dockview layout must return instead of remaining compacted.

- [ ] **Step 4: Run complete validation**

Run: `npm -w apps/desktop test`
Run: `npm -w apps/desktop run typecheck`
Run: `npm run typecheck`
Run: `npm run build`
Expected: all commands PASS.

- [ ] **Step 5: Inspect the final diff and commit any QA corrections**

Run: `git diff --check`
Run: `git status --short`
Expected: no whitespace errors and only intended desktop/tests/plan changes before the final commit.

Commit: `test(desktop): cover responsive layout boundaries`
