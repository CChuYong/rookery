# Worker-spawn inline stream alert — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weave the worker-spawn "started · follow" notice into the master's live Slack stream as a `>` blockquote alert (append when a turn is streaming, threaded post otherwise) instead of a standalone message.

**Architecture:** Add a passive `ThreadRegistry.get(sessionId)` accessor and a public `SlackThreadReporter.threadAlert(markdown)` that self-selects stream-append vs threaded-post. Inject an `alert(sessionId, markdown)` closure into `WorkerSlackRelay` (built beside the registry in `app.ts`), and have `onSpawned` build a localized masked-link blockquote and route it through that closure, falling back to its own threaded post only when no reporter exists.

**Tech Stack:** TypeScript (ESM NodeNext, `.js` import extensions, `import type`), Node 22, vitest, bolt/Slack Web API, in-house daemon i18n (`src/core/i18n.ts`).

## Global Constraints

- Node 22 ABI 127 — run `nvm use 22` (or ensure a Node-22 `node` on PATH) before any build/test, or `better-sqlite3` fails to load.
- ESM NodeNext: relative imports need the `.js` extension; type-only imports use `import type`.
- Code comments in English.
- The daemon `EN` catalog in `src/core/i18n.ts` is typed `Record<keyof typeof KO, string>`, so a new `KO` key missing from `EN` is a typecheck error (the parity guard). New `slack.*` keys go in BOTH `KO` and `EN`.
- Exact new i18n strings (param `{label}`):
  - `slack.workerStartedAlert` → ko `` 🧵 워커 `{label}` 시작됨 `` / en `` 🧵 Worker `{label}` started ``
  - `slack.openThread` → ko `스레드 보기` / en `open thread`
- The blockquote alert must be a masked link `<permalink|label>` (no raw URL), and every threaded-post path for it must set `unfurl_links:false, unfurl_media:false`.
- Do NOT change the master's own spawn plan card (`reporter.ts:308-313`) or the relay root card.
- Verification gate per task: `npm run typecheck` + `npm test` from repo root (Slack tests live under `test/slack/`).

---

### Task 1: Infra — `ThreadRegistry.get`, `SlackThreadReporter.threadAlert`, i18n keys

Pure additions (no caller yet). Adds the accessor, the reporter method (+ an unfurl option on the private `post`), and the two i18n strings that Task 2 consumes.

**Files:**
- Modify: `src/slack/thread-registry.ts` (add `get`)
- Modify: `src/slack/reporter.ts` (extend private `post`; add public `threadAlert`)
- Modify: `src/core/i18n.ts` (2 keys in `KO`, 2 in `EN`)
- Test: `test/slack/thread-registry.test.ts`, `test/slack/reporter.test.ts`

**Interfaces:**
- Produces:
  - `ThreadRegistry.get(sessionId: string): SlackThreadReporter | undefined`
  - `SlackThreadReporter.threadAlert(markdown: string): Promise<void>`
  - i18n keys `slack.workerStartedAlert` ({label}), `slack.openThread`

- [ ] **Step 1: Write the failing `ThreadRegistry.get` test**

Append to `test/slack/thread-registry.test.ts` (inside the existing `describe("ThreadRegistry", …)` block, before its closing `});`):

```ts
  it("get returns the ensured reporter and undefined for an unknown session", () => {
    const bus = new EventBus();
    const { client } = recClient();
    const reg = new ThreadRegistry(bus);
    expect(reg.get("s1")).toBeUndefined();
    const r = reg.ensure("s1", () => new SlackThreadReporter(client, target));
    expect(reg.get("s1")).toBe(r);
    expect(reg.get("nope")).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/slack/thread-registry.test.ts -t "get returns the ensured reporter"`
Expected: FAIL — `reg.get is not a function`.

- [ ] **Step 3: Implement `ThreadRegistry.get`**

In `src/slack/thread-registry.ts`, add this method right after `ensure(...)` (before `disposeAll`):

```ts
  // Passive lookup of an existing reporter without creating one (used by the worker relay to weave an alert into the
  // master's live stream). No LRU bump — a read, not a use.
  get(sessionId: string): SlackThreadReporter | undefined {
    return this.entries.get(sessionId)?.reporter;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/slack/thread-registry.test.ts -t "get returns the ensured reporter"`
Expected: PASS.

- [ ] **Step 5: Write the failing `threadAlert` tests**

In `test/slack/reporter.test.ts`, add a new `describe` block (top-level, after the existing tests). It reuses the file's `fakeClient`/`Rec`/`texts`/`ev`/`target` helpers, and uses a local fake for the no-stream post case so it can assert `unfurl_links`:

```ts
describe("threadAlert", () => {
  it("weaves the alert into the live stream when a turn is streaming", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.toolStart("t1", "spawn_worker")); // opens the stream (tool card)
    await r.idle();
    await r.threadAlert("> 🧵 alert · <https://x|open>");
    const streamed = rec.streams.flatMap(texts).join("");
    expect(streamed).toContain("> 🧵 alert · <https://x|open>");
    expect(rec.posts).toEqual([]); // woven in, not a separate post
  });

  it("posts a threaded blockquote with unfurl off when no stream is open", async () => {
    const posts: Array<{ text: string; unfurl_links?: boolean; unfurl_media?: boolean }> = [];
    const client: SlackClient = {
      chatStream: () => { throw new Error("should not open a stream"); },
      chat: { async postMessage(a) { posts.push(a as typeof posts[number]); return {}; } },
    };
    const r = new SlackThreadReporter(client, target);
    await r.threadAlert("> 🧵 alert · <https://x|open>");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("> 🧵 alert");
    expect(posts[0]!.unfurl_links).toBe(false);
    expect(posts[0]!.unfurl_media).toBe(false);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run test/slack/reporter.test.ts -t "threadAlert"`
Expected: FAIL — `r.threadAlert is not a function`.

- [ ] **Step 7: Implement the `post` unfurl option + `threadAlert`**

In `src/slack/reporter.ts`, change the private `post` signature/body (currently around line 131-139) to accept an optional unfurl toggle (default preserves today's behavior):

```ts
  private async post(text: string, opts?: { unfurl?: boolean }): Promise<void> {
    try {
      // Send it byte-truncated — otherwise the post fallback also loses it again to msg_too_long (G-UNICODE).
      await this.client.chat.postMessage({
        channel: this.target.channel,
        thread_ts: this.target.threadTs,
        text: truncateBytes(text, SLACK_TEXT_MAX_BYTES),
        ...(opts?.unfurl === false ? { unfurl_links: false, unfurl_media: false } : {}),
      });
    } catch (err) {
      // Doesn't kill the adapter, but prevents silent loss — log what got dropped (slack-silent-post-loss).
      process.stderr.write(`[rookery] slack post failed: ${String(err)}\n`);
    }
  }
```

Then add the public `threadAlert` method (place it right after `onEvent`/`idle`, near the top of the class, so the public surface stays grouped):

```ts
  // Inject a one-line alert (already-formatted mrkdwn, e.g. a "> …" blockquote) into the master thread. Enqueued on the
  // same serialized tail as events so it lands in order; woven into the live stream when a turn is open, else a threaded
  // post (avoids append lazily opening an orphaned streaming bubble outside a turn). Used by the worker→Slack relay.
  threadAlert(markdown: string): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (this.streamer) { await this.flushProse(); await this.append({ markdown_text: `\n${markdown}\n` }); }
      else { await this.post(markdown, { unfurl: false }); }
    }).catch((err) => {
      process.stderr.write(`[rookery] slack reporter threadAlert error: ${String(err)}\n`);
    });
    return this.tail;
  }
```

- [ ] **Step 8: Run the threadAlert tests to verify they pass**

Run: `npx vitest run test/slack/reporter.test.ts -t "threadAlert"`
Expected: PASS (2 tests).

- [ ] **Step 9: Add the i18n keys**

In `src/core/i18n.ts`, add to `KO` right after `"slack.workerRepo": …,` (line 41):

```ts
  "slack.workerStartedAlert": "🧵 워커 `{label}` 시작됨",
  "slack.openThread": "스레드 보기",
```

And to `EN` right after its `"slack.workerRepo": …,` line:

```ts
  "slack.workerStartedAlert": "🧵 Worker `{label}` started",
  "slack.openThread": "open thread",
```

- [ ] **Step 10: Typecheck + Slack test suite**

Run: `npm run typecheck`
Expected: PASS (proves `EN` has both new `KO` keys — the daemon parity guard).

Run: `npx vitest run test/slack/reporter.test.ts test/slack/thread-registry.test.ts`
Expected: PASS (all reporter + registry tests, including the 3 new ones).

- [ ] **Step 11: Commit**

```bash
git add src/slack/thread-registry.ts src/slack/reporter.ts src/core/i18n.ts test/slack/thread-registry.test.ts test/slack/reporter.test.ts
git commit -m "feat(slack): reporter.threadAlert + registry.get + worker-alert i18n

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Integration — relay routes the spawn alert into the master stream

Consumes Task 1. Replaces the relay's standalone follow-post with a localized blockquote routed through an injected `alert` closure (wired to `registry.get(...).threadAlert`), with the relay's own threaded post (unfurl off) as the no-reporter fallback.

**Files:**
- Modify: `src/slack/worker-slack-relay.ts` (`WorkerRelayDeps.alert`; `onSpawned` blockquote + alert + fallback; imports)
- Modify: `src/slack/app.ts:190` (inject `alert` closure)
- Test: `test/slack/worker-slack-relay.test.ts`

**Interfaces:**
- Consumes (Task 1): `ThreadRegistry.get(sessionId): SlackThreadReporter | undefined`; `SlackThreadReporter.threadAlert(md): Promise<void>`; i18n `slack.workerStartedAlert`/`slack.openThread`.
- Produces: `WorkerRelayDeps.alert?: (sessionId: string, markdown: string) => Promise<boolean>` (true when a reporter was found and the alert delivered).

- [ ] **Step 1: Update the relay spawn test + add the fallback test (failing)**

In `test/slack/worker-slack-relay.test.ts`:

(a) Give `makeDeps` a default `alert` that reports "delivered" so the common path no longer posts the follow message. Replace the `makeDeps` body (around line 23-25):

```ts
function makeDeps(client: SlackClient, over: Partial<WorkerRelayDeps> = {}): WorkerRelayDeps {
  return { client, enabled: () => true, channel: () => "C-relay", resolveThread: () => MASTER, alert: async () => true, ...over };
}
```

(b) Replace the existing `it("on spawn: posts a root message to the channel + a permalink into the master thread", …)` test (around line 57-73) with:

```ts
  it("on spawn: posts a root card + weaves a blockquote alert into the master stream (no separate follow post)", async () => {
    const f = fakeClient();
    const alerts: Array<{ sessionId: string; md: string }> = [];
    const relay = new WorkerSlackRelay(makeDeps(f.client, { alert: async (sessionId, md) => { alerts.push({ sessionId, md }); return true; } }));
    relay.onEvent(spawn());
    await relay.idle();
    // root card → relay channel; the follow notice is now an in-stream alert, NOT a separate post
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.channel).toBe("C-relay");
    expect(f.posts[0]!.thread_ts).toBeUndefined();
    expect(f.state.permalinks).toBe(1);
    // the alert is a blockquote carrying the masked permalink, routed to the master session's reporter
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.sessionId).toBe("s1");
    expect(alerts[0]!.md.startsWith("> ")).toBe(true);
    expect(alerts[0]!.md).toContain("app"); // label
    expect(alerts[0]!.md).toContain("https://slack/C-relay/ts1"); // permalink
  });

  it("falls back to a threaded post (unfurl off) when no master reporter is found", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client, { alert: async () => false }));
    relay.onEvent(spawn());
    await relay.idle();
    expect(f.posts).toHaveLength(2); // root card + fallback follow post
    const followed = f.posts[1]!;
    expect(followed.channel).toBe("Cmaster");
    expect(followed.thread_ts).toBe("m1");
    expect(followed.text.startsWith("> ")).toBe(true);
    expect(followed.text).toContain("https://slack/C-relay/ts1");
    expect(followed.unfurl_links).toBe(false);
    expect(followed.unfurl_media).toBe(false);
  });
```

- [ ] **Step 2: Run the relay tests to verify the new/updated ones fail**

Run: `npx vitest run test/slack/worker-slack-relay.test.ts -t "on spawn"`
Expected: FAIL — the relay still posts the follow message (posts length 2, no `alert` call) so the new assertions don't hold. (`WorkerRelayDeps` has no `alert` yet → the `makeDeps` change is a type error until Step 3; that also counts as the red state.)

- [ ] **Step 3: Add `alert` to `WorkerRelayDeps` and rewrite `onSpawned`'s follow-post**

In `src/slack/worker-slack-relay.ts`:

(a) Add the imports at the top (the file already imports `Locale`-related types from core; add the runtime helpers):

```ts
import { t, DEFAULT_LOCALE } from "../core/i18n.js";
```

(b) Extend `WorkerRelayDeps` (the interface around line 8-14) with:

```ts
  // Route a one-line alert into the master thread's reporter (in-stream when a turn is open, else a threaded post).
  // Returns true when a master reporter was found and the alert delivered; false → the relay posts it itself.
  alert?: (sessionId: string, markdown: string) => Promise<boolean>;
```

(c) Replace the permalink follow-post block (currently around line 94-97, inside the `if (permalink) { … }`) with:

```ts
        if (permalink) {
          const locale = this.deps.getLocale?.() ?? DEFAULT_LOCALE;
          const label = e.label || e.workerId;
          // masked link (no raw URL, no unfurl) as a "> " blockquote alert woven into the master's live stream
          const blockquote = `> ${t(locale, "slack.workerStartedAlert", { label })} · <${permalink}|${t(locale, "slack.openThread")}>`;
          const delivered = (await this.deps.alert?.(e.sessionId, blockquote)) ?? false;
          if (!delivered) {
            // no master reporter (edge — a spawning master normally has one): post it ourselves, unfurl off
            await this.deps.client.chat.postMessage({ channel: master.channel, thread_ts: master.threadTs, text: blockquote, unfurl_links: false, unfurl_media: false });
          }
        }
```

- [ ] **Step 4: Run the relay test file to verify it passes**

Run: `npx vitest run test/slack/worker-slack-relay.test.ts`
Expected: PASS (all relay tests — the two rewritten/added ones plus the untouched ones; `makeDeps`'s default `alert` keeps the "posts nothing when disabled/no-channel/no-thread" tests green because they bail before the alert path).

If any other test in this file asserted the old two-post shape, update it to the new one-post-plus-alert shape (only the spawn-path tests should be affected).

- [ ] **Step 5: Wire the `alert` closure in `app.ts`**

In `src/slack/app.ts`, in the `new WorkerSlackRelay({ … })` construction (around line 190-199), add the `alert` property (the `registry` const is already in scope from line 49):

```ts
    alert: (sessionId, markdown) => {
      const r = registry.get(sessionId);
      return r ? r.threadAlert(markdown).then(() => true) : Promise.resolve(false);
    },
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS (all root tests, including the updated relay tests).

- [ ] **Step 7: Commit**

```bash
git add src/slack/worker-slack-relay.ts src/slack/app.ts test/slack/worker-slack-relay.test.ts
git commit -m "feat(slack): weave worker-spawn alert into the master stream

Replace the standalone 'started — follow' post with a localized blockquote
alert routed through the master reporter (in-stream append when a turn is
open, threaded post with unfurl off otherwise). Falls back to a relay post
only when no reporter exists.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `ThreadRegistry.get` accessor → Task 1 Steps 1-4. ✓
- `SlackThreadReporter.threadAlert` (stream-append vs threaded-post, on the tail, unfurl-off post) → Task 1 Steps 5-8. ✓
- `post` unfurl option → Task 1 Step 7. ✓
- i18n `slack.workerStartedAlert`/`slack.openThread` in KO+EN → Task 1 Step 9 (typecheck-guarded). ✓
- `WorkerRelayDeps.alert` + `onSpawned` blockquote (masked link) + no-reporter fallback (unfurl off) → Task 2 Steps 1-4. ✓
- `app.ts` wiring via `registry.get` → Task 2 Step 5. ✓
- Master spawn plan card + relay root card untouched → neither task modifies `reporter.ts:308-313` or the root-card post; the on-spawn test still asserts the root card at `posts[0]`. ✓
- Tests for registry.get, threadAlert (both paths), relay alert-call + fallback → Task 1 Steps 1/5, Task 2 Step 1. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 2 Step 4's "update any other test that asserted the old two-post shape" is a scoped safety instruction (the spawn-path tests are the only ones that post twice), not a missing-logic placeholder.

**Type consistency:** `threadAlert(markdown: string): Promise<void>` matches its call in the `app.ts` closure and the reporter test. `alert?: (sessionId, markdown) => Promise<boolean>` matches `makeDeps`, both relay tests, the `onSpawned` call (`(await this.deps.alert?.(…)) ?? false`), and the `app.ts` closure (returns `Promise<boolean>`). `ThreadRegistry.get(sessionId): SlackThreadReporter | undefined` matches the closure's `const r = registry.get(...)` guard. i18n keys are identical between the catalog additions, the `t(...)` calls in `onSpawned`, and the spec.
