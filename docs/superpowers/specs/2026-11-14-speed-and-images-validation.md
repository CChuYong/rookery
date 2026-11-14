# Speed and images validation — 2026-11-14

Scope: `feat/speed-and-images`, base `40d9208`, accepted Tasks 1–4 through `deacdb9`. This record maps the [binding design](2026-11-14-speed-and-images-design.md) to implementation and evidence. All automation uses Node 22.23.0. No user daemon/home/configuration was modified by the Task 5 checks. Real-provider acceptance below was collected once by the controller using synthetic input and temporary homes; the smoke runner never repeats it.

## Reproducible integration command

```sh
source ~/.nvm/nvm.sh
nvm use 22
npm run smoke:speed-images
```

[`scripts/smoke-speed-images.mjs`](../../../scripts/smoke-speed-images.mjs) reuses six root and eight desktop suites. It refuses a non-22 Node or live-provider arguments. The production `startDaemon` test uses a fresh `mkdtemp` home, OS-assigned loopback port, real authenticated WebSockets and real file-backed SQLite. Injected providers and explicitly mocked startup auth/model/usage collectors prevent account calls. It closes only its own daemon and removes only its temporary state. The Connection/WsClient tests use real dispatch/client/persistence components with in-memory sockets for deterministic pending/acceptance races.

Result: **6 root files / 29 tests and 8 desktop files / 79 tests passed** (108 total). Log: `/tmp/task5-smoke-speed-images.log`. Existing React `act` warnings appear in component suites; no failed test or unhandled rejection. This proves serialization/persistence/client behavior, not native rendering, entitlement or effective Fast performance.

## Requirement matrix

Paths below are relative to repository root; tests are included in the final full suites unless marked separately.

| Design requirement | Implementation | Evidence / boundary |
|---|---|---|
| Standard/Fast nullable intent; four Standard defaults | `src/core/speed.ts`, `settings.ts`, `persistence/db.ts`, `repositories.ts` | `test/core/speed.test.ts`, `test/persistence/db.test.ts`; live setting changes, SQL constraint and nullable automation persistence |
| Create/send/setter/fleet/automation/fork propagation | `session-manager.ts`, `fleet-orchestrator.ts`, `automation-action.ts`, `tools/fleet-tools.ts`, `protocol/messages.ts`, `daemon/connection.ts` | `speed.test.ts`, `fleet-orchestrator.test.ts`, `automation-action.test.ts`, `connection.test.ts`, `test/tools/fleet-tools.test.ts`; same/cross-provider intent, wakeups, reload/restart |
| Busy changes affect next input; billed speed snapshot | `worker.ts`, `master-agent.ts`, `claude-backend.ts`, `codex/codex-backend.ts` | `speed.test.ts` queued Standard→Fast→Standard and captured cost tier; `claude-backend.test.ts` busy flag-control ordering |
| Claude settings overlay/control awaited before delivery; reported USD unchanged | `claude-backend.ts` | `claude-backend.test.ts`; real installed SDK with in-memory subprocess helper tests input-pump rejection ownership, stop/reload and original error persistence; live probe below |
| Codex per-turn service tier; actionable 0.169.0 minimum | `codex-backend.ts`, `codex-protocol.ts`, `codex-version.ts` | `test/core/codex/{codex-backend,codex-version}.test.ts`; `default|fast` on each turn; live native request shapes below |
| Catalog serviceTiers/supportsFastMode; unknown vs explicit exclusion | `codex-models-provider.ts`, adapters, renderer `lib/speed.ts` | `codex-models-provider.test.ts`, `codex-backend.test.ts`, desktop `composer-speed.test.tsx`; actual catalog `priority` id and legacy `fast` both tested |
| Requested vs reported unknown/standard/fast/cooldown; future reasons | `speed.ts`, adapters, renderer `SpeedControl.tsx`, i18n speed catalogs | `claude-backend.test.ts`, desktop `composer-speed.test.tsx`, `store-speed.test.ts`; live Codex unknown and Claude Standard/preference retained |
| Observations persisted/replayed; historical vs pending selection | events, master/worker, renderer reduce/store and `speed-preference.ts` | root `speed.test.ts`; desktop `store-speed`, `speed-preference`, `speed-surfaces`; two-target stale-refresh race regressions |
| Separate Standard/Fast estimates and exact GPT-5.5 2.5× | `codex/codex-pricing.ts` | `codex-pricing.test.ts`; all explicit rows, uncovered Fast tiers unavailable; official pricing source/date retained in code |
| Missing/long-context/cache-write/counter-rollback/cold-resume accounting | `codex-backend.ts`, `codex-pricing.ts`, `speed.ts` | `codex-backend.test.ts`, `codex-pricing.test.ts`, `speed.test.ts`; >272K individual request detection, repeated short totals not mistaken for long context, unavailable quality survives rebuild/fork |
| Unknown cost UI and boundary budgets | master/worker, renderer cost/metrics helpers | `speed.test.ts` stops budgeted Worker before deferred input and after resume; desktop `metrics-speed`, `worker-cost`; CLI tests avoid reliable-looking zero |
| Picker/drop/clipboard, preview/removal, preserve text and @path | desktop `Composer.tsx`, `ImageAttachments.tsx`, image import helpers, main `selected-attachment.ts` | desktop `composer-images.test.tsx`, `selected-attachment.test.ts`; mixed clipboard, native bytes only, ordinary paths unchanged; visual evidence below |
| Mixed/image-only existing/new Master, Worker follow-up, Side | Composer, App both layout branches, NewSession, Side drawer | `composer-images.test.tsx`, `image-transport.test.ts`; Worker spawn remains text-only; shared App plumbing guards in `speed-surfaces` and image tests |
| PNG/JPEG/WebP/GIF; 4/message, 3 MiB/image, 8 MiB/message, 8000/dimension, 20M pixels | `image-input.ts`, `daemon/image-store.ts`, wire schema | `image-input.test.ts`, `image-store.test.ts`, `protocol/messages.test.ts`; real four-format fixtures, exact boundary bytes/dimensions/pixels, SVG/type/signature/base64 rejection, preserved bytes |
| Private immutable UUID files, atomic no-follow writes, metadata rollback | `image-store.ts`, appended images migration | `image-store.test.ts`; 0700/0600, symlink/non-file rejection, DB/file failure cleanup, restart reads |
| Authenticated upload/get; no paths/URLs; 16 MiB WS, 1 GiB quota | `connection.ts`, `server.ts`, `image-store.ts` | **real daemon** `image-pipeline.test.ts`: wrong auth 401, native upload/get/send, actual >16 MiB close 1009; store tests serialize concurrent quota, retain crash leftovers |
| No implicit image GC after deletion; fork/draft refs remain valid | image store and metadata ownership | store tests fork/source deletion; **real daemon restart/deletion** test still reads asset; indefinite retention documented in `reference/images.md` |
| Entire authoritative ref validation before echo/provider; retryable failure | image resolver, master/worker, Side preparation, connection | `image-pipeline`, `desktop-image-acceptance`, `side-image-start`; tampered/missing refs rejected whole; async Side fork deletion yields one rejected request, no registered Side, cleanup |
| Native provider input; transport-agnostic port, finite Claude Master/Side | `image-input.ts`, adapters, daemon composition root | adapter tests inspect Claude blocks/Codex data URLs; `image-transport.test.ts` Master/Worker/Side; actual adapter natural completion below |
| Deferred FIFO retains refs and speed, resolves only at dispatch | master/worker/message queue | `image-transport.test.ts`; deferred unreadable asset before echo, lazy resume/replacement, cancellation, terminal Worker rejection |
| Reference-only events/index/drafts; bounded lazy history | events/repositories, renderer drafts and `MessageImages.tsx` | `image-pipeline` confirms no base64 in SQLite history; desktop `drafts` v1→v2/stripping, `message-images` viewport release/coalesced 24 MiB LRU and missing-history retry |
| One pending input, same-ref consecutive image-only dedup, retries after reconnect | `clientMsgId`, `retryInput`, renderer reducers | **real Connection/WsClient** `desktop-image-acceptance`; desktop `store-pending` tests live/replayed IDs and failure with no local pending state |
| Acceptance clears original draft only; failed creation/send retains input | `enqueueTurn`, Composer, draft revision/generation guards | `desktop-image-acceptance` blocks first provider turn while acknowledging second; `composer-images`, `drafts` cover newer identical revision, failed new session, terminal Worker restore/recovery |
| Navigation/import races and stable Side drafts | Composer import/picker generation; stable `side:<sourceKind>:<sourceId>` keys | `composer-images`, `drafts`: late imports/pickers discarded, Side runtime replaced with source draft restored, source pruning and isolation; close-while-preparing cleanup |
| Same-provider native history; cross-provider textual handoff | session/fleet forks and image transport | `image-transport.test.ts` verifies historical image marker absent from provider handoff; newly attached images native; store tests source deletion retains shared refs |
| Both App layouts and ko/en, no redesign/runtime daemon imports | shared controls, catalog modules | desktop surface tests, image tests, i18n key parity/used-keys checks; native rendered inspection below |
| Fresh lockfile baseline, all types/tests/builds | installed SDK 0.3.325; Node 22 | controller baseline `npm ci`, root 1390/desktop 1126 tests; final Task 5 gates below |
| Independent review and feature delivery | task reports/reviews in `.superpowers/sdd/2026-11-14-speed-and-images/` | Tasks 1–4 accepted after scoped fixes; final full-branch review remains controller-owned |

## Full-branch gates

Final commands ran once after the Task 5 runner changes. All exited 0. Documentation/evidence-only edits followed these checks.

| Command | Result | Log |
|---|---|---|
| `npm run typecheck` | Passed | `/tmp/task5-root-typecheck.log` |
| `npm -w apps/desktop run typecheck` | Passed | `/tmp/task5-desktop-typecheck.log` |
| `npm test` | **116 files / 1,457 tests passed** | `/tmp/task5-root-suite.log` |
| `npm -w apps/desktop test` | **154 files / 1,201 tests passed** | `/tmp/task5-desktop-suite.log` |
| `npm run build` | Passed | `/tmp/task5-root-build.log` |
| `npm -w apps/desktop run build` | Passed after root build | `/tmp/task5-desktop-build.log` |

## Final review lifecycle fix

The whole-branch review at `ee7c46a` accepted Task 5 evidence and found one P2: a Side fork could finish after its owning Connection was disposed, acknowledge a dead client, and start an unowned provider turn. The final fix records disposal before draining owned Sides, closes a subsequently prepared Side before acknowledgement/execution, and rolls back when acknowledgement throws without attempting another send through the broken sender. Concurrent Side closes share one cleanup task. Master and Worker lifetimes remain independent of client disconnects.

The actual Connection + SideConversationManager regression gates a fake Codex-master fork, disposes before release, then proves **0 provider starts, 1 cleanup, no registered Side and 0 late acknowledgements**, for both text and image-only input. Persistent sender failure settles the request without rejection or a second send; disposal during acknowledgement and overlapping/repeated closes are also covered. Existing unreadable-during-fork rejection and successful acknowledgement-before-first-event/native prepared-byte delivery still pass.

Fresh post-fix checks (Node 22.23.0; earlier evidence above is retained):

| Command | Result | Log |
|---|---|---|
| `npx vitest run test/daemon/side-image-start.test.ts test/core/side-conversation.test.ts` before fix | Expected RED: **5 failed / 9 passed** | `/tmp/final-fix-red.log` |
| `npx vitest run test/daemon/side-image-start.test.ts test/core/side-conversation.test.ts test/daemon/connection.test.ts test/core/image-transport.test.ts test/daemon/desktop-image-acceptance.test.ts test/daemon/image-pipeline.test.ts` | **6 files / 112 tests passed** | `/tmp/final-fix-focused.log` |
| `npm run typecheck` | Passed | `/tmp/final-fix-root-typecheck.log` |
| `npm -w apps/desktop run typecheck` | Passed | `/tmp/final-fix-desktop-typecheck.log` |
| `npm test` | **116 files / 1,464 tests passed** | `/tmp/final-fix-root-suite.log` |
| `npm run build` | Passed | `/tmp/final-fix-root-build.log` |
| `npm run smoke:speed-images` | **6 root files / 35 tests + 8 desktop files / 79 tests passed** (114 total) | `/tmp/final-fix-smoke.log` |

The reusable smoke was rerun once after the fix and includes the six new Connection/Side owner-lifetime cases; its existing React `act` warnings remain, with no failed test or unhandled rejection. This server-only lifecycle fix changes no shared wire contracts or renderer code, so the earlier full desktop suite/build and eight visual captures remain applicable. No paid provider probes, native screenshots, user configuration/authentication or user daemon operations were repeated. Scoped independent rereview and the completion audit remain controller-owned.

## Actual provider acceptance (controller evidence)

The following commands were already executed once, with no tool events, synthetic red-left/blue-right PNG input, isolated configuration/cwd and temporary in-memory or target-local authentication. No auth values or provider session ids are recorded here. **Do not automatically rerun paid probes.** These are actual adapter/provider checks, separate from full daemon and rendered UI tests.

```sh
./node_modules/.bin/tsx /tmp/rookery-speed-images-fixtures/product-codex-probe.mjs
./node_modules/.bin/tsx /tmp/rookery-speed-images-fixtures/product-claude-probe.mjs --run --with-fast
```

| Provider / call | Observed response and lifecycle | Speed / accounting |
|---|---|---|
| Codex CLI 0.169.0, `gpt-6-luna`, native image | `left: red; right: blue`; natural success in 3,283 ms | Fast requested via `serviceTierForTurn: fast`, state **unknown**; $0.001928 estimated |
| Codex text resume in new child | same answer; natural success in 6,473 ms; real `thread/resume` | Fast requested, state unknown; $0.00023064 estimated |
| Claude SDK 0.3.325, haiku, finite native image input | correct colors; natural success in 4,900 ms | Standard / `sdk_opt_in_required`; $0.0151729 SDK reported |
| Claude haiku, fresh query text resume | same answer; natural success in 3,424 ms | Standard / `sdk_opt_in_required`; $0.0086145 SDK reported |
| Claude SDK-advertised Fast model fable | `OK`; natural success in 5,001 ms; captured `fastMode: true` | Fast requested, provider reported **Standard / preference**; $0.0810725 SDK reported |

Totals: Codex **$0.00215864 estimated**; Claude **$0.1048599 SDK reported**. Claude's organization/provider preference prevented effective Fast; no effective-Fast claim is made. Codex catalog advertised `priority`/Fast and image input, but request acceptance does not establish actual priority execution. Durations do not demonstrate a speed improvement. Resume responses establish conversation continuity across fresh children/queries; because earlier answers contained the colors, they do not independently prove renewed pixel examination. All Claude iterators ended without abort/timer intervention, confirming the finite image lifecycle.

Local artifacts: `/tmp/rookery-speed-images-fixtures/product-{codex,claude}-probe.md`, matching `-result.json`, scripts, and Claude log. Claude probe ran after the documented 21:30 KST reset with tools/settings sources/MCP disabled, maxTurns 1, each requested SDK budget ≤$0.12 and aggregate cap $0.25. Private temporary auth was cleaned; user configuration was unchanged.

## Native rendered UI evidence

The controller uses CUA with the portable synthetic [fixture](../../../scripts/demo/images/README.md), final completion events and isolated Electron userData/sessionData. No production account or user screenshot is used. A fixture-only QA capture menu in `/tmp/rookery-speed-images-fixtures/capture-launcher.cjs` saves local PNGs; it does not change the product menu. The controller opened and inspected each completed capture with `view_image`.

| Scene | Local PNG under `/tmp/rookery-image-ui-final-fixed/screenshots/` | Dimensions | Observed result |
|---|---|---|---|
| New-session image preview/removal | `scene-1794661487352.png` | 2880×2000 physical; 1440×1000 logical | Native picker imports actual PNG; preview and remove control visible; remove then reattach verified |
| Image-only new Master committed | `scene-1794661558762.png` | 2880×2000 physical; 1440×1000 logical | Image-only send committed, synthetic completion ended Thinking; Cmd-R restored image history |
| Codex mixed input and speed | `scene-1794661637032.png` | 2880×2000 physical; 1440×1000 logical | Text+image draft, Fast requested with effective state unknown, Estimated cost visible |
| Narrow full-app relaunch draft restoration | `scene-1794661842489.png` | 1840×1400 physical; 920×700 logical | Prior wide mixed Codex draft restored after full quit/relaunch; text and image ref intact |
| Narrow mixed Codex completed | `scene-1794661857271.png` | 1840×1400 physical; 920×700 logical | User text+image and synthetic assistant completion visible |
| Narrow Worker image-only follow-up | `scene-1794661900660.png` | 1840×1400 physical; 920×700 logical | Image-only follow-up committed and completed |
| Narrow Worker-sourced Side start | `scene-1794661983020.png` | 1840×1400 physical; 920×700 logical | Image-only initial question completed; inherited Fast intent visible |
| Narrow Side follow-up | `scene-1794662033751.png` | 1840×1400 physical; 920×700 logical | Second image-only input remains separate; completed scrollable history |

All eight saved PNGs were opened and visually inspected by the controller. Their PNG header dimensions were independently checked during Task 5. Controls remained reachable, images contained, and no actionable overlap/cutoff was observed. Side's title wraps and its long context subtitle truncates normally; scrollable history clips old offscreen content as intended. Native picker import, removal/reattach, image-only/mixed sends, full-app draft restoration and Cmd-R committed-history restoration were exercised through CUA. Clipboard/drop/cancel/error paths have automated test coverage; they were **not** manually exercised as OS gestures. These synthetic UI captures verify requested wide/narrow rendering, not live provider behavior.

## Controller decisions

The controller's durable rulings from the implementation ledger are collected here with their tradeoffs:

- Proceed autonomously through design/plan gates under the user's delegated workflow; differing preferences may require rework.
- Offer Standard/Fast with explicit Standard defaults and defer Ultrafast; this changes implicit inherited provider speed behavior while keeping known pricing and the requested scope.
- Require verified Codex CLI 0.169.0 for per-turn speed overrides; older installations must upgrade.
- Keep tier-aware Codex USD estimates instead of native cumulative accounting to avoid fork/resume double counting; subscription usage can differ and the UI labels estimates.
- Retain immutable image assets under the 1 GiB quota with no implicit GC to protect draft/fork refs; future explicit maintenance may be needed for disk space.
- Add narrow `session.setSpeed` glue so a selection persists without an empty provider turn; it extends the protocol without redesigning execution.
- Treat replayed speed observations as historical until fresh execution reports state, rather than adding configuration-version identity; reconnect/config changes initially show unknown effective state.
- Recognize authoritative Codex catalog ids `priority` and `fast` as Fast capability, preserving the `fast` turn request alias; compatibility depends on ids, never display names.
- Add validated Master enqueue acceptance plus persisted optional Worker `clientMsgId` to keep long-turn drafts responsive and distinguish repeated image-only echoes after reconnect; internal `runTurn` completion, serialized turns and visible asynchronous failures remain intact, with no durable queue redesign.
- Correlate pre-echo Master failures by optional `clientMsgId` and retain reference-only retry input so missing assets cannot strand pending bubbles; ordinary post-echo provider failures keep their existing behavior.

## Retained limitations

Codex is estimated rather than native cumulative billing; cold-resume/long-context/incomplete telemetry can make budgets unavailable and stop an opted-in Worker. Nested Codex child spend remains outside that guard. Fast is an account/model request and reported state, with no performance guarantee. Images remain indefinitely under the 1 GiB quota; there is no implicit GC/deletion maintenance API. Cross-provider historical vision is not replayed. Queued server work is not durable across daemon restart; correlated failure history and local reference-only drafts support restoration, and missing files must be reattached. Final whole-branch review is a separate controller gate.
