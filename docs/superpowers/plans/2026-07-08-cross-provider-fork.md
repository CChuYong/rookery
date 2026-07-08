# Cross-provider fork (provider handoff) Implementation Plan

> **STATUS: COMPLETE (T1–T8)** on branch `feat/codex-auth-probe` (stacked on the codex auth-probe, whose `codexAuthStatus` the Fork dialog's "Fork to Codex" gate consumes). TDD, commit per task. Root: typecheck clean + 935 tests. Desktop: typecheck clean + 919 tests. Not merged to main. T8 (desktop dialog) built by an Opus subagent, reviewed + gates re-run independently.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user fork a master session or worker onto the *other* agent backend ("continue this Claude conversation on Codex", and vice-versa), carrying full prior context.

**Architecture:** Reuse the existing fork machinery (`SessionManager.fork` / `FleetOrchestrator.fork` — new session/worker, `copy*Events`, worker worktree snapshot) with two changes when the target provider differs from the source: (1) set `provider = target` and skip the native `forkSession` handle (it can't cross providers), (2) set a `handoff_from_provider` marker. On the target's first turn, the source transcript is prepended to the **provider prompt only** (not the UI echo) so it becomes part of the target's turn-1 conversation ("baked in"), durable across resumes. The desktop right-click "Fork" becomes a dialog that picks the target provider + model/effort and gates "Fork to Codex" on the codex auth probe.

**Tech Stack:** TypeScript (ESM NodeNext, `.js` import extensions), better-sqlite3 (STRICT tables, append-only migrations), vitest, React 18 + Zustand + Tailwind (desktop), in-house i18n (ko/en).

## Global Constraints

- **Node 22 ABI** — activate Node 22 before building/running (`better-sqlite3` ABI 127).
- **ESM NodeNext** — relative imports need `.js`; type-only uses need `import type`.
- **Migrations are append-only** — never modify existing `MIGRATIONS` entries; only append. `db.test.ts` asserts applied version === `MIGRATIONS.length`.
- **Model/effort are resolvers** (`() => string`), re-evaluated per turn — never snapshot to strings.
- **i18n** — Korean is default; every new user-facing string goes through the catalog; new keys must exist in BOTH `ko` and `en` with identical key sets. Code comments in English.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Gates:** root `npm run typecheck && npm test`; desktop changes also need `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- **Backward compatibility:** `session.fork`/`worker.fork` with no target params must behave exactly as today (same-provider native fork).

## File Structure

- `src/core/handoff.ts` (new) — pure `buildHandoffSeed(...)` transcript flattener + fence.
- `src/persistence/db.ts` (modify) — one appended migration adding `handoff_from_provider` to `sessions` + `workers`.
- `src/persistence/repositories.ts` (modify) — `setSessionHandoffFrom` / `setWorkerHandoffFrom`; expose the column on the row reads (automatic via `SELECT *`).
- `src/core/session-manager.ts` (modify) — `fork(sessionId, target?)` handoff branch.
- `src/core/master-agent.ts` (modify) — first-turn seed injection in `doTurn`.
- `src/core/fleet-orchestrator.ts` (modify) — `fork(id, target?)` handoff branch + pass seed to the materialized worker.
- `src/core/worker.ts` (modify) — `handoffSeed` option + first-turn injection + marker clear.
- `src/protocol/messages.ts` (modify) — `session.fork`/`worker.fork` gain `provider?/model?/effort?`.
- `src/daemon/connection.ts` (modify) — pass the target through to `sessions.fork` / `fleet.fork`.
- `apps/desktop/src/renderer/components/ForkDialog.tsx` (new) + `App.tsx`/views wiring + i18n (modify).

---

### Task 1: Data model — `handoff_from_provider` migration + repo setters

**Files:**
- Modify: `src/persistence/db.ts` (append one `MIGRATIONS` entry)
- Modify: `src/persistence/repositories.ts`
- Test: `test/persistence/repositories.test.ts` (add cases), `test/persistence/db.test.ts` (version assertion already covers it)

**Interfaces:**
- Produces: `Repositories.setSessionHandoffFrom(id: string, provider: string | null): void`, `Repositories.setWorkerHandoffFrom(id: string, provider: string | null): void`. `getSession(id)`/`getWorker(id)` rows gain `handoff_from_provider: string | null`.

- [ ] **Step 1: Write the failing test** — add to `test/persistence/repositories.test.ts`:

```ts
it("sets and clears a session's handoff_from_provider marker", () => {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  expect(repos.getSession("s1")!.handoff_from_provider).toBeNull();
  repos.setSessionHandoffFrom("s1", "claude");
  expect(repos.getSession("s1")!.handoff_from_provider).toBe("claude");
  repos.setSessionHandoffFrom("s1", null);
  expect(repos.getSession("s1")!.handoff_from_provider).toBeNull();
});

it("sets and clears a worker's handoff_from_provider marker", () => {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w" });
  expect(repos.getWorker("w1")!.handoff_from_provider).toBeNull();
  repos.setWorkerHandoffFrom("w1", "codex");
  expect(repos.getWorker("w1")!.handoff_from_provider).toBe("codex");
  repos.setWorkerHandoffFrom("w1", null);
  expect(repos.getWorker("w1")!.handoff_from_provider).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/persistence/repositories.test.ts -t "handoff_from_provider"`
Expected: FAIL (`setSessionHandoffFrom` is not a function / column missing).

- [ ] **Step 3: Append the migration** — add as the LAST element of the `MIGRATIONS` array in `src/persistence/db.ts` (after the `automations.cost_budget_usd` entry):

```ts
  (db) => {
    // handoff_from_provider: cross-provider fork marker. Non-null on a session/worker created by a
    // cross-provider fork ("provider handoff") = the source provider's name; the seed (source transcript)
    // is injected into the target's first turn and this is cleared to NULL after that turn. NULL for every
    // ordinary session/worker (default off). See docs/2026-07-08-cross-provider-fork-design.md.
    db.exec("ALTER TABLE sessions ADD COLUMN handoff_from_provider TEXT");
    db.exec("ALTER TABLE workers ADD COLUMN handoff_from_provider TEXT");
  },
```

- [ ] **Step 4: Add the repo setters** — in `src/persistence/repositories.ts`, near `setSdkSessionId` / `setWorkerSdkSessionId`:

```ts
  setSessionHandoffFrom(id: string, provider: string | null): void {
    this.db.prepare("UPDATE sessions SET handoff_from_provider = ? WHERE id = ?").run(provider, id);
  }
```
```ts
  setWorkerHandoffFrom(id: string, provider: string | null): void {
    this.db.prepare("UPDATE workers SET handoff_from_provider = ? WHERE id = ?").run(provider, id);
  }
```

If the session/worker row TypeScript types are hand-declared (not `Record<string, unknown>`), add `handoff_from_provider: string | null` to each. (Check the `SessionRow`/`WorkerRow` type in this file or `src/protocol/messages.ts` for `WorkerRow`.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/persistence/repositories.test.ts test/persistence/db.test.ts`
Expected: PASS (including `db.test.ts`'s `version === MIGRATIONS.length`).

- [ ] **Step 6: Commit**

```bash
git add src/persistence/db.ts src/persistence/repositories.ts test/persistence/repositories.test.ts
git commit -m "feat(fork): handoff_from_provider marker column + repo setters (T1)"
```

---

### Task 2: Handoff seed builder (`src/core/handoff.ts`)

**Files:**
- Create: `src/core/handoff.ts`
- Test: `test/core/handoff.test.ts`

**Interfaces:**
- Produces: `buildHandoffSeed(events: Array<{ type: string; payload: unknown }>, sourceProvider: string, maxBytes?: number): string`. Newest-first byte-capped, oldest truncated with a marker; wrapped in a `<prior-conversation from="…">` fence with a continuation instruction. Empty events → `""` (caller skips injection when empty).

- [ ] **Step 1: Write the failing test** — `test/core/handoff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildHandoffSeed } from "../../src/core/handoff.js";

const ev = (role: string, content: string) => ({ type: "master.message", payload: { kind: "message", role, content } });

describe("buildHandoffSeed", () => {
  it("fences the transcript with the source provider and a continuation instruction", () => {
    const out = buildHandoffSeed([ev("user", "hi"), ev("assistant", "hello")], "claude");
    expect(out).toContain('<prior-conversation from="claude">');
    expect(out).toContain("</prior-conversation>");
    expect(out).toContain("hi");
    expect(out).toContain("hello");
    expect(out).toMatch(/continuing/i);
  });

  it("keeps the NEWEST events within the byte cap and marks older ones truncated", () => {
    const events = Array.from({ length: 40 }, (_, i) => ev("assistant", "x".repeat(100) + `#${i}`));
    const out = buildHandoffSeed(events, "codex", 600);
    expect(out).toContain("#39");          // newest kept
    expect(out).not.toContain("#0 ");      // oldest dropped
    expect(out).toMatch(/older .*truncated/i);
  });

  it("returns empty string for no events (caller skips injection)", () => {
    expect(buildHandoffSeed([], "claude")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/core/handoff.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/handoff.ts`:

```ts
// Builds the context "seed" for a cross-provider fork (provider handoff): the source session/worker's
// transcript, flattened to text and byte-capped newest-first (same discipline as fleet-tools.ts
// formatTranscript), wrapped in a fence. The caller prepends this to the target's FIRST turn prompt so it
// becomes part of the target's turn-1 conversation ("baked in") — durable across resumes, unlike a
// system-prompt injection. See docs/2026-07-08-cross-provider-fork-design.md.

const DEFAULT_MAX_BYTES = 48 * 1024;

// One transcript event → a compact "role: text" line (best-effort; the goal is context, not perfect replay).
function lineOf(e: { type: string; payload: unknown }): string {
  const p = (e.payload ?? {}) as { kind?: string; role?: string; content?: string; text?: string; name?: string };
  if (p.role && typeof p.content === "string") return `${p.role}: ${p.content}`;
  if (p.kind === "thinking" && p.text) return `assistant (thinking): ${p.text}`;
  if (p.kind === "tool" || e.type.endsWith(".tool")) return `assistant (tool ${p.name ?? ""})`.trim();
  if (typeof p.text === "string") return p.text;
  return `${e.type}`;
}

export function buildHandoffSeed(
  events: Array<{ type: string; payload: unknown }>,
  sourceProvider: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): string {
  if (events.length === 0) return "";
  const lines = events.map(lineOf);
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(lines[i]!, "utf8") + 1;
    if (kept.length > 0 && bytes + b > maxBytes) break; // always keep at least the newest line
    kept.push(lines[i]!);
    bytes += b;
  }
  kept.reverse();
  const dropped = lines.length - kept.length;
  const body = (dropped > 0 ? `…(${dropped} older event${dropped === 1 ? "" : "s"} truncated)\n` : "") + kept.join("\n");
  return (
    `<prior-conversation from="${sourceProvider}">\n${body}\n</prior-conversation>\n` +
    `You are continuing the above conversation, which happened on a different assistant backend. ` +
    `Treat it as your own prior context. The user's next message follows.`
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/handoff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/handoff.ts test/core/handoff.test.ts
git commit -m "feat(fork): handoff seed builder — capped, fenced transcript (T2)"
```

---

### Task 3: Master fork handoff branch (`SessionManager.fork`)

**Files:**
- Modify: `src/core/session-manager.ts` (the `fork` method, ~lines 141-165)
- Test: `test/core/session-manager.test.ts`

**Interfaces:**
- Consumes: `Repositories.setSessionHandoffFrom` (T1), `copySessionEvents`, `createSession`.
- Produces: `SessionManager.fork(sessionId: string, target?: { provider?: string }): Promise<Session>`. When `target.provider` is set and differs from the source → handoff (new session on `target.provider`, `handoff_from_provider` = source provider, no native `forkSession` call, no `sdk_session_id`). Otherwise unchanged.
- **RESOLVED:** SessionRow has NO model/effort column (master model/effort is resolved from settings + the desktop's per-session `overrides`). So master fork carries ONLY `provider`; the chosen model/effort is applied client-side as a per-session override after the fork (T8). Do NOT invent a session model column.

- [ ] **Step 1: Write the failing test** — add to `test/core/session-manager.test.ts` (mirror the existing fork test's harness; inspect it first for the `forkSession` fake + deps):

```ts
it("cross-provider fork creates a target-provider session with a handoff marker and NO native fork", async () => {
  const { sm, repos, forkCalls } = makeForkHarness(); // existing helper or inline: a SessionManager whose
  // forkSession fake records calls; a source session "src" with sdk_session_id + some session_events.
  repos.createSession({ id: "src", cwd: "/x", provider: "claude" });
  repos.setSdkSessionId("src", "claude-uuid");
  repos.addSessionEvent({ sessionId: "src", seq: 0, type: "master.message", payloadJson: JSON.stringify({ kind: "message", role: "user", content: "hi" }) });
  const forked = await sm.fork("src", { provider: "codex" });
  const row = repos.getSession(forked.id)!;
  expect(row.provider).toBe("codex");
  expect(row.handoff_from_provider).toBe("claude");
  expect(row.sdk_session_id).toBeNull();          // no native handle across providers
  expect(forkCalls.length).toBe(0);                // native forkSession NOT called
  expect(repos.listSessionEvents(forked.id).length).toBe(1); // transcript copied for UI history
});

it("same-provider fork still takes the native path (backward compatible)", async () => {
  const { sm, repos, forkCalls } = makeForkHarness();
  repos.createSession({ id: "src", cwd: "/x", provider: "claude" });
  repos.setSdkSessionId("src", "claude-uuid");
  await sm.fork("src", { provider: "claude" }); // same provider
  expect(forkCalls.length).toBe(1);              // native forkSession called
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/core/session-manager.test.ts -t "cross-provider fork"`
Expected: FAIL (`fork` ignores the 2nd arg; native path always taken).

- [ ] **Step 3: Implement** — replace the body of `fork` in `src/core/session-manager.ts` so it branches. Keep the existing native path verbatim for the else-branch:

```ts
  async fork(sessionId: string, target?: { provider?: string }): Promise<Session> {
    const row = this.deps.repos.getSession(sessionId);
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const srcProvider = row.provider || "claude";
    const label = row.label?.trim() || row.cwd.split(/[\\/]/).filter(Boolean).pop() || sessionId;
    const id = this.idgen();

    // Cross-provider handoff: no native resume handle crosses providers, so start a FRESH target session,
    // copy the transcript for UI history, and mark it so the first turn injects the source transcript.
    // Model/effort are NOT persisted here (no session column) — the client applies them as a per-session
    // override after the fork (see T8).
    if (target?.provider && target.provider !== srcProvider) {
      if (this.deps.repos.listSessionEvents(sessionId).length === 0) {
        throw new Error("nothing to hand off — this session has no conversation yet");
      }
      const forkLabel = `${label} (→ ${target.provider})`;
      this.deps.repos.createSession({ id, cwd: row.cwd, origin: "ui", originRef: null, provider: target.provider });
      this.deps.repos.copySessionEvents(sessionId, id);
      this.deps.repos.setSessionHandoffFrom(id, srcProvider);
      this.deps.repos.setSessionLabel(id, forkLabel);
      this.deps.bus.emit({ type: "session.label", sessionId: id, label: forkLabel });
      return this.build(id, row.cwd, null, null); // no sdk_session_id yet — established on the first turn
    }

    // Same-provider fork (unchanged native path).
    if (!row.sdk_session_id) throw new Error("this session has no completed turn yet — nothing to fork");
    if (!this.deps.forkSession) throw new Error("session forking is not available");
    const forkLabel = `${label} (fork)`;
    const provider = srcProvider;
    const { sessionId: forkedUuid } = await this.deps.forkSession(provider, row.sdk_session_id, { title: forkLabel, sourceSessionId: sessionId, newSessionId: id });
    this.deps.repos.createSession({ id, cwd: row.cwd, origin: "ui", originRef: null, provider });
    this.deps.repos.setSdkSessionId(id, forkedUuid);
    this.deps.repos.copySessionEvents(sessionId, id);
    this.deps.repos.setSessionLabel(id, forkLabel);
    this.deps.bus.emit({ type: "session.label", sessionId: id, label: forkLabel });
    return this.build(id, row.cwd, forkedUuid, null);
  }
```

> NOTE (implementer): check whether `setSessionModel`/`setSessionEffort` exist on `Repositories`. If master model/effort is per-session, use those setters; if it is resolved only from settings/overrides (not a session column), DROP the two `if (target.model/effort)` lines here and instead carry model/effort via the client `session.create`-style override — but since a fork reuses the session row, prefer adding `setSessionModel`/`setSessionEffort` only if the column already exists. If neither exists, leave model/effort to the existing per-session override mechanism and note it in the commit. Do not invent a column in this task.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/session-manager.test.ts`
Expected: PASS (both new cases + existing fork tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/session-manager.ts test/core/session-manager.test.ts
git commit -m "feat(fork): master cross-provider handoff branch in SessionManager.fork (T3)"
```

---

### Task 4: Master first-turn seed injection (`master-agent.ts`)

**Files:**
- Modify: `src/core/master-agent.ts` (`doTurn`, the user-echo block ~314-316, the `startTurn` call ~320, and turn completion)
- Test: `test/core/master-agent.test.ts`

**Interfaces:**
- Consumes: `buildHandoffSeed` (T2), `Repositories.getSession(...).handoff_from_provider`, `setSessionHandoffFrom` (T1).
- Behavior: when `handoff_from_provider` is set, `backend.startTurn` receives `seed + "\n\n" + userText` while the persisted/echoed user event stays `userText`; the marker is cleared after the turn completes successfully; a second turn sends `userText` alone.

- [ ] **Step 1: Write the failing test** — add to `test/core/master-agent.test.ts` using the existing `capture()` helper that records `startTurn` args:

```ts
it("injects the handoff seed into the FIRST turn's prompt but echoes only the user text, then clears the marker", async () => {
  const { master, repos, captured, sessionId } = makeMaster(); // harness whose backend records startTurn(text)
  repos.setSessionHandoffFrom(sessionId, "claude");
  repos.addSessionEvent({ sessionId, seq: 0, type: "master.message", payloadJson: JSON.stringify({ kind: "message", role: "user", content: "earlier ctx" }) });
  await master.runTurn("continue please");
  expect(captured.startText).toContain("earlier ctx");        // seed baked into the provider prompt
  expect(captured.startText).toContain("continue please");
  const userEvents = repos.listSessionEvents(sessionId).filter((e) => JSON.parse(e.payload_json).role === "user");
  expect(userEvents.some((e) => JSON.parse(e.payload_json).content === "continue please")).toBe(true);
  expect(userEvents.some((e) => JSON.parse(e.payload_json).content.includes("earlier ctx"))).toBe(false); // echo clean
  expect(repos.getSession(sessionId)!.handoff_from_provider).toBeNull(); // cleared after the turn
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/core/master-agent.test.ts -t "handoff seed"`
Expected: FAIL (seed not injected).

- [ ] **Step 3: Implement** — in `doTurn`, compute the prompt separately from the echo. At the top of the try (BEFORE the `addMessage`/`persistEvent`/`bus.emit` echo block), read the marker and build the seed; use `userText` for the echo and `promptText` for the backend:

```ts
      // Cross-provider handoff: on the FIRST turn of a handed-off session, prepend the source transcript to
      // the PROVIDER prompt (not the UI echo) so it bakes into turn-1's conversation. Built before the echo
      // below so the just-recorded user message isn't included in its own seed.
      const handoffFrom = opts?.notices ? null : repos.getSession(sessionId)?.handoff_from_provider ?? null;
      let promptText = userText;
      if (handoffFrom) {
        const events = repos.listSessionEvents(sessionId).map((e) => ({ type: e.type, payload: JSON.parse(e.payload_json) }));
        const seed = buildHandoffSeed(events, handoffFrom);
        if (seed) promptText = `${seed}\n\n${userText}`;
      }
```

Change the backend call to send `promptText`:

```ts
      const stream = this.opts.deps.backend.startTurn(promptText, {
```

(The echo block at `addMessage`/`persistEvent`/`bus.emit` stays `userText`.)

After the stream loop completes successfully (end of the try, before catch), clear the marker:

```ts
      if (handoffFrom) repos.setSessionHandoffFrom(sessionId, null); // seed baked into the now-established session
```

Add the import at the top: `import { buildHandoffSeed } from "./handoff.js";`

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/master-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/master-agent.ts test/core/master-agent.test.ts
git commit -m "feat(fork): master first-turn handoff seed injection (T4)"
```

---

### Task 5: Worker fork handoff branch (`FleetOrchestrator.fork`)

**Files:**
- Modify: `src/core/fleet-orchestrator.ts` (`fork`, ~lines 206-258; and the lazy-entry / materialize path to carry the seed)
- Test: `test/core/fleet-orchestrator.test.ts`

**Interfaces:**
- Consumes: `setWorkerHandoffFrom` (T1), `copyWorkerEvents`, existing worktree snapshot (`checkpoint`/`addWorktree`/`restoreCheckpoint`).
- Produces: `FleetOrchestrator.fork(id: string, target?: { provider?: string; model?: string; effort?: string }): Promise<{ id: string }>`. Cross-provider → new worker on `target.provider`, worktree snapshot as today, `handoff_from_provider` set, NO `forkSession`/`resumeSessionId`. The lazy entry records that a seed is pending (built on materialize).

- [ ] **Step 1: Write the failing test** — add to `test/core/fleet-orchestrator.test.ts`:

```ts
it("cross-provider worker fork snapshots the worktree, swaps provider, sets the handoff marker, no native fork", async () => {
  const { fo, repos, git, forkCalls } = makeFleet(); // harness with FakeGitOps + recording forkSession
  repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "app", worktreePath: "/wt/w1", branch: "rookery/w1", provider: "claude" });
  repos.setWorkerSdkSessionId("w1", "claude-uuid");
  repos.addWorkerEvent({ workerId: "w1", seq: 0, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "did work" }) });
  const { id } = await fo.fork("w1", { provider: "codex" });
  const row = repos.getWorker(id)!;
  expect(row.provider).toBe("codex");
  expect(row.handoff_from_provider).toBe("claude");
  expect(row.sdk_session_id).toBeNull();
  expect(forkCalls.length).toBe(0);
  expect(git.calls.some((c) => c.startsWith("addWorktree"))).toBe(true); // worktree still created
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/core/fleet-orchestrator.test.ts -t "cross-provider worker fork"`
Expected: FAIL.

- [ ] **Step 3: Implement** — add a target param + branch to `fork`. Reuse the snapshot/worktree block; when cross-provider, set `provider = target.provider`, skip `forkSession` (no `forkedUuid`), set the marker, and register the entry with `resumeSessionId: undefined` + `handoffFromProvider`:

```ts
  async fork(id: string, target?: { provider?: string; model?: string; effort?: string }): Promise<{ id: string }> {
    const src = this.deps.repos.getWorker(id);
    if (!src) throw new Error(`Unknown worker: ${id}`);
    if (this.restoring.has(id)) throw new Error(`worker ${id} is mid-restore; retry when the restore finishes`);
    if (!src.worktree_path || !this.exists(src.worktree_path)) throw new Error("this worker's worktree is gone — cannot fork");
    const srcProvider = src.provider ?? "claude";
    const handoff = !!target?.provider && target.provider !== srcProvider;
    if (!handoff && !src.sdk_session_id) throw new Error("this worker has no SDK session yet — nothing to fork");
    if (handoff && this.deps.repos.listWorkerEvents(id).length === 0) throw new Error("nothing to hand off — this worker has no transcript yet");
    if (!handoff && !this.deps.forkSession) throw new Error("worker forking is not available");
    const newId = this.idgen();
    const branch = `rookery/${newId}`;
    const worktreePath = path.join(this.deps.worktreesDir, newId);
    const label = handoff ? `${src.label} (→ ${target!.provider})` : `${src.label} (fork)`;
    const provider = handoff ? target!.provider! : srcProvider;
    const forkedUuid = handoff ? null : (await this.deps.forkSession!(srcProvider, src.sdk_session_id!, { title: label })).sessionId;
    let snapSha: string | null = null;
    try { snapSha = await this.deps.git.checkpoint(src.worktree_path, `refs/rookery/fork/${newId}`); } catch { snapSha = null; }
    try {
      await this.deps.git.addWorktree(src.repo_path, worktreePath, branch, src.branch ?? src.base ?? "HEAD");
      if (snapSha) { try { await this.deps.git.restoreCheckpoint(worktreePath, snapSha); } catch { /* best-effort */ } }
      this.deps.repos.createWorker({ id: newId, sessionId: src.session_id, repoPath: src.repo_path, label, worktreePath, branch, base: src.base ?? undefined, provider });
      if (forkedUuid) this.deps.repos.setWorkerSdkSessionId(newId, forkedUuid);
      if (handoff) this.deps.repos.setWorkerHandoffFrom(newId, srcProvider);
      const model = handoff ? target!.model : src.model;
      const effort = handoff ? target!.effort : src.effort;
      if (model) this.deps.repos.setWorkerModel(newId, model);
      if (src.permission_mode) this.deps.repos.setWorkerPermissionMode(newId, src.permission_mode);
      if (src.max_turns != null) this.deps.repos.setWorkerMaxTurns(newId, src.max_turns);
      if (src.cost_budget_usd != null) this.deps.repos.setWorkerCostBudgetUsd(newId, src.cost_budget_usd);
      if (effort) this.deps.repos.setWorkerEffort(newId, effort);
      this.deps.repos.copyWorkerEvents(id, newId);
      this.deps.repos.setWorkerStatus(newId, "idle", true);
      this.entries.set(newId, {
        homeSessionId: src.session_id, repoPath: src.repo_path, worktreePath, branch, base: src.base ?? "",
        status: "idle", label, model: model ?? undefined, permissionMode: src.permission_mode ?? undefined,
        maxTurns: src.max_turns ?? undefined, costBudgetUsd: src.cost_budget_usd ?? undefined, effort: effort ?? undefined, provider,
        resumeSessionId: forkedUuid ?? undefined, handoffFromProvider: handoff ? srcProvider : undefined,
      });
      this.deps.bus.emit({ type: "worker.spawned", sessionId: src.session_id, workerId: newId, repoPath: src.repo_path, label, branch, status: "idle", ticketKey: null, ticketUrl: null });
      return { id: newId };
    } catch (err) {
      try { await this.deps.git.removeWorktree(src.repo_path, worktreePath, branch); } catch { /* best-effort */ }
      try { await this.deps.git.removeCheckpointRefs(src.repo_path, newId); } catch { /* best-effort */ }
      throw err;
    }
  }
```

Add `handoffFromProvider?: string` to the internal entry type (the `this.entries` value type in this file). When the entry materializes into a `Worker` (the resume/materialize path in this file), build the seed and pass it: locate where `new Worker({...})`/the factory is called for a resumed entry and add:

```ts
      // Cross-provider handoff worker: build the one-shot seed from the copied transcript for its first turn.
      const handoffSeed = entry.handoffFromProvider
        ? buildHandoffSeed(this.deps.repos.listWorkerEvents(id).map((e) => ({ type: e.type, payload: JSON.parse(e.payload_json) })), entry.handoffFromProvider)
        : undefined;
```
and pass `handoffSeed` + `handoffFromProvider: entry.handoffFromProvider` into the worker factory options (consumed in Task 6). Import `buildHandoffSeed` from `./handoff.js`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/fleet-orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/fleet-orchestrator.ts test/core/fleet-orchestrator.test.ts
git commit -m "feat(fork): worker cross-provider handoff branch in FleetOrchestrator.fork (T5)"
```

---

### Task 6: Worker first-turn seed injection (`worker.ts`)

**Files:**
- Modify: `src/core/worker.ts` (constructor opts `handoffSeed`/`handoffFromProvider`; the first-turn text path in `start`/`send`; the sdk-id assignment ~303 to clear the marker)
- Modify: the worker factory in `src/daemon/server.ts` (`subFactory`) to forward `handoffSeed`/`handoffFromProvider`
- Test: `test/core/worker.test.ts`

**Interfaces:**
- Consumes: `handoffSeed` (built in T5), `setWorkerHandoffFrom` (T1).
- Behavior: on the worker's first turn, the backend receives `handoffSeed + "\n\n" + text`; the transcript records only `text`; the DB marker is cleared when the worker's `sdk_session_id` is first assigned.

- [ ] **Step 1: Write the failing test** — add to `test/core/worker.test.ts` (mirror the harness that inspects what the fake backend received vs what was recorded):

```ts
it("prepends the handoff seed to the first turn's backend text but records only the user text", async () => {
  const { worker, repos, backendText, id } = makeWorker({ handoffSeed: "<prior-conversation>ctx</prior-conversation>", handoffFromProvider: "claude" });
  worker.start("do the task");
  await settle(worker);
  expect(backendText()).toContain("ctx");           // seed reached the backend
  expect(backendText()).toContain("do the task");
  const recorded = repos.listWorkerEvents(id).filter((e) => JSON.parse(e.payload_json).role === "user");
  expect(recorded.some((e) => JSON.parse(e.payload_json).content === "do the task")).toBe(true);
  expect(recorded.some((e) => JSON.parse(e.payload_json).content.includes("ctx"))).toBe(false); // record clean
  expect(repos.getWorker(id)!.handoff_from_provider).toBeNull(); // cleared once sdk id assigned
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/core/worker.test.ts -t "handoff seed"`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `src/core/worker.ts`:
  - Add to the options type: `handoffSeed?: string; handoffFromProvider?: string;` and store `private handoffSeed = opts.handoffSeed;`.
  - Add a private helper that wraps the FIRST backend-bound text once, then disarms:

```ts
  // One-shot: prepend the cross-provider handoff seed to the FIRST turn's backend text (not the recorded/echoed
  // user text), then clear it so subsequent turns are unaffected. See docs/2026-07-08-cross-provider-fork-design.md.
  private withHandoffSeed(text: string): string {
    if (!this.handoffSeed) return text;
    const seeded = `${this.handoffSeed}\n\n${text}`;
    this.handoffSeed = undefined;
    return seeded;
  }
```

  - In `start(task)`: keep the transcript record as `task` (line ~97) but push the seeded text to the queue:

```ts
    this.record({ kind: "message", role: "user", content: task });
    this.queue.push(this.withHandoffSeed(task));
```

  - In `send(text, …)` on the idle/no-in-flight branch (line ~149): record/echo `text`, push `this.withHandoffSeed(text)` to the queue. (The `deferred` branch is for mid-run follow-ups and is never the first turn of a handoff worker — leave it unchanged.)
  - At the sdk-id assignment (~303), clear the DB marker on first assignment:

```ts
          if (ev.sessionId !== this.sdkSessionId) {
            this.sdkSessionId = ev.sessionId;
            this.opts.deps.repos.setWorkerSdkSessionId(this.id, ev.sessionId);
            if (this.opts.handoffFromProvider) this.opts.deps.repos.setWorkerHandoffFrom(this.id, null);
          }
```

  - Import `buildHandoffSeed` is NOT needed here (the seed is passed in from T5). Confirm the worker has `repos` access via `this.opts.deps.repos` (used already for events).
  - In `src/daemon/server.ts` `subFactory`, thread `handoffSeed`/`handoffFromProvider` from the factory option object into the `new Worker({...})` opts.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/worker.ts src/daemon/server.ts test/core/worker.test.ts
git commit -m "feat(fork): worker first-turn handoff seed injection (T6)"
```

---

### Task 7: Protocol + connection wiring

**Files:**
- Modify: `src/protocol/messages.ts` (`session.fork`, `worker.fork` schemas)
- Modify: `src/daemon/connection.ts` (`session.fork` handler ~168, `worker.fork` handler ~391)
- Test: `test/daemon/connection.test.ts`

**Interfaces:**
- Produces: `session.fork` and `worker.fork` accept optional `provider?: "claude"|"codex"`, `model?: string`, `effort?: string`; the connection forwards them as the `target` arg to `sessions.fork` / `fleet.fork`.

- [ ] **Step 1: Write the failing test** — add to `test/daemon/connection.test.ts`:

```ts
it("session.fork forwards provider/model to sessions.fork as the target", async () => {
  const calls: any[] = [];
  const sm = { fork: async (id: string, target?: unknown) => { calls.push({ id, target }); return { id: "f1", cwd: "/x" }; } } as any;
  const { conn, sent } = setupWith({ sessions: sm });   // a setup variant injecting a stub SessionManager
  await conn.handleRaw(JSON.stringify({ type: "session.fork", sessionId: "src", reqId: "f", provider: "codex", model: "gpt-5.5" }));
  expect(calls[0].target).toEqual({ provider: "codex", model: "gpt-5.5", effort: undefined });
});
```

(If the existing connection test harness can't stub `SessionManager.fork`, instead assert end-to-end: fork a real source session cross-provider and check the created session's `provider`/`handoff_from_provider` — reuse the T3 fakes.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/daemon/connection.test.ts -t "session.fork forwards"`
Expected: FAIL (params ignored).

- [ ] **Step 3: Implement** — schemas in `messages.ts`:

```ts
  z.object({ type: z.literal("session.fork"), sessionId: z.string(), reqId: z.string().optional(), provider: z.enum(["claude", "codex"]).optional() }),
```
(session.fork carries only `provider` — master model/effort is a client-side per-session override, applied by T8 after the fork, not a daemon session column.)
```ts
  z.object({ type: z.literal("worker.fork"), reqId: z.string(), id: z.string(), provider: z.enum(["claude", "codex"]).optional(), model: z.string().optional(), effort: z.string().optional() }),
```

Handlers in `connection.ts`:

```ts
      case "session.fork": {
        try {
          const session = await this.sessions.fork(msg.sessionId, { provider: msg.provider });
          this.reply({ type: "session.created", sessionId: session.id, cwd: session.cwd, reqId: msg.reqId });
        } catch (err) { this.reply({ type: "error", message: err instanceof Error ? err.message : String(err), reqId: msg.reqId }); }
        return;
      }
```
```ts
      case "worker.fork": {
        try {
          const { id } = await this.fleet.fork(msg.id, { provider: msg.provider, model: msg.model, effort: msg.effort });
          this.reply({ type: "fleet.spawn.result", reqId: msg.reqId, id });
        } catch (err) { this.reply({ type: "error", message: err instanceof Error ? err.message : String(err), reqId: msg.reqId }); }
        return;
      }
```

(Keep whatever the existing `session.fork` handler did for the reply shape; only add the target arg. `{provider:undefined,…}` = today's behavior.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/daemon/connection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/messages.ts src/daemon/connection.ts test/daemon/connection.test.ts
git commit -m "feat(fork): protocol + connection pass provider/model/effort to fork (T7)"
```

---

### Task 8: Desktop Fork dialog + wiring + i18n

**Files:**
- Create: `apps/desktop/src/renderer/components/ForkDialog.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx` (open the dialog from the Sessions/RepoTree fork menu instead of instant fork; send `session.fork`/`worker.fork` with the chosen target)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/forkDialog.ts` (new namespace)
- Test: `apps/desktop/test/fork-dialog.test.tsx`

**Interfaces:**
- Consumes: store `codexAuthStatus` (from `feat/codex-auth-probe`), `codexModels`, `models`, `settings`.
- Produces: `<ForkDialog kind="master"|"worker" sourceProvider={…} onFork={(target) => …} onClose={…} />` where `target = { provider, model, effort }`.

- [ ] **Step 1: Write the failing test** — `apps/desktop/test/fork-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ForkDialog } from "../src/renderer/components/ForkDialog.js";
import { useStore } from "../src/renderer/store/store.js";

describe("ForkDialog", () => {
  it("defaults the target provider to the OTHER provider and forks with the chosen target", () => {
    const onFork = vi.fn();
    render(<ForkDialog kind="master" sourceProvider="claude" onFork={onFork} onClose={() => {}} />);
    // target defaults to codex (the other provider)
    fireEvent.click(screen.getByRole("button", { name: /fork|포크/i }));
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex" }));
  });

  it("disables Fork and warns when target=codex is not authenticated (auth-probe gate)", () => {
    useStore.getState().setCodexAuthStatus({ method: "none", ready: false, hint: null });
    render(<ForkDialog kind="master" sourceProvider="claude" onFork={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/codex.*(인증|auth)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fork|포크/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/desktop/test/fork-dialog.test.tsx` (from repo root: `npm -w apps/desktop exec vitest run test/fork-dialog.test.tsx`)
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** the `ForkDialog` component (provider pill toggle default = other provider; model picker driven by `codexModels`/`models`; effort selector; codex-not-ready warning + disabled Fork reading `codexAuthStatus`; a "Fork" button calling `onFork({provider, model, effort})`). Mirror `WorkerSpawnModal`/`NewSessionPage` for the pickers and modal chrome. Add the `forkDialog.*` i18n keys (ko + en, identical key sets). Wire `App.tsx`:
  - **Master fork:** send `{ type: "session.fork", sessionId, provider }` (provider only). After it returns, if a model/effort was chosen, apply them as the new session's per-session override (the existing `overrides` store slot + `setOverride`), so its turns use the chosen codex/claude model. Then navigate (reuse current post-fork navigation).
  - **Worker fork:** send `{ type: "worker.fork", id, provider, model, effort }` (workers persist model/effort as columns). Navigate to the returned worker.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm -w apps/desktop run typecheck && npm -w apps/desktop exec vitest run test/fork-dialog.test.tsx test/i18n`
Expected: PASS (component + i18n parity).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/components/ForkDialog.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/i18n/locales/ko/forkDialog.ts apps/desktop/src/renderer/i18n/locales/en/forkDialog.ts apps/desktop/test/fork-dialog.test.tsx
git commit -m "feat(fork): desktop Fork dialog with provider/model pick + codex-auth gate (T8)"
```

---

### Task 9: Full-suite gate + docs

- [ ] **Step 1:** Root `npm run typecheck && npm test` — all green.
- [ ] **Step 2:** Desktop `npm -w apps/desktop run typecheck && npm -w apps/desktop test` — all green.
- [ ] **Step 3:** Update the design doc's status header + `CLAUDE.md`/`docs` if the fork section needs the cross-provider note. Commit.

## Self-Review (completed)

- **Spec coverage:** U1 seed→T2; U2 fork→T3(master)/T5(worker); U3 injection→T4(master)/T6(worker); U4 data model→T1; U5 protocol→T7; U6 dialog→T8. All covered.
- **Type consistency:** `target: { provider?; model?; effort? }` identical across T3/T5/T7; `handoff_from_provider` column + `setSessionHandoffFrom`/`setWorkerHandoffFrom` consistent T1↔T3/T4/T5/T6; `buildHandoffSeed(events, sourceProvider, maxBytes?)` consistent T2↔T4/T5; entry `handoffFromProvider` T5↔T6; `handoffSeed` worker opt T5↔T6.
- **Open verification flagged inline:** T3 note on whether `setSessionModel`/`setSessionEffort` exist (don't invent a column); T5/T6 exact materialize call site + factory threading.
