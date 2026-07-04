# Desktop UI/UX Low Wave (#53–#81) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 29 low-severity findings (#53–#81) from the 2026-07-03 desktop UI/UX audit — copy/wording, ko tone/terminology, state-feedback polish, and design-system convergence (shared ConfirmDialog/Button/Select, eyebrow tokens, a11y niceties).

**Architecture:** Renderer-only (`apps/desktop/src/renderer`). Mostly i18n-catalog edits and swapping ad-hoc markup for existing shared components; two small new shared pieces (a `ConfirmDialog` and a Button `danger` variant). No daemon changes.

**Tech Stack:** TypeScript, React 18, Zustand, Tailwind v4, vitest (jsdom).

## Global Constraints

- **Spec:** `docs/2026-07-03-desktop-uiux-audit.md`. Each task lists its finding numbers (`#N`) — the implementer MUST read those finding sections first (exact file:line evidence + the 제안/suggested fix).
- **Node 22 required** (`node -v` → v22.x first).
- **Branch:** all work on `uiux/low-wave` (already created from `main`). Commit per task.
- **i18n invariant:** every new/changed user-facing string in BOTH `apps/desktop/src/renderer/i18n/locales/ko/<ns>.ts` AND `en/<ns>.ts` (parity + used-keys tests enforce; `npm -w apps/desktop test` fails otherwise). Renaming/removing a key → update every `t("…")` call site (used-keys test catches strays). ko is source tone, **해요체**.
- **Terminology (AGENTS.md glossary):** fleet units are "worker/워커"; "agent/에이전트" is reserved for native nested subagents.
- **Code comments in English.**
- **Per-task gate:** `npm -w apps/desktop run typecheck && npm -w apps/desktop test` green. (No root `src/**` changes in this wave.)
- **Scope discipline:** fix ONLY the listed findings. Match surrounding style. No drive-by refactors.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 0: Branch verify

- [ ] **Step 1:** `git branch --show-current` → `uiux/low-wave`; `node -v` → v22.x.
- [ ] **Step 2:** Baseline `npm -w apps/desktop test` all green; record the count.

---

### Task 1: Copy & wording (#62, #63, #64, #69, #70, #71)

**Findings:** #62, #63, #64, #69, #70, #71. Read each in the audit. Mostly i18n-string edits + two tiny JSX changes (CommitView plural, eyebrow removal).

**Files:**
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/app.ts`, `repoTree.ts`, `automationPage.ts`, `automationModal.ts`, `repoModal.ts`, `commitView.ts`, `workerSpawnModal.ts`, `automationForm.ts`, `settings.ts` (as each finding requires)
- Modify: `apps/desktop/src/renderer/components/CommitView.tsx` (#70 plural branch)
- Modify: `apps/desktop/src/renderer/components/AutomationPage.tsx`, `SettingsPage.tsx` (#71 eyebrow)

- [ ] **Step 1 (#62):** Rewrite `app.sessionEndedRestart` (both locales) from data-jargon ("only diff/discard available") to real UI labels — en e.g. `"Worker ended by restart — view changes in the Git tab, delete from the right-click menu."`, ko `"재시작으로 종료된 워커 — Git 탭에서 변경을 확인하고, 우클릭 메뉴에서 삭제할 수 있어요."`. (worker/워커 terminology.)
- [ ] **Step 2 (#63):** Unify to "automation/자동화": `automationPage.newJob` → en `"New automation"` / ko `"새 자동화"`; `automationPage.empty` → en `"No automations yet."` / ko `"아직 자동화가 없어요."`. Leave `automationModal.titleNew`/`automationPage.title` as-is (already "automation/자동화").
- [ ] **Step 3 (#64):** Title Case en labels: `repoModal.register` `"register"`→`"Register"`; `workerSpawnModal.spawn` `"spawn"`→`"Spawn"`; make the `automationForm`/`settings`/`workerSpawnModal` effort label casing consistent (pick `"Effort"`); replace automationForm's `"— Model (default) —"` decorative-dash option with a plain default label (e.g. `"Default"` — do NOT hardcode a model name; read the current string). ko unaffected where these are English proper labels.
- [ ] **Step 4 (#69):** `repoModal.pathHint` (en) → `"The local path to a cloned git repo — workers operate in its worktree."` (ko: natural 해요체 equivalent). Placeholders `namePlaceholder`/`pathPlaceholder`/`descPlaceholder` → example values (en `"my-service"` / `"/Users/you/project"` / `"What this repo is for"`; ko natural). Keep both locales in sync.
- [ ] **Step 5 (#70):** `CommitView.tsx` — count===1 renders `"1 file"` not `"1 files"`. Add a singular key or branch: `commitView.filesOne`/`commitView.filesMany` (or an interpolated `{count}` with a plural helper if one exists — check the catalog). Section title order: en `"Changed files (1)"` form. Both locales.
- [ ] **Step 6 (#71):** AutomationPage/SettingsPage — where the eyebrow equals the page title (`AUTOMATION`/`Automation`, `SETTINGS`/`Settings`), remove the redundant eyebrow (or leave only the title). Verify the header still looks intentional (title alone). Do NOT touch SESSION/worker headers where eyebrow≠title.
- [ ] **Step 7:** Gate. Commit `fix(desktop): copy — worker-labeled restart hint, automation vs job, Title Case labels, repo hint, plural files, drop redundant eyebrows (audit #62,#63,#64,#69,#70,#71)`

---

### Task 2: ko tone & status i18n (#65, #66, #67, #68)

**Findings:** #65, #66, #67, #68.

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx` (#65 status footer)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/app.ts`, `settings.ts`, `dataConsent.ts`, `restartDaemonDialog.ts`, `gitChanges.ts`, `sessions.ts`, `workspaceHeaders.ts`, `notify.ts`, `conversation.ts` (as each finding requires)

- [ ] **Step 1 (#65):** The status footer (`App.tsx:~865-872`, may have drifted) hardcodes `daemon · ${s.daemon}` / `slack · ${s.slack}` in English. Route the daemon/slack status words through i18n keys. Reuse the existing `settings.slackUp/slackConnecting/slackError/slackOff/slackUnconfigured` labels for the slack suffix, and add `app.daemon*` keys for the daemon states (starting/up/down — read the actual daemon status union). Both locales; the `title` tooltip too.
- [ ] **Step 2 (#66):** Unify ko tone to 해요체 in `ko/dataConsent.ts` body, `ko/settings.ts` claudeAuthDesc/claudeApiKeyActive, `ko/restartDaemonDialog.ts` body, `ko/gitChanges.ts` revertDescUntracked/revertDescTracked. Remove within-sentence/within-pair 합니다체↔해요체 mixing. en unchanged.
- [ ] **Step 3 (#67):** ko "Working" → unify to "작업 중": `ko/app.ts` busyAddable `"처리 중…"` → `"작업 중… (메시지 추가 가능)"` (match sessions/workspaceHeaders which already say "작업 중"). en unchanged.
- [ ] **Step 4 (#68):** `ko/conversation.ts` pendingBadge `"대기 중"` → `"전송 대기"` (distinguish from notify.idle's "대기 중" = Idle). en unchanged.
- [ ] **Step 5:** Gate. Commit `fix(desktop): ko tone unified to 해요체, status footer localized, Working/Queued ko disambiguated (audit #65,#66,#67,#68)`

---

### Task 3: State & feedback polish (#53, #54, #55, #56, #80, #81)

**Findings:** #53, #54, #55, #56, #80, #81.

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx` (#53 slack toggle catch, #54 success toasts)
- Modify: `apps/desktop/src/renderer/components/SettingsPage.tsx` (#53 toggle loading, #81 Off pill)
- Modify: `apps/desktop/src/renderer/components/UsagePanel.tsx` (#55 skeleton, #56 account-wide title)
- Modify: `apps/desktop/src/renderer/components/CheckpointMenu.tsx` (#80 date)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/toast.ts`, `usagePanel.ts`, `settings.ts`
- Read: `apps/desktop/src/renderer/lib/relative-time.ts` (for #80)

- [ ] **Step 1 (#53):** The `slack.set` request in App.tsx (`~:906`) has no `.catch` (siblings do). Add `.catch(() => toast.error(tRef.current("toast.actionFailed")))`. In SettingsPage's slack toggle button, show a loading/disabled state between click and the `slack.status` event arriving (read how the toggle currently renders; a local `busy` flag cleared when the store's slack status changes, or the shared Button `loading`).
- [ ] **Step 2 (#54):** Add success toasts to the silent successes: repo remove (`~:598`), checkpoint restore (`~:605` — note Task-9 of a prior wave may already toast restore; verify current code before adding a duplicate), key save (`~:915-916`). Rule: "a success with no immediate on-screen change gets a toast." Add `toast.removed`/`toast.saved` keys (both locales) as needed; reuse existing keys where present.
- [ ] **Step 3 (#55):** `UsagePanel.tsx` — while `usage` is null (pre-load), render a skeleton placeholder (reuse `SkeletonRows` or a fixed-height stub) instead of `return null` (no pop-in). On sustained failure (the App.tsx usage.get catch), surface a small `usagePanel.loadFailed` hint. Both locales.
- [ ] **Step 4 (#56):** `UsagePanel.tsx` — clarify the numbers are account-wide: title/label `usagePanel.title` → en `"Claude usage (account-wide)"` / ko `"Claude 사용량 (계정 전체)"`, or add an info tooltip explaining the ccusage source. Both locales.
- [ ] **Step 5 (#80):** `CheckpointMenu.tsx` — the per-turn timestamps use `hhmm()` (time only), so entries across midnight look non-monotonic. When a checkpoint is from a different day than "today", prefix the date (e.g. `"어제 06:07 PM"` / `"7/2 18:07"`) or use `relativeTime`. Read `lib/relative-time.ts`; keep it simple. Both locales if new strings.
- [ ] **Step 6 (#81):** SettingsPage Slack status card — the coral `"Off"` pill next to `"Connected"` reads ambiguously (status vs action). Make the toggle an explicit switch OR relabel the action to `settings.turnOff` = en `"Turn off"` / ko `"끄기"` (and `"Turn on"`/`"켜기"`), so the action verb is distinct from the status word. Both locales.
- [ ] **Step 7:** Gate. Commit `fix(desktop): slack toggle failure/loading feedback, success toasts, usage skeleton + account-wide label, checkpoint dates, explicit slack toggle (audit #53,#54,#55,#56,#80,#81)`

---

### Task 4: Shared ConfirmDialog + Button variants (#72, #73, #78)

**Findings:** #72, #73, #78. This introduces a Button `danger` variant + a shared `ConfirmDialog`, then migrates the ad-hoc confirms (now 4+ hand-made sets across the codebase) and the first-run modals.

**Files:**
- Modify: `apps/desktop/src/renderer/ui/button.tsx` (add `danger` variant)
- Create: `apps/desktop/src/renderer/ui/confirm-dialog.tsx` (shared ConfirmDialog)
- Modify: `views/Sessions.tsx`, `views/RepoTree.tsx`, `components/GitChanges.tsx`, `components/FileTree.tsx` (migrate their destructive confirms), `components/AutomationPage.tsx` (AutomationDeleteConfirm — added in a prior wave), `components/TabCloseConfirm.tsx` (consider folding into ConfirmDialog if clean)
- Modify: `components/DataConsentModal.tsx`, `components/OnboardingModal.tsx` (#72 button/modal system)
- Modify: `components/GitChanges.tsx` (#78 Commit button)

- [ ] **Step 1 (#73a — Button danger variant):** Add a `danger` variant to `ui/button.tsx` (`bg-fail` solid, matching the app's fail token). Verify existing button tests still pass.
- [ ] **Step 2 (#73b — ConfirmDialog):** Extract a shared `ConfirmDialog` component (props: `title`, `body`, `confirmLabel`, `onConfirm`, `onCancel`, `variant?: "danger"|"default"`) modeled on the existing confirm dialogs (overlay + panel + `useModalKeys`/`useFocusTrap`/`useDismissTransition`, autofocused Cancel, **createPortal to document.body** — matching the just-fixed TabCloseConfirm so it's never clipped). Fixed panel padding/title size.
- [ ] **Step 3 (#73c — migrate):** Replace the hand-made confirm dialogs in Sessions/RepoTree/GitChanges/FileTree (and the prior-wave AutomationDeleteConfirm/RepoRemoveConfirm/TabCloseConfirm where it cleanly fits) with `<ConfirmDialog>`. Preserve each site's existing i18n strings + confirm callbacks. Destructive ones use `variant="danger"`. Keep tests meaningful — update assertions that pinned the old markup, don't gut them.
- [ ] **Step 4 (#72 — first-run modals):** DataConsentModal/OnboardingModal — replace their raw `<button>`s with `<Button variant="primary">` and align the overlay/panel classes with the other modals (`bg-black/55 backdrop-blur-sm` + the dialog-in/out animation). Do NOT change their a11y wiring (already fixed in a prior wave) or the DataConsent Escape-noop.
- [ ] **Step 5 (#78):** GitChanges Commit button → `<Button variant="primary" size="sm" className="w-full" loading={busy}>` (drops the raw coral). Preserve the disabled/busy behavior.
- [ ] **Step 6:** Gate — the confirm-dialog migrations have existing tests across Sessions/RepoTree/GitChanges/FileTree; run them. Commit `fix(desktop): shared ConfirmDialog + Button danger variant, first-run modals on the button system, Git commit button (audit #72,#73,#78)`

---

### Task 5: AutomationForm cleanup (#74, #75, #79)

**Findings:** #74, #75, #79.

**Files:**
- Modify: `apps/desktop/src/renderer/components/AutomationForm.tsx`
- Read: `apps/desktop/src/renderer/ui/input.tsx` (the shared `Select`), the overlay-header pattern in `SettingsPage.tsx`/`AutomationPage.tsx`/`NewSessionPage.tsx`

- [ ] **Step 1 (#74):** Replace the 6 raw `<select>` in AutomationForm (`~:186,244,260,276,319,355,369` — verify current lines) with the shared `<Select>` from `ui/input.tsx` (keep the `<option>` markup). Gains the coral focus ring + consistent padding.
- [ ] **Step 2 (#75):** AutomationForm header → match the overlay-header pattern (drag region `h-11 px-5` + mono eyebrow + lucide `X`/`ArrowLeft` close instead of the literal `"←"` glyph). Align the save-button placement with the sibling overlay pages (read SettingsPage/AutomationPage headers). If eyebrow text is needed, `automationForm.eyebrow` = `"Automation"`/ko — both locales (note Task 1 #71 removed redundant eyebrows where title==type; AutomationForm is a form overlay, not the Automation page, so a distinct eyebrow is fine — use judgment, state in report).
- [ ] **Step 3 (#79):** The bypassPermissions warning `text-yellow-500/80` (`~:288,400`) → the theme token `text-run/90` (or the Settings run-box style `border-run/40 bg-run/12`). Match `NewSessionPage.tsx`'s existing warning treatment.
- [ ] **Step 4:** Gate. Commit `fix(desktop): AutomationForm uses shared Select, standard overlay header, theme warning token (audit #74,#75,#79)`

---

### Task 6: a11y, discoverability & visual tokens (#57, #58, #59, #60, #61, #76, #77)

**Findings:** #57, #58, #59, #60, #61, #76, #77.

**Files:**
- Modify: `workspace/WorkspaceDock.tsx`, `store/layout.ts` (#57 reset layout)
- Modify: `components/NewSessionPage.tsx` (#58 empty-repo CTA)
- Modify: `components/OpenInAppMenu.tsx` (#59 label, #60 focus/arrows)
- Modify: `components/CheckpointMenu.tsx` (#60 focus/arrows)
- Modify: `components/ResourceMonitor.tsx` (#61 Escape)
- Modify: `views/Sessions.tsx`, `views/RepoTree.tsx` (#76 row scale)
- Modify: `globals.css` + eyebrow sites (#77 eyebrow utility)
- Read: `components/ContextMenu.tsx` (the focus/arrow-roving precedent for #60)

- [ ] **Step 1 (#57):** Add a "Reset layout" action (header control or dock-tab right-click) that calls `useLayoutStore.getState().clear_(pageKey)` then re-seeds the default template. i18n `workspaceHeaders.resetLayout` both locales.
- [ ] **Step 2 (#58):** `NewSessionPage.tsx` — when `repos.length === 0`, render an empty-state card in place of the (hidden) repo picker: `newSessionPage.noReposTitle`/`noReposBody` + a "Register repo…" button that opens the RepoModal. Both locales.
- [ ] **Step 3 (#59):** `OpenInAppMenu.tsx` — the icon+chevron split button gets a short text label (`"Open in"` + chevron) or an external-link overlay so it's identifiable. i18n if new string.
- [ ] **Step 4 (#60):** CheckpointMenu + OpenInAppMenu popups (role=menu) — on open, focus the first `menuitem` + add ArrowUp/Down roving (reuse ContextMenu.tsx's logic — read `:19,22-30`). Keep Escape.
- [ ] **Step 5 (#61):** ResourceMonitor popover — add an Escape keydown listener to close (mirror OpenInAppMenu's Escape), and move focus inside (to the Refresh button) on open.
- [ ] **Step 6 (#76):** Unify the sidebar list-row scale between Sessions and RepoTree — pick one set of tokens (e.g. text-12.5px, py, rounded-md) and apply to both views' rows + their rename inputs. Read both current row classes; converge minimally (worker tree may stay one step smaller only if intentional — prefer identical).
- [ ] **Step 7 (#77):** Promote an eyebrow utility (e.g. `.eyebrow-sm` = 10.5px/0.12em) in `globals.css`, and converge the scattered eyebrow micro-labels (Sessions/RepoTree/GitChanges/CommitView/NestedAgents/ResourceMonitor/AutomationForm/ToolBlock) to one or two steps. (Coordinate with Task 5's #75 AutomationForm eyebrow + Task 1's #71 removals — those already ran, so converge what remains.)
- [ ] **Step 8:** Gate. Commit `fix(desktop): reset-layout action, empty-repo CTA, open-in-app label, menu keyboard nav, ResourceMonitor Escape, sidebar row + eyebrow token convergence (audit #57,#58,#59,#60,#61,#76,#77)`

---

## Final verification (after Task 6)

- [ ] `npm -w apps/desktop run typecheck && npm -w apps/desktop test` — green.
- [ ] Whole-branch review (fable) — feed it the ledger's rolled-up Minors.
- [ ] Live visual spot-check (one `./scripts/dev.sh` session): the ConfirmDialog migration (centered, portaled), first-run modals, AutomationForm header/select, sidebar row consistency, usage-panel skeleton.
- [ ] Mark #53–#81 fixed in `docs/2026-07-03-desktop-uiux-audit.md` (status line under 요약).
