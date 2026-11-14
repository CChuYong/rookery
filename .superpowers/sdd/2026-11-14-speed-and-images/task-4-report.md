# Task 4 — desktop image inputs and replayable previews

Implemented against accepted Task 3 base `7e49548` in the managed `feat/speed-and-images` worktree. All commands used Node 22. No user daemon/home was used, no live provider was invoked, and the controller-owned `/tmp/rookery-speed-images-fixtures` server/launcher was not modified.

## Delivered behavior

- The shared Composer imports images through native selection, browser drop and clipboard. Mixed clipboard text is preserved, ordinary selected/dropped files remain `@path` chips, and merely mentioning a path never uploads it. Native IPC has no renderer-supplied read path: it selects the file in main, checks size/type, opens without following symlinks and bounds the read allocation. Renderer upload validation precedes any image pixel decode. Supported type, file/count/total, dimensions/quota, and generic import failures have ko/en copy.
- Inline previews include filename/dimensions and accessible removal. Imports and acceptance are gated; image-only input is valid. Client slash actions cannot consume a draft while silently discarding its images. Generation/unmount guards discard late import completions; closing Side during preparation keeps the source draft and closes a late prepared Side.
- Existing/new Master, Worker follow-ups, Side start/follow-ups and both App layout branches pass one complete text+refs input. Speed controls and their accounting semantics remain in place. Composer clears after queue acceptance, while a running prior model turn continues and a new follow-up draft can be entered.
- Draft schema v2 migrates legacy strings to `{text, images}`. Both migration and same-version hydration validate references, and writes strip non-reference image fields. Successful asynchronous sends clear only their original draft revision; failures and navigation retain the exact input without populating another target.
- Committed and pending images render from reference-only metadata. Historical thumbnails issue `image.get` only near the viewport, release offscreen component data, and share a bounded 24 MiB data-URL LRU with request coalescing. Missing/decode errors have an explicit retry placeholder. No arbitrary remote URL is executed.

## Narrow backend integration, approved by the controller

The old `session.send` reply awaited the whole model turn. Awaiting that reply to clear a Composer would prevent follow-up composition while a previous turn runs. `MasterAgent.enqueueTurn` now validates and synchronously inserts the turn into the existing serialized chain, returning a completion promise. Connection acknowledges only after that acceptance boundary and consumes the later rejection; execution errors remain persisted/visible events. Existing `runTurn` callers retain execution-completion semantics. The two Connection tests which previously treated acceptance as completion now explicitly wait for their execution events.

Worker user message data now persists optional `clientMsgId`, in addition to the live wrapper. Master and Worker replay retain distinct consecutive image-only inputs, including repeated use of the exact same ref, and reconcile the appropriate pending IDs.

Queued assets can become unreadable after acceptance but before their echo. Such Master/Worker errors now persist optional correlated `retryInput {text, images?}` (refs only), so a reconnect with no local pending state still has the original retryable input. Live reducers remove the matching pending entry. Worker stream failure also retains the remaining deferred instructions as correlated failure evidence. A real Worker in terminal `error` rejects `send`; the desktop therefore offers **Restore draft** plus its existing **Recover worker** action for read-only terminal targets instead of repeatedly sending against a terminated Worker. Internal model/effort/capability resolution is inside the Master's error-reporting scope.

This does not introduce a durable server work queue: existing intentional stop/cap cancellation and daemon-restart queue-loss semantics remain. Native image assets remain indefinitely retained as defined by Task 3. A missing asset must be reattached; recovering a Worker does not recreate its bytes.

## Evidence

Initial RED command, before implementation:

`npm -w apps/desktop test -- test/composer-images.test.tsx test/drafts.test.ts test/store-pending.test.ts`

Result: **3 failed / 19 passed**. The migration API was absent; the initial two Composer assertions also used the wrong localized Send label, corrected before GREEN. Log: `/tmp/task4-red.log`. To independently confirm the intended behavioral regressions, the accepted base Composer (`git show 7e49548:…/Composer.tsx`) was later loaded as a temporary test-only module with the correct label: both image-only dispatch and rejected-request retention failed as expected (**2 failed**, `/tmp/task4-red-behavior.log`). Both temporary files were removed immediately. This later baseline confirmation is regression evidence, not an additional pre-implementation TDD run.

Behavior coverage added/extended:

- `composer-images.test.tsx`: native picker bytes and ordinary paths, mixed drop/paste, early type/file/count/total rejection, removal, in-flight import gating, image-only send, failed retry, target navigation, blocked client slash actions, Master/Worker Side failure retention, new Master creation failure retention, Side follow-up, immediate post-acceptance follow-up while busy, terminal Worker draft/recovery, and closing Side while it prepares.
- `message-images.test.tsx`: no historical fetch before viewport entry, offscreen release, missing fetch retry, and LRU eviction/refetch.
- `selected-attachment.test.ts`: real temporary files, bounded size rejection, symlink rejection, and ordinary path preservation.
- `drafts.test.ts` / `store-pending.test.ts`: migration, reference-only storage, newer identical draft revision protection, same-ref consecutive IDs live/replayed, and Master/Worker correlated failed inputs with and without local pending state.
- `test/daemon/desktop-image-acceptance.test.ts`: real Connection, desktop WsClient, SQLite, ImageStore and fake provider; early acceptance while the first provider turn is blocked, serialized subsequent inputs, invalid refs rejected before acceptance, and a queued deleted asset replayed as retryable failure evidence.
- `test/core/image-transport.test.ts`: real Worker deferred resolution failure retains retry refs and terminal send rejects, explaining the UI recovery path.

Final results:

| Check | Result | Log |
| --- | --- | --- |
| Full desktop suite | **152 files / 1188 tests passed** | `/tmp/task4-final-desktop-suite.log` |
| Full root suite | **116 files / 1457 tests passed** | `/tmp/task4-root-full.log` |
| Final focused desktop image/draft/replay checks | **4 files / 46 tests passed** (then Side-cancel case added: Composer **19 passed**) | `/tmp/task4-final-focused.log`, `/tmp/task4-side-cancel.log` |
| Final real Connection/Worker checks | **2 files / 9 tests passed** | `/tmp/task4-final-core-focused.log` |
| Root typecheck/build | Passed | `/tmp/task4-final-root-typecheck.log`, `/tmp/task4-final-root-build.log` |
| Desktop typecheck/build | Passed | `/tmp/task4-final-desktop-typecheck.log`, `/tmp/task4-final-desktop-build.log` |
| Whitespace | `git diff --check` passed | command output |

Vitest continues to print existing React act/jsdom canvas warnings in some component suites; no test failures or unhandled promise rejections remain.

## Reproducible isolated UI entry

`scripts/demo/images/README.md` documents the synthetic server, fixture data and native Electron launcher. It defaults to temporary fixture state and a dedicated port, ignores ambient `ROOKERY_HOME`/`ROOKERY_PORT`, overrides Electron userData/sessionData, strips provider secrets, disables daemon fallback, and verifies the exact fixture health marker/directory before importing app main. It supports image upload/get, Master/Worker sends, Side and reference history, without provider calls.

The portable fixture itself was smoke-tested at `/tmp/task4-portable-smoke`, port 18989: upload accepted, image-only send acknowledged, and history contained refs without base64. Its exact server PID was stopped afterward. Log: `/tmp/task4-fixture-server.log`. This is protocol/fixture evidence, not a claim of visual inspection. The controller owns actual native rendered wide/narrow screenshot inspection (1440×1000 and 920×700) using its existing isolated harness; no Task 4 screenshots or live model probes were made.

Intended commit: `feat(desktop): support image attachments and replayable previews`, with the required AGENTS co-author trailer.

## Review fix round 1 — picker acceptance, stable Side drafts and fixture isolation

Review source: `.superpowers/sdd/2026-11-14-speed-and-images/task-4-review.md`, head `1306d29`. All three P2 findings were read and addressed together.

1. **Picker application while awaiting acceptance:** the paperclip is disabled during submission/import/picker work. Picker invocation checks live refs rather than an older render's state, and each submitted/client-action draft increments a generation. A delayed native or legacy selected-file result is applied only while mounted, enabled, not submitting, and still in its original generation. Concurrent picker invocations are locked. This prevents both a new path being erased by an earlier acceptance and a stale selection being applied to a newer draft.
2. **Side drafts disappearing across navigation/reload:** Side follow-up draft identity is now `side:<sourceKind>:<sourceId>`, supplied from the authoritative ConversationPane target instead of the ephemeral provider Side ID. The Drawer memoizes its initial draft and persistence callback per stable source. Accepted follow-ups use the existing draft-revision guard. Pruning retains stable Side drafts whose source still exists and removes them when that source is gone. Reopening a fresh Side runtime on the same source restores unsent or failed text+refs; changing sources does not leak them. No provider conversation or server queue is made persistent.
3. **Ambient launcher target overrides:** the launcher forces `ROOKERY_HOST=127.0.0.1`, pins the app's `ROOKERY_DEBUG_PORT` to the validated fixture-only debug port, explicitly binds the debugger to loopback, and removes ambient renderer URL, generic Electron debug endpoint, Node startup/debugger and VS Code inspector environment values. Its existing home/provider-secret/daemon-fallback isolation remains. The health-checked loopback fixture is now also the endpoint imported app main uses, and the renderer comes from the built bundle.

The fixture-only completed-state improvement emits synthetic running → assistant/result → idle sequences for Master, Worker and Side start/follow-ups. Master/Worker completed transcript frames are retained in fixture history; runtime status rows return to idle. Codex fixture costs remain estimated, requested speed is inherited from the synthetic source, and speed observations remain unknown. A synthetic user echo no longer leaves the renderer's final row permanently Thinking. The fixture supports port 0 and records its actual assigned loopback port for collision-free smoke checks. This changes no production provider/core/enqueue/speed implementation.

Evidence (Node 22):

- **RED:** `/tmp/task4-fix1-red.log` — five new Composer/Side regressions failed on `1306d29` (plus an initial launcher-test URL-constructor issue). After correcting that test harness issue, the unchanged launcher independently failed the conflicting-host assertion (`other.invalid` vs `127.0.0.1`): `/tmp/task4-fix1-launcher-red.log`.
- **Focused GREEN:** `npm -w apps/desktop test -- test/composer-images.test.tsx test/drafts.test.ts test/image-fixture-launcher.test.ts test/image-fixture-completion.test.ts` — **4 files / 41 tests passed**, `/tmp/task4-fix1-focused.log`. Includes delayed path/image picker results across acceptance, an ordinary picker resolving during pending submission, ordinary and rejected Side follow-ups through unmount/prune/localStorage hydration/new-runtime restoration, source isolation, and launcher execution with deliberately conflicting host/renderer/debugger values. The launcher's final main-module import is stubbed in the VM test; no actual daemon or Electron user profile is contacted.
- **Full desktop suite:** **154 files / 1201 tests passed**, `/tmp/task4-fix1-desktop-suite.log`.
- **Root and desktop typechecks:** passed, `/tmp/task4-fix1-root-types.log`, `/tmp/task4-fix1-desktop-types.log`.
- **Root and desktop builds:** passed, `/tmp/task4-fix1-root-build.log`, `/tmp/task4-fix1-desktop-build.log`.
- **Portable fixture WS smoke:** used only `/tmp/task4-fix1-completion-smoke`, assigned port 62852. Verified Master assistant/result/idle, Worker assistant/result/idle and replayed result history, and Side start/follow-up completion with inherited Codex estimated/Fast-requested metadata. Output was `{masterCompletion:true,workerCompletion:true,sideStartAndFollowupCompletion:true,history:true,providerCalls:0}`. Server log: `/tmp/task4-fix1-fixture-server.log`. Stopped only this task's PID 3120; left the controller's existing fixture PID 35380 running.
- `git diff --check`: passed.

The controller's native picker/image-only/reload visual evidence at `1306d29` remains valid for the unchanged image transport. Final native wide/narrow inspection and scoped re-review remain with the controller. No live provider, user daemon or user data was accessed by this fix round.
