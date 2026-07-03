# Desktop UI/UX Quick Wins (#1–#41) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 41 quick-win findings (high/medium severity × S effort) from the 2026-07-03 desktop UI/UX audit — silent failures, false-empty states, destructive-action guards, discoverability, keyboard a11y, dock chrome, terminology/i18n, and visual drift.

**Architecture:** Renderer-heavy changes in `apps/desktop/src/renderer` (React 18 + Tailwind v4 + Zustand), one daemon-side ack addition (Task 1) and one main-process format change (Task 16). Every task replicates an existing in-repo pattern (cited per task) rather than inventing new ones.

**Tech Stack:** TypeScript, React 18, Zustand, Tailwind v4, vitest (jsdom for desktop, node for daemon), electron-vite.

## Global Constraints

- **Spec:** `docs/2026-07-03-desktop-uiux-audit.md`. Each task lists its finding numbers (`#N`) — the implementer MUST read those finding sections first (they contain exact file:line evidence and the in-repo pattern to copy).
- **Node 22 required** (`better-sqlite3` ABI 127). Verify with `node -v` → v22.x before anything.
- **Branch:** all work on `uiux/quick-wins` (created from `main` in Task 0). Commit per task.
- **i18n invariant:** every new user-facing string goes through i18n, added to BOTH `apps/desktop/src/renderer/i18n/locales/ko/<ns>.ts` AND `en/<ns>.ts` (parity + used-keys tests enforce this; `npm -w apps/desktop test` fails otherwise). ko is the source tone (해요체).
- **Code comments in English.**
- **Per-task gate:** `npm -w apps/desktop run typecheck && npm -w apps/desktop test` must pass. Tasks touching root `src/**` (Tasks 1, 16) additionally run `npm run typecheck && npm test` at the repo root.
- **Scope discipline:** fix ONLY the listed findings. Do not drive-by refactor. Match surrounding code style (single-line arrow handlers, terse comments).
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1:** `cd /Users/clover/workspace/clovot && git checkout -b uiux/quick-wins main`
- [ ] **Step 2:** `node -v` → must print v22.x. `npm -w apps/desktop test` → all green baseline.

---

### Task 1: Master send failure rollback (#1) — request() ack end-to-end

**Findings:** #1 (high). Pattern to copy: the worker path — `subSend` in `App.tsx` (~:555-565) + the `worker.send` ack added in commit `ad99bd7` (`git show ad99bd7` shows the daemon/protocol/client changes to mirror).

**Files:**
- Modify: `src/protocol/messages.ts` (session.send response mapping, mirroring worker.send)
- Modify: `src/daemon/connection.ts:169-178` (ack `session.send` with `{type:"ok", reqId}`; error frames carry `reqId`)
- Modify: `apps/desktop/src/renderer/store/store.ts` (add `dropPending`)
- Modify: `apps/desktop/src/renderer/App.tsx` (`send` ~:527-536, `startSession` inner send ~:520)
- Test: root `test/daemon/connection.test.ts` (or the file holding the `worker.send` ack test — put the new case beside it); `apps/desktop/test/store/store.test.ts` (or nearest store test)

**Interfaces:**
- Produces: `useStore.getState().dropPending(sid: string, clientMsgId: string)` — removes one entry from `pendingBySession[sid]`.

- [ ] **Step 1: Daemon ack (TDD).** Read `git show ad99bd7`. Write a failing daemon test: a `session.send` frame WITH `reqId` gets an ack reply carrying that `reqId`; a failing send (unknown session) gets an error reply carrying the `reqId`. Run it → FAIL.
- [ ] **Step 2:** Implement in `connection.ts` exactly like the worker.send ack (reply ok/err with `reqId` when present; keep fire-and-forget behavior when absent for old clients). Update `messages.ts` request/response mapping so the renderer's `RequestResultMap["session.send"]` typechecks. Root `npm test` + `npm run typecheck` → PASS.
- [ ] **Step 3: Store.** Add to `store.ts` (interface near line 90, impl near line 231, mirroring `dropWorkerPending`):

```ts
dropPending: (sid, clientMsgId) => set((s) => ({ pendingBySession: { ...s.pendingBySession, [sid]: (s.pendingBySession[sid] ?? []).filter((p) => p.clientMsgId !== clientMsgId) } })),
```

Add a store test: `pushPending` then `dropPending` leaves the session's pending list empty (and doesn't touch other sessions).
- [ ] **Step 4: App.tsx.** Convert both master send sites from `client?.send(...)` to (comment style copied from subSend):

```ts
void client?.request({ type: "session.send", sessionId: sid, text, model: ov.model, effort: ov.effort, permissionMode: ov.permissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan" | undefined, clientMsgId }).catch((e) => {
  useStore.getState().dropPending(sid, clientMsgId);
  toast.error(tRef.current("toast.sendFailed"), String(e));
});
```

(`startSession`'s inner send uses `sid`/`prompt`/`opts.model`/`opts.effort` and no permissionMode — keep its existing fields, only switch to `request()` + the same catch.)
- [ ] **Step 5:** Full gate (root + desktop typecheck/test). Commit: `fix(desktop,daemon): master session.send is acked; failed sends roll back the pending bubble with a toast (audit #1)`

---

### Task 2: Composer reliability — worker model/permission rollback (#6), Stop stays visible (#23)

**Findings:** #6, #23. Daemon already replies error+reqId for `worker.setModel`/`worker.setPermissionMode` (audit evidence connection.ts:382-390) — renderer-only task.

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx` (`subSetModel`, `subSetPermissionMode` ~:566-575)
- Modify: `apps/desktop/src/renderer/components/Composer.tsx:237-246`

- [ ] **Step 1 (#6):** Convert both setters to capture-prev → optimistic set → `request()` → rollback on catch:

```ts
const subSetModel = useCallback((id: string, model: string) => {
  const prev = useStore.getState().fleet[id]?.model;
  useStore.setState((st) => (st.fleet[id] ? { fleet: { ...st.fleet, [id]: { ...st.fleet[id], model } } } : {}));
  void client?.request({ type: "worker.setModel", id, model }).catch((e) => {
    // Rejected by the daemon → restore the previous value so the dropdown doesn't lie.
    useStore.setState((st) => (st.fleet[id] ? { fleet: { ...st.fleet, [id]: { ...st.fleet[id], model: prev } } } : {}));
    toast.error(tRef.current("toast.actionFailed"), String(e));
  });
}, []);
```

Same shape for `subSetPermissionMode` (field `permissionMode`, prev captured the same way). If `worker.setModel`/`worker.setPermissionMode` are missing from `RequestResultMap`, add them beside `worker.send` in the protocol mapping (ack already exists daemon-side).
- [ ] **Step 2 (#23):** In `Composer.tsx`, the current conditional renders Stop only when `busy && !text.trim()`. Change so Stop renders whenever `busy` (regardless of typed text), next to Send when text is present — Send keeps submitting, Stop keeps `onStop`. Preserve the existing square-icon Stop button markup; only the visibility condition and layout (two buttons side by side, Stop first) change.
- [ ] **Step 3:** Desktop typecheck + test. Manually reason through: busy+empty → Stop only; busy+text → Stop AND Send; idle → Send only. Commit: `fix(desktop): worker model/permission failures roll back; Stop stays visible while typing (audit #6, #23)`

---

### Task 3: Interaction card in-flight state (#12)

**Findings:** #12. `ui/button.tsx` has a `loading` prop (used elsewhere as `loading={busy}`).

**Files:**
- Modify: `apps/desktop/src/renderer/components/InteractionCard.tsx:30-85`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/interactionCard.ts`

- [ ] **Step 1:** Add local state `const [sent, setSent] = useState(false)`. All respond triggers (Approve/Deny/Submit) call `setSent(true)` before invoking `onRespond`. While `sent && !resolved`: option pills and buttons get `disabled`, the clicked action button gets `loading`, and a hint line `t("interactionCard.sending")` renders under the buttons. When the card's resolved summary state arrives (existing behavior) it replaces everything as before.
- [ ] **Step 2:** i18n both locales: `"interactionCard.sending": "응답 전송 중…"` / `"Sending response…"`.
- [ ] **Step 3:** Desktop gate. Commit: `fix(desktop): interaction card buttons lock with a sending state after the first click (audit #12)`

---

### Task 4: Automation UX — live inline errors (#4), delete confirm (#20), permanent entry point (#22)

**Findings:** #4, #20, #22. Confirm-dialog pattern to copy: session delete in `Sessions.tsx:318-324`.

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx` (automation onSubmit ~:928-939; delete handler ~:955; sidebar layout ~:840-883)
- Modify: `apps/desktop/src/renderer/components/AutomationForm.tsx:39,112-113,405-407`
- Modify: `apps/desktop/src/renderer/components/AutomationPage.tsx:98`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/automationPage.ts`

- [ ] **Step 1 (#4):** App's automation submit currently swallows: `.catch((e) => { toast.error(...) })`. Append `throw e;` inside that catch so `AutomationForm`'s own catch runs and sets `submitError`. In `AutomationForm`, move the `submitError` paragraph from the scroll-body bottom (~:405-407) to directly under the header action row (next to Save), so it's visible without scrolling.
- [ ] **Step 2 (#20):** `AutomationPage` delete button no longer calls `onDelete` directly — set `confirmDelete: Automation | null` state, render a confirm dialog (copy the Sessions.tsx delete-confirm markup: overlay + panel + rule name in body + Cancel(outline)/Delete(primary)) that calls `onDelete(a.id)` on confirm. i18n keys both locales: `automationPage.deleteConfirmTitle: "자동화 삭제" / "Delete automation"`, `automationPage.deleteConfirmBody: "'{name}' 규칙을 삭제할까요? 되돌릴 수 없어요." / "Delete the rule '{name}'? This can't be undone."`.
- [ ] **Step 3 (#22):** Move the Automation entry button out of the `{!showRepos && …}` block into the always-rendered sidebar area (place it beside/above the bottom Settings row, keeping its existing icon+label and `navigate({ overlay: "automation" })` handler). Sessions-tab-only "New session" button stays where it is.
- [ ] **Step 4:** Desktop gate. Commit: `fix(desktop): automation inline errors surface, delete asks confirmation, entry point is tab-independent (audit #4, #20, #22)`

---

### Task 5: New Session draft preservation (#5)

**Findings:** #5. Pattern: conversation composers already persist drafts via the drafts store (`ConversationPane.tsx:27-29` wires `initialText`/`onDraftChange`).

**Files:**
- Modify: `apps/desktop/src/renderer/components/NewSessionPage.tsx` (composer props)
- Modify: `apps/desktop/src/renderer/App.tsx` (`startSession` ~:503-526)

- [ ] **Step 1:** Read how `ConversationPane` wires drafts (store key per session). Wire `NewSessionPage`'s composer identically with the fixed key `"newSession"`: `initialText={draft}`, `onDraftChange={(v) => setDraft("newSession", v)}` (exact store API names from the drafts store — read `store/drafts.ts` first).
- [ ] **Step 2:** In `startSession`, clear the `"newSession"` draft ONLY in the `.then` success path (after `session.send` dispatch). On failure the existing toast fires and the draft survives — reopening New Session restores the prompt.
- [ ] **Step 3:** Desktop gate + a store-level test if `drafts.ts` has a test file (set → clear → get returns empty). Commit: `fix(desktop): new-session prompt drafts persist and survive create failures (audit #5)`

---

### Task 6: First-run modals — failure feedback + modal a11y (#7, #25, #26)

**Findings:** #7, #25, #26. Pattern: `RepoModal.tsx:26-37` (useFocusTrap + useModalKeys + role=dialog + aria-modal + autoFocus).

**Files:**
- Modify: `apps/desktop/src/renderer/components/DataConsentModal.tsx`
- Modify: `apps/desktop/src/renderer/components/OnboardingModal.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx:1134-1147` (Accept/onFinish handlers)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/dataConsent.ts`, `{ko,en}/onboarding.ts` (namespace file names may differ — follow existing keys' location)

- [ ] **Step 1 (#7):** Change App's handlers to RETURN the promise instead of swallowing: `onAccept={() => c.request({ type: "settings.set", settings: { hasAcceptedDataNotice: "1" } })}` (same for onboarding finish). In each modal: `const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);` — click handler sets busy, awaits the returned promise, on catch sets `err` and re-enables. Accept/Get-started buttons get `loading={busy}`. Render `err && <p className="text-[12px] text-fail">{t("dataConsent.saveFailed")}</p>` (match the app's error-text idiom; check `text-fail` token exists in `globals.css`, else use the token the toasts use).
- [ ] **Step 2 (#25, #26):** Bring both modals up to the RepoModal contract: `role="dialog" aria-modal="true" aria-labelledby={titleId}` on the panel, `useFocusTrap(panelRef)`, autoFocus on the primary button. OnboardingModal additionally wires `useModalKeys` (Enter → Next/Get started, Escape → Skip). DataConsentModal deliberately does NOT close on Escape (blocking gate — keep, with a comment).
- [ ] **Step 3:** i18n both locales: `saveFailed: "저장하지 못했어요 — 다시 시도해주세요." / "Couldn't save — please try again."` in each modal's namespace.
- [ ] **Step 4:** Desktop gate. Commit: `fix(desktop): first-run modals get failure feedback and the standard dialog a11y contract (audit #7, #25, #26)`

---

### Task 7: Settings feedback — key save toast + auth refetch (#8), saved-secret placeholders (#41), checking states (#15)

**Findings:** #8, #41, #15. Pattern for refetch-after-save: the Linear key path (`App.tsx:910-913`).

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx` (~:906-916, :427-428)
- Modify: `apps/desktop/src/renderer/components/SettingsPage.tsx` (:206,333 secret fields; :274-320 status cards)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/settings.ts`, `{ko,en}/toast.ts`

- [ ] **Step 1 (#8):** In the handler that saves `anthropicApiKey` (and the Slack token save path), after `settings.set` resolves: `toast.success(tRef.current("toast.keySaved"))` and re-request `auth.status` → `setAuthStatus` (copy the Linear refetch shape at :910-913). i18n: `toast.keySaved: "키를 저장했어요" / "Key saved"`.
- [ ] **Step 2 (#41):** Slack token inputs: when Slack is configured (the page already receives slack status props; treat any status other than `"unconfigured"` as configured), placeholder becomes `t("settings.secretSaved")` instead of `xoxb-…`/`xapp-…`. i18n: `settings.secretSaved: "저장됨 — 교체하려면 새 값을 입력하세요" / "Saved — enter a new value to replace"`.
- [ ] **Step 3 (#15):** Where `integrations`/`authStatus` are `null` (still loading or failed), render a neutral dot + `t("settings.checking")` instead of "auth needed"/"No auth active". i18n: `settings.checking: "확인 중…" / "Checking…"`.
- [ ] **Step 4:** Desktop gate. Commit: `fix(desktop): settings key saves confirm + refresh auth, saved secrets look saved, unknown status reads as checking (audit #8, #41, #15)`

---

### Task 8: Settings unsaved-changes guard (#18)

**Findings:** #18. `dirty` already computed at `SettingsPage.tsx:41`.

**Files:**
- Modify: `apps/desktop/src/renderer/components/SettingsPage.tsx` (:67-69 onClose path)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/settings.ts`

- [ ] **Step 1:** Intercept the header X (and the Escape handler if the page has one): if `dirty`, open a local confirm dialog (same overlay/panel idiom as Task 4's) with three actions — `t("settings.confirmSave")` (primary: run the existing save then close), `t("settings.confirmDiscard")` (outline: close without saving), `common.cancel` (ghost: stay). If not dirty, close as before. (Sidebar-navigation interception is out of scope — the audit's core case is the in-page close affordances.)
- [ ] **Step 2:** i18n both locales: `settings.unsavedTitle: "저장 안 된 변경이 있어요" / "You have unsaved changes"`, `settings.unsavedBody: "이대로 닫으면 변경 내용이 사라져요." / "Closing now will discard your edits."`, `settings.confirmSave: "저장하고 닫기" / "Save & close"`, `settings.confirmDiscard: "버리고 닫기" / "Discard & close"`.
- [ ] **Step 3:** Desktop gate. Commit: `fix(desktop): settings warns before discarding unsaved changes (audit #18)`

---

### Task 9: Checkpoint flows — revert feedback (#9), fetch-error state (#16), unified loading (#17)

**Findings:** #9, #16, #17. `Skeleton.tsx` provides `SkeletonRows`.

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx` (`fetchCheckpoints`, `onRestore`)
- Modify: `apps/desktop/src/renderer/components/CheckpointMenu.tsx`
- Modify: `apps/desktop/src/renderer/components/CommitView.tsx:29`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/checkpointMenu.ts`, `{ko,en}/toast.ts`

- [ ] **Step 1 (#16):** `fetchCheckpoints` currently ends `.catch(() => [])` — remove the catch so the promise REJECTS. `CheckpointMenu` distinguishes three states: `items === null` (loading → `SkeletonRows`), fetch rejected (`error` state → `t("checkpointMenu.loadFailed")` + a retry button that re-calls the fetch), `items.length === 0` (keep the existing empty copy). i18n: `checkpointMenu.loadFailed: "목록을 불러오지 못했어요 — 다시 시도" / "Couldn't load checkpoints — retry"`.
- [ ] **Step 2 (#9):** `onRestore` returns the promise: on success `toast.success(tRef.current("toast.restored"))`; CheckpointMenu's confirm button awaits it with `loading` while pending, closing only after settle. i18n: `toast.restored: "체크포인트로 되돌렸어요" / "Restored to checkpoint"`.
- [ ] **Step 3 (#17):** Replace bare `Loading…` text in `CheckpointMenu` and `CommitView` with `SkeletonRows` (same props as `GitChanges.tsx:165` uses). (`findingWorkDir` is handled in Task 11.)
- [ ] **Step 4:** Desktop gate. Commit: `fix(desktop): checkpoint fetch/restore get real loading, error, and success states (audit #9, #16, #17)`

---

### Task 10: Editor & file-ops feedback (#10, #11, #13)

**Findings:** #10, #11, #13.

**Files:**
- Modify: `apps/desktop/src/renderer/components/MonacoEditor.tsx:49-52,98-99`
- Modify: `apps/desktop/src/renderer/components/FileTree.tsx:46-52,113-144,178-179`
- Modify: `apps/desktop/src/renderer/components/OpenInAppMenu.tsx:45-52`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/monacoEditor.ts`, `{ko,en}/fileTree.ts`

- [ ] **Step 1 (#10):** `MonacoEditor` gains a distinct `saveError` banner state (write failure sets it; any successful save clears it): copy the existing banner markup, text `t("monacoEditor.saveError")`, plus a retry button that re-runs the save. i18n: `"저장하지 못했어요 — 편집 내용이 디스크에 반영되지 않았어요" / "Couldn't save — your edits are not on disk"` + `saveRetry: "다시 저장" / "Retry save"`.
- [ ] **Step 2 (#11):** Wrap `submitName`/`confirmTrash` fs awaits in try/catch → `toast.error(t("fileTree.opFailed"), String(e))`; `OpenInAppMenu`: stop swallowing — check the `{ok:false}` return AND catch, both → `toast.error(t("fileTree.openFailed"))`. i18n: `fileTree.opFailed: "파일 작업에 실패했어요" / "File operation failed"`, `fileTree.openFailed: "폴더를 열 수 없어요" / "Couldn't open the folder"`. (FileTree/OpenInAppMenu already receive or can import the toast helper — follow how sibling components toast.)
- [ ] **Step 3 (#13):** FileTree tracks root-load state: `list()` no longer `.catch(() => [])` — loading renders `SkeletonRows`, failure renders `t("fileTree.loadFailed")` + retry, and only a successful empty result shows `emptyFolder`. i18n: `fileTree.loadFailed: "목록을 불러오지 못했어요 — 다시 시도" / "Couldn't read this folder — retry"`.
- [ ] **Step 4:** Desktop gate. Commit: `fix(desktop): editor save and file operations stop failing silently; FileTree distinguishes loading/error/empty (audit #10, #11, #13)`

---

### Task 11: Orphaned worker dead-end (#2)

**Findings:** #2 (high). Evidence: `RightSidebar.tsx:49-67,107-108`, `App.tsx:241-251,655,694-695`.

**Files:**
- Modify: `apps/desktop/src/renderer/components/RightSidebar.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx` (resolve-root retry + the `findingWorkDir` consumers)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/rightSidebar.ts`

- [ ] **Step 1:** The work-root resolver (300ms × 15 retries) gains an explicit outcome: on retry exhaustion OR when the worker's fleet status is terminal (`stopped | done | error | failed | orphaned`), set a `workdirMissing` state instead of silently staying in `findingWorkDir`.
- [ ] **Step 2:** Files/Git panels render for `workdirMissing`: `t("rightSidebar.workdirMissing")` — `"워크트리를 찾을 수 없어요 — 이미 삭제되었거나 재시작으로 세션이 종료됐어요." / "Work folder not found — it was deleted or the session ended on restart."` While genuinely still resolving, show `SkeletonRows` (replaces the bare `findingWorkDir` static text; finding #17's third case).
- [ ] **Step 3:** Desktop gate + a component test if `RightSidebar` has one (terminal status → message rendered). Commit: `fix(desktop): orphaned workers show 'work folder missing' instead of locating forever (audit #2)`

---

### Task 12: List fetch failures & filter losing the active session (#14, #21)

**Findings:** #14, #21.

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx:420-429` (initial list requests)
- Modify: `apps/desktop/src/renderer/store/store.ts` (loaded/error flags)
- Modify: `apps/desktop/src/renderer/views/Sessions.tsx:170-185,264`
- Modify: `apps/desktop/src/renderer/views/RepoTree.tsx:158`
- Modify: `apps/desktop/src/renderer/components/AutomationPage.tsx:70-74`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/sessions.ts` (or the shared ns the sidebars use — follow where `emptyState` keys live)

- [ ] **Step 1 (#14):** The initial `session.list` / `fleet.list` / `automation.list` requests replace `.catch(() => {})` with setting a per-domain `loadFailed` store flag. Sessions/RepoTree: when `loadFailed && !loaded`, render an inline error row `t("sessions.loadFailed")` + retry button that re-fires the request (and clears the flag). AutomationPage: add the same `loaded` gate the sidebars have — skeleton before load, `empty` copy only after a successful load.
- [ ] **Step 2 (#21):** `Sessions.tsx` visible computation: always include the active session even when the source filter would exclude it — `const visible = grouped.filter(...) …` gains `|| s.id === activeId`. Apply at the filter site (~:170-185) so grouping/date sections still work.
- [ ] **Step 3:** i18n both locales: `loadFailed: "목록을 불러오지 못했어요" / "Couldn't load the list"`, `retry: "다시 시도" / "Retry"` (reuse `common.*` retry if one exists — check `common.ts` first).
- [ ] **Step 4:** Desktop gate. Commit: `fix(desktop): initial list failures surface with retry; active session never hidden by the filter (audit #14, #21)`

---

### Task 13: RepoTree affordances — spawn entry (#3), repo-remove confirm (#19)

**Findings:** #3 (high), #19. Pattern: `Sessions.tsx:227` (`group-focus-within` reveal); worker-delete confirm `RepoTree.tsx:196-202`.

**Files:**
- Modify: `apps/desktop/src/renderer/views/RepoTree.tsx:124-133`
- Modify: `apps/desktop/src/renderer/App.tsx` (`onRemoveRepo` toast)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/repoTree.ts`, `{ko,en}/app.ts`, `{ko,en}/toast.ts`

- [ ] **Step 1 (#3):** The repo-header `+` (add worker) and trash (remove repo) buttons: replace `hidden group-hover:flex` with `flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100` so they stay in the layout and tab order, and add `aria-label={t("repoTree.spawnWorker")}` / `aria-label={t("repoTree.removeRepo")}`. i18n: `repoTree.spawnWorker: "워커 스폰…" / "Spawn worker…"`, `repoTree.removeRepo: "레포 등록 해제" / "Unregister repo"`.
- [ ] **Step 2 (#3):** Empty-state copy mentions the entry point — update BOTH locales of `repoTree.emptyState` and `app.emptyRepoHint` to reference the `+` button (e.g. ko: "레포 헤더의 + 버튼으로 워커를 스폰할 수 있어요"; en: "Use the + button on a repo header to spawn a worker"). (Worker/agent wording is unified in Task 15 — write these new strings with "worker/워커" now.)
- [ ] **Step 3 (#19):** Repo remove gets the same confirm dialog as worker delete (copy `RepoTree.tsx:196-202` markup; body explains files stay on disk): `repoTree.removeConfirmBody: "'{name}' 레포 등록을 해제할까요? 파일은 그대로 남아요." / "Unregister '{name}'? Files on disk are untouched."`. On success `toast.success(t("toast.repoRemoved"))` — `"레포 등록을 해제했어요" / "Repo unregistered"`.
- [ ] **Step 4:** Desktop gate. Commit: `fix(desktop): spawn/remove repo affordances are discoverable and keyboard-reachable; remove asks confirmation (audit #3, #19)`

---

### Task 14: Keyboard reveal & spawn-modal search keys (#24, #27)

**Findings:** #24, #27. Patterns: `Sessions.tsx:227` (focus reveal), `PromptEditor.tsx:116-121` (arrow-key list navigation).

**Files:**
- Modify: `apps/desktop/src/renderer/components/TerminalPanel.tsx:46`, `components/TabBar.tsx:36`, `workspace/RookeryTab.tsx:45`
- Modify: `apps/desktop/src/renderer/components/WorkerSpawnModal.tsx:173-191`

- [ ] **Step 1 (#24):** The three close-X buttons: append `group-focus-within:opacity-100 focus-visible:opacity-100` to their `opacity-0 group-hover:opacity-100` class strings.
- [ ] **Step 2 (#27):** WorkerSpawnModal search: add `highlight` index state; input `onKeyDown` handles ArrowDown/ArrowUp (move highlight, clamp to results length) and Enter (pick highlighted result — same handler the button click uses); result buttons use `onMouseDown={(e) => e.preventDefault()}` before their click so clicking doesn't blur-close the list first; highlighted row gets the same bg class as its hover state.
- [ ] **Step 3:** Desktop gate. Commit: `fix(desktop): hover-only close buttons reveal on focus; spawn search is keyboard-operable (audit #24, #27)`

---

### Task 15: Terminology & i18n sweep (#31, #32, #33, #34, #36)

**Findings:** #31, #32, #33, #34, #36. Rule (AGENTS.md): fleet units are "worker/워커"; "agent/에이전트" only for native nested subagents.

**Files:**
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/repoTree.ts`, `app.ts`, `interactionCard.ts`, `assistantMessage.ts`, `rightSidebar.ts`, `workspaceHeaders.ts`, `nestedAgents.ts`, `settings.ts`, `newSessionPage.ts`, `automationPage.ts` (as each key requires)
- Modify: `apps/desktop/src/renderer/workspace/panels.tsx:30`
- Modify: `apps/desktop/src/renderer/lib/models.ts:12` + effort-select render sites (`SettingsPage.tsx:142,260`, `Composer.tsx`, `WorkerSpawnModal.tsx` — wherever `EFFORTS` is mapped to options)
- Modify: `apps/desktop/src/renderer/components/SettingsPage.tsx:65`, `AutomationPage.tsx:61`, `NewSessionPage.tsx:56`, `views/NestedAgents.tsx:17` (eyebrow class/i18n)

- [ ] **Step 1 (#31):** Rewrite worker-wording keys in BOTH locales: `repoTree.emptyState` ("spawning agents"→"spawning workers" / "에이전트를"→"워커를"), `app.agentEndedReadonly` ("Agent ended"→"Worker ended" / "종료된 에이전트"→"종료된 워커"), `interactionCard.askPrompt` + `assistantMessage.copyMessage` (agent→assistant/master as contextually correct — read the strings, keep meaning).
- [ ] **Step 2 (#32):** Unify the nested panel name to "Nested agents / 중첩 에이전트": `rightSidebar.segmentWorker`, `workspaceHeaders.rightPanelTitle`, `nestedAgents.title`. Replace the hardcoded `'No nested agents.'` in `panels.tsx:30` with `t("rightSidebar.noNestedAgents")` (key exists; wire `useT` per the file's other components).
- [ ] **Step 3 (#33):** Effort display labels via i18n: add `common.effortLow/Medium/High/Xhigh/Max` = ko `낮음/보통/높음/매우 높음/최대`, en `Low/Medium/High/Extra high/Max`. Add a helper in `lib/models.ts`: `export const effortLabelKey = (e: string) => "common.effort" + e[0].toUpperCase() + e.slice(1)` and use `t(effortLabelKey(ef))` at every effort `<option>`/chip render site (Settings ×2, Composer, WorkerSpawnModal, AutomationForm — grep `EFFORTS` for the full list).
- [ ] **Step 4 (#34):** `ko/settings.ts`: `defaultFolderDesc` "New Session에서"→"새 세션에서"; `workerModelEffort` "워커 기본 모델 / effort"→"워커 기본 모델 / 강도"; `botName` "에이전트 네임"→"에이전트 이름".
- [ ] **Step 5 (#36):** Eyebrows: add the `.eyebrow` class where missing (`SettingsPage.tsx:65`, `AutomationPage.tsx:61`, `NestedAgents.tsx:17`) and route the strings through i18n keys (`settings.eyebrow: "Settings"/"설정"` etc. — en keeps English, ko gets Korean; the `:lang(ko) .eyebrow` CSS already neutralizes uppercase). `NewSessionPage`: add a localized title span `t("newSessionPage.title")` = `"새 세션" / "New session"` beside the eyebrow.
- [ ] **Step 6:** Desktop gate — the parity/used-keys tests are the real check here. Commit: `fix(desktop): worker/agent terminology, effort labels, ko copy purity, eyebrow consistency (audit #31–#34, #36)`

---

### Task 16: Git History relative time follows app locale (#35)

**Findings:** #35. `%cr` → `%ct` + renderer `lib/relative-time.ts` (already exists with an i18n catalog).

**Files:**
- Modify: `apps/desktop/src/main/workspace-manager.ts:329` (+ its type for log entries)
- Modify: `apps/desktop/src/renderer/components/GitHistory.tsx`
- Test: the existing workspace-manager test (TDD'd with injectable exec — extend it)

- [ ] **Step 1 (TDD):** Update the workspace-manager test: `gitLog` returns entries whose `when` is a unix epoch number parsed from `%ct` (fake exec returns a fixed format line). Run → FAIL.
- [ ] **Step 2:** Change the `git log` format string from `%cr` to `%ct`, parse to `Number`, rename the field if it was `rel`/`when` accordingly (follow the existing type through preload typings). Run → PASS.
- [ ] **Step 3:** `GitHistory.tsx` renders `relativeTime(t, epochSeconds * 1000)` (check `lib/relative-time.ts`'s expected unit first). Desktop gate. Commit: `fix(desktop): git history timestamps follow the app locale (audit #35)`

---

### Task 17: Visual polish — tooltip CJK (#37), dialog hierarchy (#38), disabled primary (#39), status footer wrap (#40)

**Findings:** #37, #38, #39, #40.

**Files:**
- Modify: `apps/desktop/src/renderer/components/Tooltip.tsx:22-28`
- Modify: `apps/desktop/src/renderer/components/RestartDaemonDialog.tsx:32`, `RunAutomationDialog.tsx:61`, `FileTree.tsx:239`
- Modify: `apps/desktop/src/renderer/ui/button.tsx:11`
- Modify: `apps/desktop/src/renderer/App.tsx:864-871`

- [ ] **Step 1 (#37):** Tooltip bubble class: add `w-max max-w-[220px]` (keeps shrink-to-fit from collapsing to the trigger width; Korean labels stop wrapping per-character).
- [ ] **Step 2 (#38):** The three confirm buttons missing a variant get `variant="primary"` explicitly.
- [ ] **Step 3 (#39):** `ui/button.tsx` primary variant: override the global 40% fade with a real disabled treatment — append `disabled:bg-raised disabled:text-muted disabled:opacity-100` (verify the exact bg/text token names against `globals.css`/other usages before writing; the intent is a grey fill that no longer reads as pressable coral).
- [ ] **Step 4 (#40):** Each daemon/slack status item in the footer becomes `<span className="inline-flex items-center gap-1 whitespace-nowrap">dot·label·value</span>` so an item never line-breaks internally; the row may still wrap BETWEEN items.
- [ ] **Step 5:** Desktop gate. Commit: `fix(desktop): tooltip CJK width, dialog action hierarchy, disabled primary, status footer wrapping (audit #37–#40)`

---

### Task 18: Dock chrome — diff tab labels (#28), live-localized titles (#29), collapsed empty terminal (#30)

**Findings:** #28, #29, #30. (Kept last: touches the dock layout persistence — verify by running the app if anything looks off in tests.)

**Files:**
- Modify: `apps/desktop/src/renderer/store/workspace.ts:34,42`
- Modify: `apps/desktop/src/renderer/workspace/RookeryTab.tsx:20,38-39`, `components/TabBar.tsx` (label span)
- Modify: `apps/desktop/src/renderer/workspace/WorkspaceDock.tsx:30-53`, `workspace/default-template.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/app.ts` (diff suffix key if localized)

- [ ] **Step 1 (#28):** `openDiff` sets `title: basename(path) + " (diff)"` (keep `openFile` as-is). Both tab renderers add `title={fullPathTooltip}` on the label span (file path + kind) so hover disambiguates. If tab titles flow through i18n anywhere, add `app.diffSuffix: "(diff)"/"(diff)"` — otherwise a literal suffix in `workspace.ts` is fine (it's a filename-adjacent technical label).
- [ ] **Step 2 (#29):** `RookeryTab` renders fixed-panel labels live: when `params.kind` identifies a fixed panel (conversation/terminal/files/git/nested), label = `t(kindToKey(kind))` (reuse the exact keys `WorkspaceDock.titleFor` uses) instead of the persisted `api.title`; editor/diff/commit tabs keep `api.title`. This makes locale switches apply to restored layouts without migrating persisted JSON.
- [ ] **Step 3 (#30):** Terminal panel seeds collapsed when the page has no terminals: in `WorkspaceDock` (and `default-template.ts` if the height lives there), initial height = `40` when `term` layout for the page has no open terminals, `220` otherwise; when the first terminal opens (existing `+`/tab path), call the dockview API to set the group height to `220`. Read the dockview group-resize API used elsewhere in the file (or `setSize` on the panel's group) — follow how the dock already programmatically sizes, and keep the persisted-layout path untouched (only the SEED path changes).
- [ ] **Step 4:** Desktop gate. Commit: `fix(desktop): diff tabs are distinguishable, dock titles re-localize, empty terminal seeds collapsed (audit #28–#30)`

---

## Final verification (after Task 18)

- [ ] `npm run typecheck && npm test` (root) and `npm -w apps/desktop run typecheck && npm -w apps/desktop test` — all green.
- [ ] Launch the app (`./scripts/dev.sh` or root build + `npm -w apps/desktop run dev`) and spot-check the three high findings live: master send failure rollback (#1 — kill daemon mid-send), orphaned worker panels (#2), spawn `+` visibility/focus (#3).
- [ ] Update `docs/2026-07-03-desktop-uiux-audit.md` inventory: mark #1–#41 as fixed (add a `상태` note or a "Fixed in `uiux/quick-wins`" line under 요약).
