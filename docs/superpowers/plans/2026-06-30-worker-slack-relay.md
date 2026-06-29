# Worker → Slack relay Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`). TDD where logic is pure; Slack I/O is best-effort and verified manually. macOS test suite must stay green.

**Goal:** Mirror each Slack-origin master's worker activity into a configured Slack channel (one thread per worker, per-turn plan cards) and drop a thread link into the master's Slack thread.

**Architecture:** A new `WorkerSlackRelay` (Slack-adapter side, one per daemon) subscribes to `worker.*` on `FLEET_CHANNEL`. On a gated `worker.spawned` it posts a root message to the relay channel, links it into the master's thread, and creates a per-worker `SlackThreadReporter` pointed at the root thread. Worker events are translated to the master-shaped `CoreEvent`s the reporter already renders (reusing its per-turn chatStream + plan-card logic). Core stays transport-agnostic.

**Tech Stack:** Node 22 ESM (`.js` specifiers, `import type`), bolt WebClient, vitest.

## Global Constraints
- Scope: only workers whose home session is Slack-origin (`parseSlackThreadKey(externalKey) !== null`).
- Relay content: assistant `message`, `tool_use` (one-line), `tool_result` (status/error only), `result`, `error`. Exclude `message_delta`/`thinking*`/`tool_progress`/`tool_result` body/`notice`.
- Best-effort: any Slack failure is caught + logged; never blocks the worker. No-op when bot down / disabled / channel unset / non-slack session.
- Settings echoed (not secret). New user-facing strings via i18n (ko default). Comments in English.

---

### Task 1: Settings — `workerSlackRelayEnabled` + `workerSlackRelayChannel`
**Files:** Modify `src/core/settings.ts`, `src/protocol/messages.ts`; Test `test/core/settings.test.ts`.
**Interfaces produced:** `Settings.workerSlackRelayEnabled(): string` ("1"/"0"), `Settings.workerSlackRelayChannel(): string`; both in `SettingsValues` + `settings.set` schema.

- [ ] Mirror `defaultSessionCwd` exactly: add `workerSlackRelayEnabled` (default "0") + `workerSlackRelayChannel` (default "") to `SettingsValues`, getters (`getSetting("…") ?? "0"` / `?.trim() ?? ""`), and `all()`.
- [ ] `messages.ts`: add both to the `settings.set` object (`z.string().optional()`).
- [ ] `settings.test.ts`: extend the `all()` deep-equal with `workerSlackRelayEnabled: "0", workerSlackRelayChannel: ""`; add an echo test.
- [ ] Run `npm run typecheck` + `npx vitest run test/core/settings.test.ts` → PASS. Commit.

### Task 2: `worker.spawned` carries the task
**Files:** Modify `src/core/events.ts` (add `task?: string` to the `worker.spawned` member), `src/core/fleet-orchestrator.ts` (the `bus.emit({type:"worker.spawned", …})` → add `task: input.task`).
- [ ] Add `task?: string` to the `worker.spawned` event type.
- [ ] Pass `task: input.task` in the fleet-orchestrator emit.
- [ ] `npm run typecheck` (root) → clean. Commit.

### Task 3: SlackClient extension — root post (ts) + permalink
**Files:** Modify `src/slack/types.ts`.
**Interfaces produced:** `SlackClient.chat.postMessage(args: { channel; thread_ts?; text }) → Promise<{ ts?: string }>` (thread_ts now optional); `SlackClient.chat.getPermalink(args: { channel; message_ts }) → Promise<{ permalink?: string }>`.
- [ ] Make `thread_ts` optional and the return `Promise<{ ts?: string }>`; add `getPermalink`. (The bolt `app.client` WebClient already implements both — it's cast to `SlackClient`.)
- [ ] `npm run typecheck` (root) — reporter.ts still compiles (it ignores the return). Commit.

### Task 4: Worker event → CoreEvent translator (pure)
**Files:** Create `src/slack/worker-event-to-core.ts`; Test `test/slack/worker-event-to-core.test.ts`.
**Interfaces produced:** `workerEventToCoreEvent(data: WorkerEventData, sessionId: string, workerId: string): CoreEvent | null`.
- [ ] Test: `message`(assistant)→`master.message`; `tool_use`→`master.tool` start; `tool_result`→`master.tool` end (`ok=!isError`, `result=content`); `result`→`master.result`; `error`→`error`; `message_delta`/`thinking`/`thinking_delta`/`tool_progress`/`system`/`notice`/`message`(user)→`null`.
- [ ] Implement the mapping (sessionId used as the synthetic CoreEvent.sessionId; the reporter ignores it — it posts to its fixed target).
- [ ] `npx vitest run test/slack/worker-event-to-core.test.ts` → PASS. Commit.

### Task 5: `WorkerSlackRelay`
**Files:** Create `src/slack/worker-slack-relay.ts`; Test `test/slack/worker-slack-relay.test.ts`.
**Consumes:** `SlackClient` (Task 3), `SlackThreadReporter`, `parseSlackThreadKey`, `workerEventToCoreEvent` (Task 4).
**Interfaces produced:**
```ts
interface WorkerRelayDeps {
  client: SlackClient;
  enabled: () => boolean;            // settings.workerSlackRelayEnabled === "1"
  channel: () => string;             // settings.workerSlackRelayChannel (trimmed)
  resolveThread: (sessionId: string) => ThreadTarget | null; // parseSlackThreadKey(session.external_key)
  getLocale?: () => Locale;
}
class WorkerSlackRelay {
  constructor(deps: WorkerRelayDeps);
  onEvent(e: CoreEvent): void;       // subscribe FLEET_CHANNEL to this
  dispose(): Promise<void>;
}
```
- [ ] Test (fake `SlackClient` capturing posts/streams, fake `resolveThread`): gating (disabled / no channel / non-slack → no posts); on `worker.spawned` posts a root message to the channel + a permalink message to the master thread + tracks the worker; `worker.event` of kind `message`/`tool_use` feeds the worker reporter (assert chatStream append); `worker.event` of an excluded kind does nothing; terminal `worker.status` disposes the worker's reporter.
- [ ] Implement: on `worker.spawned` (gated) → `resolveThread(sessionId)`; if null return. `client.chat.postMessage({channel, text: "Worker `<label>` · repo `<basename(repoPath)>`" + task})` → `rootTs`. `client.chat.getPermalink({channel, message_ts: rootTs})` → post `{channel: master.channel, thread_ts: master.threadTs, text: "🧵 Worker started — follow: <permalink>"}`. Create `new SlackThreadReporter(client, {channel, threadTs: rootTs, team: master.team}, getLocale)`; store `Map<workerId, reporter>`. On `worker.event` (tracked) → `const ce = workerEventToCoreEvent(...)`; if ce, `reporter.onEvent(ce)`. On terminal `worker.status` (stopped/done/error/failed) → `reporter.dispose()` + drop entry. All Slack calls wrapped try/catch → stderr.
- [ ] `npx vitest run test/slack/worker-slack-relay.test.ts` → PASS. Commit.

### Task 6: Wire the relay + settings into the Slack adapter
**Files:** Modify `src/slack/app.ts` (instantiate relay in `startSlack`, subscribe `FLEET_CHANNEL`, dispose on disconnect), `src/slack/handle-incoming.ts` (SlackDeps: add `workerRelay?` config + `resolveThread`), `src/daemon/server.ts` (build the slackConfig relay fields from `settings` + `resolveThread` from `repos`).
- [ ] `slackConfig()` (server.ts) gains `workerRelayEnabled`/`workerRelayChannel` (from settings) — live per call. Add `resolveThread: (id) => parseSlackThreadKey(repos.getSession(id)?.external_key ?? null)` to SlackDeps (verify the by-id getter name; add one if missing).
- [ ] `app.ts`: `const relay = new WorkerSlackRelay({ client: app.client as SlackClient, enabled: () => deps.slackConfig().workerRelayEnabled, channel: () => deps.slackConfig().workerRelayChannel, resolveThread: deps.resolveThread, getLocale: () => deps.slackConfig().locale });` then `const unsub = deps.bus.subscribe(FLEET_CHANNEL, (e) => relay.onEvent(e));` ; on disconnect `unsub(); void relay.dispose();`.
- [ ] `npm run typecheck` + `npm test` (root) → green. Commit.

### Task 7: Desktop settings UI + i18n
**Files:** Modify `apps/desktop/src/renderer/components/SettingsPage.tsx` (Slack tab: toggle + channel input bound to `f.workerSlackRelayEnabled`/`f.workerSlackRelayChannel`), `i18n/locales/{ko,en}/settings.ts`.
- [ ] Add a "워커 활동 중계" toggle (checkbox, `"1"/"0"`) + a channel-ID `Input` (hint: needs the bot invited to the channel), gated visually under the Slack section. Save via the existing General/Slack save button (`onSave(f)`).
- [ ] Add i18n keys (ko+en parity): `settings.workerRelay`, `settings.workerRelayDesc`, `settings.workerRelayChannel`, `settings.workerRelayChannelHint`.
- [ ] `npm run typecheck` + `npm test` (desktop, incl. i18n parity/used-keys) + `npm run build` → green. Commit + push.

## Self-Review
- Spec coverage: settings(T1), task-in-spawn(T2), SlackClient ext(T3), translation(T4), relay+gating+root+link+per-turn reuse(T5), wiring(T6), UI(T7). ✓
- Placeholders: none (interfaces + mapping enumerated). The one "verify by-id getter name" in T6 is a real lookup step, not a code placeholder.
- Type consistency: `workerSlackRelayEnabled/Channel` (settings) vs `workerRelayEnabled/Channel` (slackConfig field) — intentional rename at the config boundary; `WorkerRelayDeps`/`workerEventToCoreEvent` names consistent across T4/T5/T6. ✓
