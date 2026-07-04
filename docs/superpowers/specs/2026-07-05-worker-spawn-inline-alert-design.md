# Worker-spawn alert woven into the master stream (design)

- Date: 2026-07-05
- Status: approved (design), pending implementation plan
- Area: `src/slack` (reporter / thread-registry / worker-slack-relay / app) + daemon i18n
- Builds on: branch `slack-relay-no-unfurl` (commit `e85ea1e`, unfurl suppression)

## Problem

When a worker spawns, `WorkerSlackRelay.onSpawned` posts a **standalone** `chat.postMessage` into the master's Slack thread — `🧵 Worker \`label\` started — follow: <permalink>` (`src/slack/worker-slack-relay.ts:96`). It reads as a separate, disconnected message. The user wants it woven **into the master's live response stream** as a blockquote alert (`> …`), so it blends with the conversation instead of interrupting it as a new message.

## Goal / non-goals

**Goal**: the worker-spawn notice appears as a one-line `> blockquote` alert carrying a masked permalink link, injected into the master's live stream when a turn is open, falling back to a threaded post when it is not.

**Non-goals**: no change to the master's own spawn **plan card** (`🔧 워커 label` at `reporter.ts:308-313` — that is the master's task tracking and stays); no change to the relay **root card** posted to the relay channel; no global unfurl changes beyond what already landed in `e85ea1e`.

## Key facts (from investigation)

- The master's `SlackThreadReporter` is **long-lived per session** (`ThreadRegistry`, keyed by `sessionId`); its **streamer is per-turn** — opened lazily on the first `append()` of a turn, `stop()`ed on `master.result`/`error`/`dispose` (`reporter.ts:83-129`).
- `worker.spawned` fires **mid-turn** (inside the `spawn_worker` tool call, `fleet-orchestrator.ts:282`), so the master's stream is normally **open** at relay time. But the relay computes the permalink via async round-trips (root `postMessage` → `getPermalink`), so a short turn may have ended (stream closed) by the time the alert is ready — this race needs a fallback.
- Appending to a **closed** streamer lazily opens a **new orphaned streaming bubble** (`reporter.ts:95`) that gets absorbed into the next turn — undesirable. So the alert must branch on "streamer open?" and post instead when closed.
- `ThreadRegistry` has no `get()` today (only `ensure`/`disposeAll`); the relay has no handle to the master reporter — but `registry` is in lexical scope where the relay is constructed (`app.ts:49, 190`), so an accessor + injected closure is a small local change.

## Approach (chosen)

Inject a `notice`/`alert` closure into the relay that routes the blockquote to the master's reporter; the reporter self-selects **stream-append vs threaded-post**. Rejected alternatives: a synthetic `master.notice` event (renders italic `_ℹ️ …_`, not a blockquote, and no clean post fallback); a reporter-only render of `worker.spawned` (can't carry the relay-computed permalink).

### Data flow

```
worker.spawned → relay.onSpawned → root card postMessage → getPermalink
  → blockquote = `> {slack.workerStartedAlert(label)} · <permalink|{slack.openThread}>`   (masked link, no raw URL)
  → delivered = await deps.alert(sessionId, blockquote)
       reporter found → reporter.threadAlert(blockquote):
            streamer open → flushProse(); append({ markdown_text: "\n{blockquote}\n" })   (woven into the live stream)
            streamer null → post(blockquote, { unfurl:false })                             (threaded blockquote)
       no reporter (edge; in practice a spawning master always has one) → delivered=false
  → if !delivered: relay posts blockquote itself (unfurl off)   ← last-resort fallback
```

## Components (touch points)

1. **`src/slack/thread-registry.ts`** — add a passive accessor:
   ```ts
   get(sessionId: string): SlackThreadReporter | undefined {
     return this.entries.get(sessionId)?.reporter; // passive read — no LRU bump
   }
   ```

2. **`src/slack/reporter.ts`**
   - Extend the private `post` to optionally suppress unfurl (default keeps current behavior):
     ```ts
     private async post(text: string, opts?: { unfurl?: boolean }): Promise<void> {
       await this.client.chat.postMessage({
         channel: this.target.channel, thread_ts: this.target.threadTs,
         text: truncateBytes(text, SLACK_TEXT_MAX_BYTES),
         ...(opts?.unfurl === false ? { unfurl_links: false, unfurl_media: false } : {}),
       });
       // (keep the existing try/catch + stderr on failure)
     }
     ```
   - Add a **public** `threadAlert` that enqueues on the same serialized `tail` (so it lands in order with events) and weaves-or-posts. It takes fully-formatted mrkdwn (the caller owns the `> ` prefix and i18n):
     ```ts
     threadAlert(markdown: string): Promise<void> {
       this.tail = this.tail.then(async () => {
         if (this.streamer) { await this.flushProse(); await this.append({ markdown_text: `\n${markdown}\n` }); }
         else { await this.post(markdown, { unfurl: false }); }
       }).catch((err) => { process.stderr.write(`[rookery] slack reporter threadAlert error: ${String(err)}\n`); });
       return this.tail;
     }
     ```
     The injected blockquote is NOT added to `streamedText`, so it is not part of the master's message text and cannot be duplicated by the terminal `master.message`.

3. **`src/slack/worker-slack-relay.ts`**
   - `WorkerRelayDeps`: add `alert?: (sessionId: string, markdown: string) => Promise<boolean>;` (returns true when a reporter was found and the alert delivered).
   - `onSpawned` (replace the standalone post at line 96): build the localized blockquote, call `alert`, fall back to the relay's own post (unfurl off) only when no reporter:
     ```ts
     const locale = this.deps.getLocale?.() ?? DEFAULT_LOCALE;
     const label = e.label || e.workerId;
     const blockquote = `> ${t(locale, "slack.workerStartedAlert", { label })} · <${permalink}|${t(locale, "slack.openThread")}>`;
     const delivered = (await this.deps.alert?.(e.sessionId, blockquote)) ?? false;
     if (!delivered) {
       await this.deps.client.chat.postMessage({ channel: master.channel, thread_ts: master.threadTs, text: blockquote, unfurl_links: false, unfurl_media: false });
     }
     ```
     (Add `t`, `DEFAULT_LOCALE` imports from `../core/i18n.js`.)

4. **`src/slack/app.ts`** (relay construction, ~line 190) — inject the closure; `registry` is already in scope:
   ```ts
   alert: (sessionId, markdown) => {
     const r = registry.get(sessionId);
     return r ? r.threadAlert(markdown).then(() => true) : Promise.resolve(false);
   },
   ```

5. **`src/core/i18n.ts`** — two new `slack.*` keys in `KO` and `EN` (param `{label}`):
   - `slack.workerStartedAlert` → ko `` 🧵 워커 `{label}` 시작됨 `` / en `` 🧵 Worker `{label}` started ``
   - `slack.openThread` → ko `스레드 보기` / en `open thread`

## Error handling / edge cases

- **Stream closed at alert time** → `threadAlert` posts a threaded blockquote (unfurl off) instead of appending — no orphaned bubble.
- **No reporter for the session** (in practice never for a spawning master, since the turn that called `spawn_worker` created it) → `alert` returns false → relay posts the blockquote itself (unfurl off).
- **Ordering** → `threadAlert` runs on the reporter's `tail`, so it interleaves correctly with prose/cards; it lands wherever the stream is at that moment (natural placement).
- **Masked link** `<permalink|label>` shows only the label, carries no raw URL, and does not unfurl (streamed path never unfurls; the post fallback sets `unfurl_links:false`).

## Testing

- `test/slack/thread-registry.test.ts`: `get` returns the ensured reporter; `undefined` for an unknown session.
- `test/slack/reporter.test.ts`: `threadAlert` when a streamer is open appends `{ markdown_text }` containing the blockquote to the stream; when no streamer is open it calls `chat.postMessage` with `unfurl_links:false`. (Uses the file's existing fake client/streamer.)
- `test/slack/worker-slack-relay.test.ts`: on spawn with an `alert` dep, the relay calls `alert(sessionId, "> …")` and does **not** post the follow message (root post only → `posts` length 1); when `alert` resolves false (no reporter), the relay posts the blockquote itself with `unfurl_links:false`.

## Out of scope

- Consolidating the master's spawn plan card with the blockquote (kept separate by design).
- Localizing the relay **root card** rows (Worker/Repo/Task) — unrelated.
- Any change to worker terminal/relay streaming beyond the spawn alert.
