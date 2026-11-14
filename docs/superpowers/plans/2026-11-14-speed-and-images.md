# Provider Speed and Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver usable Standard/Fast controls and native image messages for Claude and Codex, including persistence, truthful state/cost reporting and desktop visual verification.

**Architecture:** Extend the existing provider-neutral boundary with speed options/observations and multimodal runtime input. Store image blobs separately and persist references in transcripts/drafts. Reuse existing target overrides, interaction-free sends, and Composer UI.

**Tech Stack:** Node 22, TypeScript, Claude Agent SDK 0.3.325, Codex app-server 0.169.0, SQLite, Electron/React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-speed-and-images-design.md` (binding authority).

## Global Constraints

- Node 22 for every node/npm command; use `source ~/.nvm/nvm.sh && nvm use 22`.
- Core remains transport-agnostic; all dependency wiring belongs in `src/daemon/server.ts`.
- SQLite migrations are append-only. No secrets, image bytes or arbitrary filesystem paths in transcript metadata/logs.
- All new desktop strings have matching ko/en i18n keys. Follow the existing IDE styling; no unrelated redesign.
- Keep existing text callers compatible and preserve serialized Master turns and Worker deferred FIFO.
- Standard/Fast only; missing preferences inherit Rookery defaults, initially Standard. Selected speed is not evidence of effective service.
- Image limits: 4/message, 3 MiB/image, 8 MiB/message, dimension 8000, 20,000,000 pixels; PNG/JPEG/GIF/WebP only. Inbound WS limit 16 MiB, asset store quota 1 GiB.
- Persist only image references in events/drafts. No implicit asset deletion; forks and drafts retain references.
- English docs, commits and PR descriptions. Commit trailer follows AGENTS.md. Never merge main or release.
- Implementers do not spawn subagents. Work sequentially; controller owns independent reviews and final verification.

## Task 1: Speed contracts, provider execution and persistence

**Files:** Create `src/core/speed.ts`; modify `src/core/agent-backend.ts`, `claude-backend.ts`, `codex/codex-backend.ts`, `codex/codex-protocol.ts`, `codex/codex-version.ts`, `codex/codex-pricing.ts`, `codex-models-provider.ts`, `settings.ts`, `events.ts`, `master-agent.ts`, `worker.ts`, `fleet-orchestrator.ts`, `session-manager.ts`, `side-conversation.ts`, `automation-action.ts`, `src/persistence/db.ts`, `repositories.ts`, `src/protocol/messages.ts`, `src/daemon/connection.ts`, `server.ts`, `src/tools/fleet-tools.ts`, `external-tools.ts`, and corresponding tests. Update AGENTS.md/version reference for new CLI minimum. Follow actual repository type ownership; do not duplicate conflicting contracts.

**Interfaces:** Add and export:
```ts
export type SpeedPreference = "standard" | "fast";
export type CostAccuracy = "reported" | "estimated" | "unavailable";
export interface SpeedObservation {
  requested: SpeedPreference;
  state: "unknown" | "standard" | "fast" | "cooldown";
  reason?: string;
}
```
`AgentSessionOptions` receives a speed resolver or equivalent boundary-resolved value; Worker must re-evaluate defaults before each turn. `AgentStream` gains optional asynchronous `setSpeed(speed)` with real provider errors surfaced, not swallowed. `AgentEvent` gains speed observation and result accounting-quality fields. Core master/worker events retain these fields for replay. Add protocol/row/settings fields so Task 2 can use them without another backend design.

- [x] Write failing tests capturing exact Claude initial options, `applyFlagSettings` before follow-up delivery, busy next-turn semantics and state decoding (on/off/cooldown/missing/reason).
- [x] Write failing Codex tests asserting `serviceTierForTurn: "default"` for Standard and `"fast"` for Fast, no sticky override on next send; preserve catalog serviceTiers metadata. Minimum supported version becomes 0.169.0 with existing actionable error behavior.
- [x] Run focused RED: `npx vitest run test/core/claude-backend.test.ts test/core/codex/codex-backend.test.ts test/core/codex/codex-pricing.test.ts`; record actual failures (adjust existing test path only if repository differs).
- [x] Implement provider mapping and observations. Claude costs remain SDK-reported. Codex request acceptance emits unknown effective state. Unknown metadata is allowed; explicit catalog exclusion rejects Fast before execution. Never hard-code model lifetime availability.
```ts
const claudeSettings = { fastMode: speed === "fast" };
const codexTurnTier = speed === "fast" ? "fast" : "default";
```
- [x] Implement explicit Fast rate table from the spec; consult https://developers.openai.com/api/docs/pricing.md for long-context applicability. `turnCostUsd` compatibility may remain, but a richer internal estimator must return accuracy and never silently substitute a Standard or short-context price for uncovered requests. Regression assertions include GPT-5.5 one million uncached input tokens => $12.50 Fast, $5.00 Standard; unknown Fast model => unavailable. Preserve correct cache subtraction.
- [x] Add nullable speed overrides to session/worker/automation persistence with one new migration. Add four settings defaults. Resolve session override then role/provider default per turn; explicit sends update persisted preference. Worker setSpeed persists for restart and applies next turn; reload/forks carry preference. Side inherits source speed. Automation/fleet/external MCP accept optional speed. No model/effort behavior change.
- [x] Add lifecycle tests: defaults edited while idle affect next turn, busy changes do not reprice current turn, restart/reload/fork preserve intent, unknown pricing with budget stops further Worker turns and warns Master. Unavailable accounting never appears as reliable zero spend.
- [x] Run root suite and root+desktop typechecks; existing desktop callers remain compatible via optional fields. Write full report with RED/GREEN evidence, then commit `feat(core): add provider speed controls and tier-aware cost estimates`.

## Task 2: Desktop speed selection and truthful state

**Files:** Modify `apps/desktop/src/renderer/components/Composer.tsx`, `NewSessionPage.tsx`, `WorkerSpawnModal.tsx`, `AutomationForm.tsx`, `SettingsPage.tsx`, `SessionMetrics.tsx`, `WorkerCost.tsx` as applicable, `App.tsx`, `store/store.ts`, `store/reduce.ts`, `ws/client.ts`, `lib/master-controls.ts`, `lib/worker-composer.ts`, and ko/en catalogs. Create focused `components/SpeedControl.tsx` and `lib/speed.ts` if reused. Add `test/composer-speed.test.tsx`, `test/store-speed.test.ts` and extend surface tests.

**Interfaces:** Consume Task 1's protocol/settings/row/event fields. Extend `ComposerControls` with optional speed selection/change and observation. All existing consumers without speed still render. Desired preference lives with the target; observed state comes from provider events, not optimistic selections.

- [x] Write failing tests for Standard/Fast selection, next-turn pending state, unknown/cooldown/unavailable labels, known unsupported vs missing catalog, and reconnect restoration.
```tsx
// Representative contract (use existing test helpers):
// Render Composer with speed="fast" and observation.state="unknown".
// Assert selected Fast is visible and no "Fast active" claim is rendered.
// Change to Standard; assert callback receives "standard" once.
```
- [x] Run RED: `npm -w apps/desktop test -- test/composer-speed.test.tsx test/store-speed.test.ts`.
- [x] Add a compact text/select control beside model/effort. Add localized explanation that Fast can cost more and availability is checked by the provider. Unknown effective state must read as requested, cooldown/reasons must be inspectable. Known unsupported model disables Fast but preserves already-saved intent visibly rather than silently changing settings.
- [x] Wire New Session, existing Master and Worker, spawn, automation and four settings defaults. Both App workspace branches use the same controls. Persist and restore desired values through daemon rows, not solely local overrides. Keep Side's inherited selection readable.
- [x] Render Codex costs/budgets as estimates; unavailable accounting displays an unknown marker and explanatory accessible label instead of $0. Persist observation history and clear stale observations when a new turn/configuration warrants unknown state.
- [x] Run desktop suite + root/desktop typechecks + desktop build. Report evidence and commit `feat(desktop): expose provider speed preferences and runtime state`.

## Task 3: Image asset store and native input transport

**Files:** Create `src/core/image-input.ts`, `src/daemon/image-store.ts`, `test/daemon/image-store.test.ts`, `test/core/image-input.test.ts`; modify protocol, events, repositories/db, connection/server, agent-backend, message-queue, master-agent, worker, fleet-orchestrator, side-conversation, claude-backend and codex-backend/protocol; update fake backend helpers and targeted transport/lifecycle tests. Add dependency/lockfile only for a bounded image header parser if needed.

**Interfaces:**
```ts
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export interface ImageRef {
  id: string; name: string; mediaType: ImageMediaType;
  byteLength: number; width: number; height: number;
}
export interface ResolvedImage { mediaType: ImageMediaType; data: string }
export type AgentInput = string | { text: string; images: ResolvedImage[] };
```
Add injectable `ImageResolver` with bounded validation/resolution of refs. Add authenticated `image.upload` and `image.get` protocol requests/results. Master/worker/Side sends accept optional image refs. Events carry authoritative refs. Keep text-only string behavior unchanged.

- [x] Write RED store/schema tests using tiny valid PNG/JPEG fixtures: upload/get after reopen, UUID validation, canonical base64, MIME mismatch, dimensions, file/count/aggregate limits, traversal/symlinks, concurrent quota enforcement. Verify quota error never deletes existing assets.
- [x] Run RED: `npx vitest run test/daemon/image-store.test.ts test/core/image-input.test.ts`.
- [x] Implement file store under the daemon home with atomic 0600 writes, 0700 directories and no-follow access. Add immutable metadata in append-only migration, DB/file failure rollback and serialized quota reservation. Reject oversized upload before decoding; cap WS frames at 16 MiB. Do not log image payloads. No path/URL input APIs.
- [x] Implement request handlers and injection; resolve all ids from authoritative store metadata before acceptance. Reject an entire invalid send, preserving no partial echo/provider invocation. History stores only refs and remains small. Forked refs survive original target deletion; do not add GC.
- [x] Thread multimodal input through Master serialized turns, Worker deferred FIFO, initial/lazy stream, provider replacement and Side. Keep labels/text handoff textual while preserving newly attached images. Empty text with images is valid, empty text without images follows existing behavior. Preserve speed behavior from Tasks 1–2.
```ts
// Claude native image block:
const block = { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } };
// Codex native image item:
const item = { type: "image", url: `data:${image.mediaType};base64,${image.data}` };
```
- [x] For Claude image-bearing master turns, use a finite single-message async iterable; keep text-only master string prompts. Test interruption, resume and terminal result. Codex maps each image to a native item. Never replace images with textual file paths.
- [x] Add end-to-end fake-provider tests for image-only/mixed Master, Worker deferred ordering and Side; reconnect reference persistence; invalid ids; no image bytes in history. Run root suite and both typechecks. Report RED/GREEN and commit `feat(core): persist image assets and deliver native multimodal inputs`.

## Task 4: Desktop image import, drafts and transcript rendering

**Files:** Modify desktop main/preload IPC, `renderer/App.tsx`, `components/Composer.tsx`, `PromptEditor.tsx`, `editor/PromptEditorPlugins.tsx`, `NewSessionPage.tsx`, `ConversationPane.tsx`, `SideConversationDrawer.tsx`, `MessageList.tsx`, `views/Conversation.tsx`, `store/drafts.ts`, `store/store.ts`, `store/reduce.ts`, client/types/i18n. Create `lib/image-import.ts`, `components/ImageAttachments.tsx`, `components/MessageImages.tsx`, and focused tests.

**Interfaces:** Use Task 3 ImageRef/upload/get. Composer emits text plus refs (an optional second argument preserves text-only callers). Drafts migrate legacy strings to `{text, images}` without base64. Native selected-image picker/import returns bounded bytes only after dialog selection; normal file paths retain old @mention behavior. Drop/paste use browser File APIs with early byte checks.

- [x] Write RED tests for picker/drop/paste, mixed text+image clipboard, unsupported/oversized files, removal and import-in-flight send gating; image-only start/send/Side; failed-send retry; navigation isolation; persisted draft migration and reference-only storage.
- [x] Run RED: `npm -w apps/desktop test -- test/composer-images.test.tsx test/drafts.test.ts test/store-pending.test.ts` (create focused new file as named).
- [x] Implement image import helper and selected-file IPC with size/type checks. Add generation/cancellation handling so completed imports never populate a different target's draft. Keep failed import details localized and preserve prior valid attachments.
- [x] Add thumbnail strip above composer content, accessible remove controls and filename/detail; permit image-only send. Preserve clipboard text when clipboard contains both image and text. Preserve non-image @path selection and drop. Do not intercept or send slash client actions while silently dropping attached images.
- [x] Wire text+refs through both App branches, new session creation, pending Master/Worker bubbles and Side. Clear only after acceptance; failures retain the exact original refs/text. Avoid duplicate image-only echoes by comparing ids, never text alone.
- [x] Render committed/pending images via lazy image.get and a bounded cache; show missing/error placeholders and retry controls. Reconnect/fork history must display refs; no remote URL execution. Draft changes and navigation/unmount retain refs per target.
- [x] Run desktop suite, both typechecks and both builds. Add a reproducible isolated UI fixture/smoke entry under `scripts/` or test artifacts to exercise native-rendered layouts without exposing real user data. Report evidence and commit `feat(desktop): support image attachments and replayable previews`.

## Task 5: Integration evidence, documentation and final review

**Files:** Update `docs/reference/protocol.md`, `docs/reference/settings.md`, relevant architecture/guide documents after inspecting docs/README.md; add `scripts/smoke-speed-images.mjs` (or equivalent existing test harness extension) and `docs/superpowers/specs/2026-11-14-speed-and-images-validation.md`.

- [x] Read the spec requirement-by-requirement and build a verification matrix pointing to implementation and tests. Test scripts must exercise the real daemon WebSocket and persistence boundary with an injected fake provider, not merely repeat unit-test assertions.
- [x] Execute `npm run typecheck`, `npm -w apps/desktop run typecheck`, `npm test`, `npm -w apps/desktop test`, `npm run build`, `npm -w apps/desktop run build`; capture results.
- [x] Run minimal real-provider image probes where account access permits: generated non-sensitive image, image-only initial and text follow-up on Claude/Codex; ensure finite Claude master input completes. Probe speed option acceptance and provider disabled/cooldown state without assuming entitlement. Record commands, outcomes and restrictions. Never print auth secrets.
- [x] Inspect wide and narrow rendered UI screenshots of speed preference/state, image attachments/removal, mixed and image-only messages, pending and reloaded history. Use an isolated test home and synthetic data. Save local artifacts and record paths/dimensions in validation doc; no public upload of user screenshots.
- [x] Update docs for CLI floor 0.169.0, requested vs reported state, estimated Codex prices, image bounds/quota/retention and cross-provider textual handoff policy.
- [x] Controller dispatches independent full-branch review with spec, plan, reports and diff package. Resolve material findings through an implementer and scoped re-review. Re-run covering checks after fixes.
- [x] Commit verified final docs/tests. Deliver English commits on the feature branch and report exact validation results, screenshot evidence, remaining account restrictions and design rulings. A PR may be created under the user's existing commit/PR workflow authorization; never merge automatically.

## Completion record

Completed on the feature branch from `40d9208`. The [validation record](../specs/2026-11-14-speed-and-images-validation.md) maps requirements to implementation, test logs, actual provider probes and inspected screenshots, including the final independent review and scoped lifecycle fix. Detailed task reports preserve RED/GREEN limitations rather than claiming every test failure was a product defect. No unresolved review finding remains.
