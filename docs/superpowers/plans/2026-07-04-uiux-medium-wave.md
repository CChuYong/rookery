# Desktop UI/UX Medium Wave (#42–#52) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 11 medium-severity, medium-effort findings (#42–#52) from the 2026-07-03 desktop UI/UX audit — interaction gaps, false-empty transcript, dirty-tab guard, dock panel hide/chrome, right-click-only actions, identical-label lists, cross-navigation, worker status legibility, raw Slack IDs, and segment-control drift.

**Architecture:** Renderer-heavy (`apps/desktop/src/renderer`); one task touches the daemon Slack adapter (#51) and one touches `src/core` (#42 interaction-registry). Every task replicates an in-repo pattern cited per task. New reusable pieces: a shared `Segment` component (#52) and a `ConfirmDialog`-style dirty-close guard (#44) — both modeled on existing code.

**Tech Stack:** TypeScript, React 18, Zustand, Tailwind v4, vitest (jsdom for desktop, node for daemon/core), electron-vite.

## Global Constraints

- **Spec:** `docs/2026-07-03-desktop-uiux-audit.md`. Each task lists its finding number(s) (`#N`) — the implementer MUST read those finding sections first (exact file:line evidence + the 제안/suggested fix).
- **Node 22 required** (`better-sqlite3` ABI 127). Verify `node -v` → v22.x first.
- **Branch:** all work on `uiux/medium-wave` (already created from `main`). Commit per task.
- **i18n invariant:** every new/changed user-facing string goes through i18n in BOTH `apps/desktop/src/renderer/i18n/locales/ko/<ns>.ts` AND `en/<ns>.ts` (parity + used-keys tests enforce; `npm -w apps/desktop test` fails otherwise). ko is source tone, 해요체. Daemon-side user-facing strings go through `src/core/i18n.ts` (ko default).
- **Terminology (AGENTS.md glossary):** fleet units are "worker/워커"; "agent/에이전트" is reserved for native nested subagents.
- **Code comments in English.**
- **Per-task gate:** `npm -w apps/desktop run typecheck && npm -w apps/desktop test` green. Tasks touching root `src/**` (#42 Task 1, #51 Task 9) additionally run `npm run typecheck && npm test` at repo root.
- **Scope discipline:** fix ONLY the listed findings. Match surrounding style (single-line arrow handlers, terse English comments). No drive-by refactors.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 0: Branch verify

**Files:** none (git only)

- [ ] **Step 1:** `cd /Users/clover/workspace/clovot && git branch --show-current` → must print `uiux/medium-wave` (already created off main). `node -v` → v22.x.
- [ ] **Step 2:** Baseline: `npm -w apps/desktop test` all green; `npm test` (root) all green. Record the counts.

---

### Task 1: AskUserQuestion decline/skip (#42)

**Findings:** #42. Evidence: `InteractionCard.tsx:30-42` (approve card has Deny), `:62-85` (ask card has only Submit, gated on allAnswered); `src/core/interaction-registry.ts` respond ignores `decision` for ask-type. Approve card's Deny is the precedent.

**Files:**
- Modify: `apps/desktop/src/renderer/components/InteractionCard.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/interactionCard.ts`
- Read (verify resolve semantics): `src/core/interaction-registry.ts`, `apps/desktop/src/renderer/App.tsx` respondInteraction

**Interfaces:**
- Consumes: existing `onRespond(requestId, { decision?, answers? })` from App.tsx respondInteraction (fire-and-forget `interaction.respond`).
- Produces: nothing new consumed downstream.

- [ ] **Step 1: Understand the resolve path.** Read `src/core/interaction-registry.ts` `respond()` — confirm what an ask-type interaction does with an empty/absent `answers` and whether a "decline" resolution (e.g. `{ decision: "deny" }` or empty answers) cleanly unblocks the master's `canUseTool` without a crash. Note in the report exactly which payload shape resolves an ask-type interaction as "skipped". If the core ignores `decision` for ask and REQUIRES answers, the minimal safe skip is to resolve with an empty/sentinel answers object that the master interprets as "no selection" — verify the master handles that (read how the SDK AskUserQuestion result is consumed). If resolving cleanly needs a core change, make the MINIMAL one (accept a decline for ask-type) and run root gates.
- [ ] **Step 2: Add the skip control to the ask card.** In `InteractionCard.tsx` ask branch (~:62-85), add a secondary button `t("interactionCard.skip")` next to Submit, always enabled (not gated on allAnswered). Clicking it calls `onRespond(requestId, <the skip payload from Step 1>)` and enters the same `sent` in-flight lock the Submit button uses (the `sent` state added in the quick-wins wave — reuse it). Keep Submit unchanged.
- [ ] **Step 3: i18n.** BOTH locales: `interactionCard.skip` = ko `"건너뛰기"` / en `"Skip"`.
- [ ] **Step 4: Test.** Extend `apps/desktop/test/interaction-card.test.tsx`: an ask card with NO options selected still renders an enabled Skip button; clicking it calls `onRespond` with the skip payload and locks the card (buttons disabled). Run `npm -w apps/desktop test` + typecheck. If core changed, run root gates too.
- [ ] **Step 5: Commit** `fix(desktop): AskUserQuestion cards can be skipped when no option fits (audit #42)`

---

### Task 2: Conversation transcript loading state (#43)

**Findings:** #43. Evidence: `MessageList.tsx:39-46` (items 0 → emptyHint); `App.tsx:465-468` (select→navigate then async history seed, `.catch(()=>{})` — also 325,329,433,434,477,552); `ConversationPane.tsx:20` (EMPTY fallback); `i18n/en/messageList.ts` emptyHint. Pattern: the per-session load-failed flags added in the quick-wins wave (`store.ts` `sessionsLoadFailed` etc.) and SkeletonRows.

**Files:**
- Modify: `apps/desktop/src/renderer/store/store.ts` (per-session/worker history-loaded tracking)
- Modify: `apps/desktop/src/renderer/App.tsx` (history seed paths)
- Modify: `apps/desktop/src/renderer/components/MessageList.tsx`
- Modify: `apps/desktop/src/renderer/components/ConversationPane.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/messageList.ts`

**Interfaces:**
- Produces: a store selector/flag e.g. `historyLoaded: Record<string, boolean>` and `historyLoadFailed: Record<string, boolean>` keyed by session/worker id, with setters, mirroring the `*LoadFailed` shape already in store.ts.

- [ ] **Step 1: Track history-load state.** In `store.ts`, add `historyLoaded` + `historyLoadFailed` records (keyed by the same id used for `logsBySession`/`workerLogs`) with setters, copying the naming/shape of the existing `sessionsLoadFailed` etc. The seedHistory success path sets loaded=true + failed=false; a fresh session that never had history is "loaded" immediately (empty is legitimately empty).
- [ ] **Step 2: Wire the seed paths.** In `App.tsx`, the history-seed `.catch(()=>{})` sites (the session.history and worker.history requests) set `historyLoadFailed` on reject and `historyLoaded` on success. A newly-created session (no prior turns) should be marked loaded so its composer-only empty state shows correctly.
- [ ] **Step 3: Render the three states.** `MessageList.tsx`/`ConversationPane.tsx`: while `!historyLoaded && !historyLoadFailed` for the active id → `SkeletonRows` (message-shaped, reuse the component); `historyLoadFailed` → an error line `t("messageList.loadFailed")` + retry that re-fires the history request; loaded-and-empty → the existing empty hint. Split the empty hint into master vs worker: `messageList.emptyHintMaster` / `messageList.emptyHintWorker` (worker text must NOT say "with the master").
- [ ] **Step 4: i18n.** BOTH locales: `messageList.loadFailed` = ko `"대화를 불러오지 못했어요 — 다시 시도"` / en `"Couldn't load the conversation — retry"`; `messageList.emptyHintMaster` = the current master text; `messageList.emptyHintWorker` = ko `"이 워커와의 대화가 아직 없어요."` / en `"No conversation with this worker yet."`. Keep/rename the old `emptyHint` key appropriately (used-keys test will flag a dangling key).
- [ ] **Step 5: Test.** `apps/desktop/test/` MessageList/conversation: unloaded id → skeleton (not empty hint); loadFailed → error + retry re-fires; loaded-empty master → master hint; loaded-empty worker → worker hint (no "master"). Run gate. Commit `fix(desktop): conversation transcript shows loading/error states, worker empty hint no longer says "master" (audit #43)`

---

### Task 3: Dirty file-tab close guard (#44)

**Findings:** #44. Evidence: `TabBar.tsx:33` (dirty dot), `:35-37` (unguarded closeTab); `RookeryTab.tsx:40-48` (api.close() unguarded); `store/workspace.ts:105,122` (closeTab_ no guard); `MonacoEditor.tsx:90-95` (external-change reload already uses an explicit confirm). The confirm-dialog precedent is the quick-wins AutomationDeleteConfirm / RepoRemoveConfirm (overlay + panel + useModalKeys/useFocusTrap).

**Files:**
- Modify: `apps/desktop/src/renderer/store/workspace.ts` (dirty tracking accessor if not present)
- Modify: `apps/desktop/src/renderer/components/TabBar.tsx`
- Modify: `apps/desktop/src/renderer/workspace/RookeryTab.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/` (the tab/workspace namespace)

**Interfaces:**
- Consumes: the dirty flag the tab renderers already read to show the dot.
- Produces: a shared confirm gate (a small local component or hook) used by BOTH close paths — do NOT duplicate the dialog twice; put it where both TabBar and RookeryTab can import it (e.g. a `TabCloseConfirm` component next to TabBar, or a hook in workspace).

- [ ] **Step 1: Decide the guard location.** Read how TabBar (legacy) and RookeryTab (dockview) each trigger close. Both must route a dirty-tab close through one confirm dialog. Create ONE `TabCloseConfirm` component (copy the AutomationDeleteConfirm structure: overlay, panel, useModalKeys/useFocusTrap, autofocused Cancel) exposing `{ open, tabTitle, onSave?, onDiscard, onCancel }`. If a dirty tab has a save path (Monaco save), offer Save/Discard/Cancel; otherwise Discard/Cancel.
- [ ] **Step 2: Gate both close paths.** TabBar's X (`:35-37`) and RookeryTab's close (`:40-48`): if the tab is dirty, open the confirm instead of closing; if not dirty, close as before. Confirm's Discard → the existing closeTab; Save → save then close; Cancel → stay.
- [ ] **Step 3: i18n.** BOTH locales: `tabBar.unsavedTitle` = ko `"저장 안 된 변경이 있어요"` / en `"Unsaved changes"`; `tabBar.unsavedBody` = ko `"'{name}' 탭을 닫으면 편집 내용이 사라져요."` / en `"Closing '{name}' will discard your edits."`; `tabBar.discardClose` = ko `"저장 안 함"` / en `"Discard"`; reuse `common.cancel` and (if Save offered) an existing save key.
- [ ] **Step 4: Test.** Pin: closing a dirty tab opens the confirm and does NOT close; Discard closes; Cancel keeps it; closing a clean tab closes immediately with no dialog. Extend the tab-bar test. Run gate. Commit `fix(desktop): closing a dirty file tab asks before discarding edits (audit #44)`

---

### Task 4: Dock panel hide/show + terminal chrome (#48, #49)

**Findings:** #48, #49. Evidence #48: `RookeryTab.tsx:35` (closable = editor-only), `WorkspaceHeaders.tsx:32-33` (toggles hidden in dock mode), `WorkspaceDock.tsx:118-121` (conversation re-added). #49: `WorkspaceDock.tsx:35` reuses `workspaceHeaders.terminalTitle` ("Terminal (bottom panel)"); `TerminalPanel.tsx:40-54` (inner tab strip + empty state); `App.tsx:287-295` (legacy auto-spawn) vs dock noop; `i18n/en/terminalPanel.ts` empty hint.

**Files:**
- Modify: `apps/desktop/src/renderer/workspace/RookeryTab.tsx`, `workspace/WorkspaceDock.tsx`, `components/WorkspaceHeaders.tsx`, `components/TerminalPanel.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/workspaceHeaders.ts`, `{ko,en}/terminalPanel.ts`

**Interfaces:**
- Consumes: the dockview panel API and `fixedPanelTitle`/`fixedPanelId` helpers (used in the quick-wins dock work).
- Produces: nothing external.

- [ ] **Step 1 (#48): allow hiding fixed panels.** Give fixed panels (Files/Git/Terminal/Nested) a close affordance that HIDES them (removes the dock panel) instead of the current editor-only close. Add a header control (or View menu) to toggle each fixed panel back on — restore the terminal/right-panel toggles that dock mode hid (`WorkspaceHeaders.tsx:32-33`). The conversation panel stays non-closable (it's the pinned primary — keep the `WorkspaceDock.tsx:118-121` re-add guard). Reopening a hidden panel re-adds it via the same addFixed path with the correct kind/agentKind.
- [ ] **Step 2 (#49a): terminal tab label.** Add a dedicated key `workspaceHeaders.terminalTab` = ko `"터미널"` / en `"Terminal"` and use it for the DOCK PANEL tab title instead of the verbose `terminalTitle` ("Terminal (bottom panel)"). Keep `terminalTitle` for the non-dock header toggle tooltip where it's still accurate.
- [ ] **Step 3 (#49b): terminal empty-state.** When the terminal panel is empty on a worker page, the hint should reference the worktree cwd. Split the empty hint by page kind if cheap: `terminalPanel.emptyHintWorker` / `terminalPanel.emptyHint`. Reuse the collapsed-seed behavior from the quick-wins wave (Task 18 #30 — don't undo it).
- [ ] **Step 4: i18n** both locales for the new keys.
- [ ] **Step 5: Test what's pure.** Dock geometry is not jsdom-testable — pin the pure bits (title-key selection, panel-kind→closable/hideable mapping) and STATE clearly in the report what needs a live dockview check (hide→reopen a fixed panel; terminal tab label after locale switch). Run gate. Commit `fix(desktop): dock fixed panels can be hidden/restored; terminal tab label + empty hint cleaned up (audit #48, #49)`

---

### Task 5: Session/worker actions get a visible + keyboard entry (#45)

**Findings:** #45. Evidence: `Sessions.tsx:211` (onContextMenu only), `:226-247` (hover shows only Pin/Delete), `:304-316` (menu-only Rename/Fork/Archive); `RepoTree.tsx:80,180-193` (worker rows: no hover actions, menu-only, no keydown); macOS has no context-menu key. Pattern: the existing `ContextMenu` component + the group-focus-within reveal from the quick-wins wave.

**Files:**
- Modify: `apps/desktop/src/renderer/views/Sessions.tsx`, `views/RepoTree.tsx`
- Read: `apps/desktop/src/renderer/components/ContextMenu.tsx`

**Interfaces:**
- Consumes: the existing `ContextMenu` open API (whatever Sessions currently passes on right-click).
- Produces: nothing external.

- [ ] **Step 1: Add an overflow (`⋯`) button.** On session rows AND worker rows, add a `⋯` icon button revealed on hover/focus (`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100`, the quick-wins reveal idiom) with `aria-label={t("common.moreActions")}`. Left-click / Enter on it opens the SAME ContextMenu the right-click opens (position it at the button). Do not duplicate the menu contents — reuse the existing menu.
- [ ] **Step 2: Keyboard open.** Add `onKeyDown` on the row (or the ⋯ button) so the menu opens via keyboard (Enter/Space on the button suffices; no need for the OS menu key).
- [ ] **Step 3: i18n.** BOTH locales: `common.moreActions` = ko `"더보기"` / en `"More actions"` (reuse if a like key exists — check common.ts).
- [ ] **Step 4: Test.** Pin: the ⋯ button is present and reachable by role on both session and worker rows; clicking it opens the menu (assert a menu item like Rename/Fork appears). Run gate. Commit `fix(desktop): session/worker row actions reachable via a visible ⋯ button + keyboard, not right-click only (audit #45)`

---

### Task 6: Disambiguate identical row labels (#46 — scoped to secondary text)

**Findings:** #46. Evidence: screenshots a-13/a-15 (sidebar 'clover-space' ×6), a-01 ('banking' ×3); `Sessions.tsx` label fallback `label || baseName(cwd) || id`. **SCOPE:** the audit suggests auto-titles from the first user message AND secondary text. Auto-title generation is a bigger feature (summarization + daemon persistence) — DEFER it. This task does ONLY the renderer-side secondary text, which solves the "wall of identical labels" without backend work.

**Files:**
- Modify: `apps/desktop/src/renderer/views/Sessions.tsx`, `views/RepoTree.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/` (if new strings)

- [ ] **Step 1: Add secondary text to rows whose label is a folder/repo fallback.** When a session/worker row's displayed label came from the `baseName(cwd)`/repo fallback (i.e. no explicit title), render a dim second line: last-activity relative time (reuse `lib/relative-time.ts` + relativeTime catalog) and, if available in the store, a one-line preview of the last message. Keep it to what the store already has — do NOT fetch. If only the timestamp is available, show just that.
- [ ] **Step 2: Don't double up.** Rows with a real explicit title keep single-line (no secondary noise). Only fallback-labeled rows get the helper line.
- [ ] **Step 3: i18n** any new label both locales.
- [ ] **Step 4: Test.** Pin: a session with an explicit title renders single-line; a fallback-labeled session renders the secondary relative-time line. Run gate. Commit `fix(desktop): fallback-named session/worker rows show a relative-time subline to break the wall of identical labels (audit #46, secondary-text scope; auto-title deferred)`

---

### Task 7: Session↔worker cross-navigation (#47)

**Findings:** #47. Evidence: `lib/tool-worker.ts:5-9` (matches only spawn_worker result string); `ToolBlock.tsx:68-70`; `MessageList.tsx:87-96` (live-only marker); `store/reduce.ts:17` (FleetRow has no session field); `WorkspaceHeaders.tsx:39-67` (no backlink). **SCOPE:** the forward direction (attach a 'View worker' chip to more fleet tool cards by parsing the worker id from the tool input) is renderer-only and cheap. The reverse backlink (worker header → spawning session) needs a session field on FleetRow that the daemon may not persist — do the forward chips now; add the reverse backlink ONLY if the spawning-session id is already available on the fleet row/store (verify), else DEFER the reverse with a note.

**Files:**
- Modify: `apps/desktop/src/renderer/lib/tool-worker.ts`, `components/ToolBlock.tsx`
- Read: `apps/desktop/src/renderer/store/reduce.ts` (FleetRow shape), `components/WorkspaceHeaders.tsx`

- [ ] **Step 1: Extend worker-id extraction.** `lib/tool-worker.ts` currently derives a worker id from the `spawn_worker` result. Extend it to also recognize the other fleet tool cards that carry a worker id in their INPUT JSON (`send_worker`, `get_worker_status`, `view_worker_diff`, `interrupt_worker`, `stop_worker`, `discard_worker`) — parse the `id` from the tool input. Return the id so ToolBlock can render the chip.
- [ ] **Step 2: Render the chip on those cards.** `ToolBlock.tsx`: wherever the spawn card shows 'View worker', show the same chip for the other fleet tool cards when an id was extracted. Clicking it selects that worker (existing selectSub path).
- [ ] **Step 3: Reverse backlink (conditional).** Read `store/reduce.ts` FleetRow — if it already carries the spawning session id, add a 'View session' link to the worker header (`WorkspaceHeaders.tsx`). If NOT present, DEFER (a store/daemon change is out of this task's scope) and note it in the report.
- [ ] **Step 4: Test.** Pin: a `send_worker`/`view_worker_diff` tool card renders a 'View worker' chip that resolves to the right id. Run gate. Commit `fix(desktop): fleet tool cards all link to their worker; reverse session backlink where available (audit #47)`

---

### Task 8: Worker status tag legibility (#50)

**Findings:** #50. Evidence: `RepoTree.tsx:94` (statusTag `font-mono text-[8.5px]`, no title); `StatusBadge.tsx:14,30` (11px, raw {status}); `lib/status.ts:9-10` (TAG map: provisioning→PREP, running→RUN, orphaned→ORPH, failed/error→ERR — colorblind alt channel); `MessageList.tsx:91`; screenshot a-01 (tree 'ORPH' vs header 'orphaned').

**Files:**
- Modify: `apps/desktop/src/renderer/lib/status.ts`, `views/RepoTree.tsx`, `components/StatusBadge.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/` (a `status` namespace)

**Interfaces:**
- Produces: a `status.<state>` i18n key set + a `statusLabelKey(state)` helper (like the effortLabelKey pattern from the quick-wins wave), so tree and header share ONE label source.

- [ ] **Step 1: i18n the status labels.** Add `status.*` keys for every worker state (running/idle/stopped/done/error/failed/orphaned/provisioning) in BOTH locales, full words (ko: 실행 중/유휴/중지됨/완료/오류/실패/유실됨/준비 중 — adjust to natural terms; en: Running/Idle/Stopped/Done/Error/Failed/Orphaned/Preparing). Add a `statusLabelKey(state)` helper in `lib/status.ts`.
- [ ] **Step 2: Unify tree + header.** RepoTree's tiny tag and StatusBadge both render via the same label source. Bump the tree tag to at least 10px OR add a `title` tooltip with the full localized state name (e.g. `orphaned — 재시작으로 세션이 유실됨`). Keep the colorblind alt-channel (the short TAG/dot) but ensure the accessible name / tooltip is the full word. Tree and header must show consistent wording (no more 'ORPH' vs 'orphaned' mismatch — either both short-with-tooltip or both full).
- [ ] **Step 3: Test.** Pin: `statusLabelKey` maps each state to its key; RepoTree tag exposes the full localized name via title/aria; StatusBadge renders the localized word (not raw {status}). Run gate. Commit `fix(desktop): worker status tags are legible, localized, and consistent between tree and header (audit #50)`

---

### Task 9: Automation cards resolve Slack IDs to names (#51)

**Findings:** #51. Evidence: `AutomationPage.tsx:18-20` (raw channel/user ID strings concatenated); no conversations.info/users.info resolution anywhere; screenshots a-10, a-32. **SCOPE:** this needs Slack API resolution, which lives in the daemon Slack adapter. Do a clean daemon-side resolution with an ID fallback. If the Slack adapter is not connected (tokens absent), the fallback is the raw ID — no crash. Keep it best-effort.

**Files:**
- Modify: `src/slack/` (add a name-resolution helper using the existing Slack client — read how the adapter calls Slack Web API), possibly `src/core/automation-*` or a new resolver
- Modify: `src/protocol/messages.ts` if a new request is needed, `src/daemon/connection.ts`
- Modify: `apps/desktop/src/renderer/components/AutomationPage.tsx`
- Read: `src/slack/controller.ts`, the Slack adapter's client usage

- [ ] **Step 1: Decide resolution point.** Read the Slack adapter. Preferred cheap approach: resolve names at DISPLAY time via a daemon request `automation.resolveSlackRefs { channels?, users? }` → returns a `{ id: name }` map using `conversations.info`/`users.info` through the already-connected bolt client, cached in-memory (a Map) to avoid repeat calls; on any failure or disconnected Slack, omit that id (renderer falls back to the raw id). Do NOT block automation listing on this. If adding a request is too heavy, resolve lazily and cache — state your chosen design in the report.
- [ ] **Step 2: Implement + fallback.** Wire the resolver. When Slack is unconfigured/off, the resolver returns an empty map (renderer shows raw ids — current behavior, no regression). Guard every Slack API call in try/catch → fall back to id.
- [ ] **Step 3: Renderer.** `AutomationPage.tsx`: for slack-trigger rule cards, request the resolved names and render `#channel-name` / `@user-name` when resolved, raw id otherwise. Cache per page so it doesn't refetch on every render.
- [ ] **Step 4: Test.** Daemon: the resolver returns names for known ids and falls back to the id on API error / disconnected client (fake the Slack client). Renderer: a rule with a resolved name shows the name; unresolved shows the id. Run BOTH root and desktop gates. Commit `fix(desktop,slack): automation rule cards show Slack channel/user names, falling back to IDs (audit #51)`

---

### Task 10: Shared Segment control (#52)

**Findings:** #52. Evidence: `Sessions.tsx:40-79` (active bg-accent/15 + sliding coral underline), `RightSidebar.tsx:84-104` (bg-raised + sliding underline), `GitChanges.tsx:150-156` (bg-raised only, no shared hook), `SettingsPage.tsx:86-102` (border-b-2, no hook), `WorkerSpawnModal.tsx:102-125` (bordered container + sliding pill); a `useSegmentIndicator` hook already exists but only 3 sites use it. **This is a consolidation — do it LAST since it touches files earlier tasks edited.**

**Files:**
- Create: `apps/desktop/src/renderer/ui/segment.tsx` (a shared `Segment` component)
- Modify: `views/Sessions.tsx`, `components/RightSidebar.tsx`, `components/GitChanges.tsx`, `components/SettingsPage.tsx`, `components/WorkerSpawnModal.tsx`
- Read: the existing `useSegmentIndicator` hook

- [ ] **Step 1: Build the shared component.** Create `ui/segment.tsx` exporting a `Segment` component with two visual variants: `underline` (navigation-tier, e.g. Sessions source tabs / SettingsPage categories) and `pill` (in-form selection, e.g. RightSidebar Files/Git/Worker, GitChanges, WorkerSpawnModal). Props: `{ items: {value,label}[], value, onChange, variant }`. Reuse the existing `useSegmentIndicator` hook internally. Keyboard: arrow keys move selection (role="tablist"/"tab" or radiogroup semantics).
- [ ] **Step 2: Migrate the 5 sites** to `<Segment variant=…>`, preserving each site's current tab set and behavior. Keep labels going through their existing i18n keys. Verify no visual regression to the active-item logic at each site.
- [ ] **Step 3: Test.** A `Segment` unit test: renders items, clicking/arrow-key changes selection via onChange, both variants render. Spot-check each migrated site's existing test still passes (some pin the active class). Run gate. Commit `fix(desktop): unify 5 ad-hoc segment controls into a shared Segment component (audit #52)`

---

## Final verification (after Task 10)

- [ ] `npm run typecheck && npm test` (root) and `npm -w apps/desktop run typecheck && npm -w apps/desktop test` — all green.
- [ ] Whole-branch review (fable) — feed it the ledger's rolled-up Minors + the deferred items (#46 auto-title, #47 reverse backlink if deferred, #51 design).
- [ ] Live visual checks (dockview #48/#49; plus the still-pending quick-wins live checks) in one `./scripts/dev.sh` session.
- [ ] Mark #42–#52 fixed in `docs/2026-07-03-desktop-uiux-audit.md` (status line under 요약).
