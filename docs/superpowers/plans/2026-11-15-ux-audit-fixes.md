# Desktop UX Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the high and medium findings (#1–#107) of the 2026-11-15 desktop UI/UX audit, with priority on layout breakage when panels open/close or resize and on UX complexity; low findings in the same theme are fixed when they touch the same code.

**Architecture:** Renderer-only work in `apps/desktop` (plus `src/main` for the Cmd+W item). Eight sequential tasks, one per audit theme group, on `feat/ux-audit-fixes` (stacked on `feat/session-leftovers` / PR #33 because the spawn page items build on it).

**Tech Stack:** Electron, React 18, Tailwind v4, Zustand, dockview, Monaco, vitest + jsdom.

**Spec:** `docs/2026-11-15-desktop-uiux-audit.md` — each finding has evidence (file:line, screenshot), detail and a suggested fix. The report's suggestion is a starting point, not a mandate: the implementer may pick a better fix that removes the same user-visible problem, and records why.

## Global Constraints
- Node 22 (`export PATH="$HOME/.nvm/versions/node/v22.23.0/bin:$PATH"`). ESM relative imports end in `.js`; type-only imports use `import type`; code comments in English.
- Renderer imports `@daemon/*` as types only. Every new or changed user-facing string goes through i18n with identical ko/en keys (`test/i18n/catalog.test.ts`, `used-keys.test.ts`). Korean copy uses 해요체 consistently.
- Look and feel follows `.claude/skills/rookery-ide-ui/SKILL.md` (IDE conventions: 12–13px chrome, neutral selection, accent only as lines/focus, no new decorative UI). `apps/desktop/DESIGN.md` "Rules for editing components" bind: keep every handler, test hook and i18n key that still has a use; never edit a test only to make a change pass — update a test only when the asserted behaviour intentionally changed, and say so in the report.
- No daemon protocol or persistence changes. If a finding truly needs one, skip it and say why.
- Persisted renderer state (`zustand persist`) that changes shape needs a `version` bump + `migrate`.
- Gates per task: `npm -w apps/desktop run typecheck && npm -w apps/desktop test`; root `npm run typecheck` if anything outside `apps/desktop` changes.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do not push.
- A finding that turns out to be wrong, already fixed, or not worth its cost is skipped with a one-line reason in the report — not silently dropped.

## Review Focus
1. Shrinking the window to 920x600 and growing it back must leave the dock in sane proportions (conversation never crushed, right panel never silently gone or stuck at half width), and header toggles must always tell the truth.
2. Persisted layouts from older versions must still load (or reset cleanly) after constraint/size changes.
3. Every removed or merged control must still be reachable somewhere (no feature loss while simplifying).
4. ko/en copy changes must keep key parity and not break components that tests assert by literal text.
5. Keyboard users must keep a visible focus and a way to reach every action that was mouse-only.

---

### Task 1: Dock layout, panel resize, editor tabs (themes T1 + T2, plus #82)
**Findings:** #1 #2 #3 #4 #5 #6 #7 #8 #9 #11 #12 #13 #14 #15 #16 #17 #18 #79 #80 #81 #82; low #108 if cheap. Also #71 and #106 (dock overflow chevron focus, sash keyboard/double-click reset) since they live in the same dock code.
**Files (start):** `apps/desktop/src/renderer/workspace/*` (WorkspaceDock, panels, default-template, dockview-theme.css, RookeryTab), `store/layout*.ts`, `store/dock-panels*`, `lib/layout-budget*`, `components/WorkspaceHeaders.tsx`, `TerminalPanel.tsx`, `SideConversationDrawer.tsx`, `MessageList.tsx`, `TabBar.tsx`, `MonacoEditor.tsx`, `MonacoDiff.tsx`, `src/main/index.ts` (Cmd+W menu).
- [ ] Tests first for the pure parts (constraints, layout restore/migration, toggle truthfulness, compact-mode persistence, active-tab visibility helper) and component tests where practical.
- [ ] Implement. Constraints: conversation has a minimum width/height; side panels have min and max widths; shrinking below the budget must not silently close a panel the user opened without the toggle saying so; growing back restores the remembered width; old persisted layouts migrate or reset.
- [ ] Desktop gates; commit `fix(desktop): dock panels keep sane sizes through resize; editor tabs stay visible and honest`.

### Task 2: Visual tokens, shared components, feedback patterns (theme T9)
**Findings:** #55 #56 #99 #100 #101 #102 #103; low #109 #111 #135 if cheap.
**Files (start):** `globals.css`, `ui/*` (Segment, Button, confirm-dialog), `workspace/dockview-theme.css`, `components/UsagePanel.tsx`, `Sessions`/`RepoTree` row styles, `FileTree`, `CommitView`, `PromptEditor`, `CheckpointMenu`, `CapabilityLibraryTab`, `TerminalPanel`.
- [ ] Add a `warn` token and use it where `run` was misused as a warning; one active-tab/segment style; one selected-row style (neutral lift per the IDE skill); one dialog shell; one destructive-confirm pattern; optimistic Pin/Archive with rollback.
- [ ] Desktop gates; commit `fix(desktop): one set of tokens and patterns for tabs, selection, dialogs and warnings`.

### Task 3: Sidebar, header, navigation (theme T3)
**Findings:** #10 #19 #20 #21 #22 #23 #24 #25 #26 #27 #83 #84; low #118 if cheap.
**Files (start):** `App.tsx` (sidebar, title bar, collapsed rail), `components/StatusBar.tsx`, `WorkspaceHeaders.tsx`, `AttentionBell.tsx`, `OpenInAppMenu.tsx`, `UsagePanel.tsx`, `ContextMenu.tsx`, `ResourceMonitor.tsx`, `views/RepoTree.tsx`, `lib/layout-budget*`.
- [ ] The collapsed rail offers navigation instead of repeating the status bar; distinct icons per function; header items that hide at narrow widths stay reachable (overflow menu); one control order for session and worker headers; Repos main area has a heading and actions; worker spawn entry is labelled and the delete action is not one slip away; whole-branch diff is reachable.
- [ ] Desktop gates; commit `fix(desktop): simpler sidebar rail and headers; nothing disappears at narrow widths`.

### Task 4: Composer, conversation, new session / new worker pages (theme T4)
**Findings:** #28 #29 #30 #31 #32 #33 #34 #35 #36 #37 #85 #86 #87 #92; low #116 #117 if cheap.
**Files (start):** `components/Composer.tsx`, `SpeedControl.tsx`, `ConversationPane.tsx`, `MessageList.tsx`, `PromptEditor.tsx`, `NewSessionPage.tsx`, `WorkerSpawnPage.tsx`, `SideConversationDrawer.tsx`, `App.tsx` (send/recover/commands wiring).
- [ ] The composer footer stays one tidy row (secondary selectors folded or condensed, send button never wraps alone); the three composers share corners, send button, layout and submit key; pending bubbles match confirmed ones and render in the transcript; one error surface per failure; disabled controls explain why; Recover shows progress and blocks double clicks; spawn page surfaces search/branch failures and invalid budgets; SpeedControl is labelled.
- [ ] Desktop gates; commit `fix(desktop): calmer composers with one layout across conversation, new session and new worker`.

### Task 5: Git panel and loading / error / empty states (themes T5 + T6)
**Findings:** #38 #39 #40 #41 #42 #43 #44 #45 #46 #47 #48 #49 #88 #89 #90; low #112 #114 #115 #136 #137 if cheap.
**Files (start):** `components/GitChanges.tsx`, `GitHistory.tsx`, `CommitView.tsx`, `RightSidebar.tsx`, `views/Sessions.tsx`, `views/RepoTree.tsx`, `App.tsx`, `SettingsPage.tsx`, `UsagePanel.tsx`, `capabilities/*`, `ResourceMonitor.tsx`, `src/main/workspace-manager.ts` only if the non-git distinction needs it (IPC result shape, no daemon change).
- [ ] Every data surface distinguishes loading / empty / failed with a retry that shows progress; no infinite "loading"/"checking"; not-a-git-repo is not "no changes"; Capability Center refreshes without blanking the list.
- [ ] Desktop gates (+ root typecheck if `src/main` changes); commit `fix(desktop): honest loading, empty and error states; tidier Git panel`.

### Task 6: Settings, Automation, Capability Center (themes T7 + T8)
**Findings:** #50 #51 #52 #53 #54 #63 #64 #91 #93 #94 #95 #96 #97 #98; low #110 #113 #119 #134 if cheap.
**Files (start):** `components/SettingsPage.tsx`, `AutomationPage.tsx`, `AutomationForm.tsx`, `RunAutomationDialog.tsx`, `CapabilitiesPage.tsx`, `components/capabilities/*`, `repository-settings/*`, i18n `settings`/`automation`/`capabilities` namespaces.
- [ ] One save model in Settings with a reachable Save; secrets are cleared only after a confirmed save; model defaults live together; readable layout at 920px; automation form asks Action before run settings and shows local times; automation rows are calmer; Capability Center uses one set of names and no internal jargon; Effective view is less dense.
- [ ] Desktop gates; commit `fix(desktop): simpler settings, automation and capability screens`.

### Task 7: Copy and i18n (theme T10)
**Findings:** #57 #58 #59 #60 #61 #62 #65 #66 #104 #105; low #120–#128 #138 #139 if cheap.
**Files (start):** `apps/desktop/src/renderer/i18n/locales/{ko,en}/*`, `lib/status*`, components with hardcoded strings (`ToolGroup`, `ToolBlock`, `StatusBar`, …).
- [ ] One term per concept in each locale (stop vs interrupt, revert vs restore checkpoint, provider, workflow, spawn, repo), status labels localized, hardcoded strings moved into i18n, Korean 해요체 throughout. Add a short glossary comment block at the top of `i18n/locales/ko/common.ts` (or the nearest shared file) listing the chosen terms.
- [ ] Desktop gates; commit `fix(desktop): one term per concept in ko and en`.

### Task 8: Keyboard and accessibility (theme T11, remaining)
**Findings:** #67 #68 #69 #70 #72 #73 #74 #75 #76 #77 #78 #107; low #129–#133 #140 if cheap. (#71, #82, #106 are in Task 1.)
**Files (start):** `ContextMenu.tsx`, `hooks/useFocusTrap*`, `FileTree.tsx`, `PromptEditor.tsx`, `FileMentionPopup.tsx`, `ToolGroup.tsx`, `ThinkingBlock.tsx`, `ToolBlock.tsx`, `RepoTree.tsx`, `WorkflowRuns*`, `SideConversationDrawer.tsx`, `InteractionCard.tsx`, `AttentionBell.tsx`, `Sessions.tsx`, `RepoModal.tsx`, `AutomationPage.tsx`, `MessageImages.tsx`, `SettingsPage.tsx`, `Tooltip.tsx`.
- [ ] Focus restore and traps, keyboard paths for mouse-only actions, scroll-into-view in popups, aria-expanded/labels/accessible names, IME guards on every Enter handler, roving tab stops with aria-current in lists.
- [ ] Desktop gates; commit `fix(desktop): keyboard paths and accessible names across the renderer`.

### Final
Whole-branch review (fable), one fix wave, live visual check of the layout items on an isolated demo daemon (920x600 ↔ 1440 resize, sash drags, panel toggles, ko locale), push, PR against `main` noting it is stacked on #33.
