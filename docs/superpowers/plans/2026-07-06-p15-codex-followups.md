# P1.5 Codex Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the P1.5 backlog: real per-turn Codex cost (Track B), fork timeout (D), workspace-write network alignment (E), in-app `codexApiKey` via CODEX_HOME redirection + RPC provisioning (C), and the desktop provider UX (A: spawn selector, badges, settings Codex tab). Spec: `docs/2026-07-06-p15-codex-followups.md` (scope table, designs, verified RATES).

**Architecture:** Tasks 1-3 are daemon-only (`src/core/codex/*`, settings, protocol). Tasks 4-5 are renderer-only (`apps/desktop/src/renderer/*`), grounded in the explored conventions map embedded per-task below. Task 6 is docs + full gates.

**Tech Stack:** unchanged (TS ESM NodeNext, vitest; renderer React+vitest/jsdom). No new dependencies. No DB migrations.

## Global Constraints

- **Node 22 first** for every command: `source ~/.nvm/nvm.sh && nvm use 22`.
- ESM NodeNext (`.js` relative imports, `import type`); English comments; no Claude-SDK imports under `src/core/codex/` (neutrality gate).
- **Dual gates**: every task runs root `npm run typecheck && npm test`; tasks 3-6 ADDITIONALLY run `npm -w apps/desktop run typecheck && npm -w apps/desktop test` (P1 broke desktop typecheck by editing `SettingsValues` without the desktop gate — do not repeat it).
- Renderer i18n: every new key goes to BOTH `apps/desktop/src/renderer/i18n/locales/ko/*` and `.../en/*` (parity test `apps/desktop/test/i18n/catalog.test.ts` enforces identical key sets; `used-keys.test.ts` requires every static `t("ns.key")` literal to exist in ko).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Pricing — per-turn usage aggregation + RATES (daemon, TDD)

**Files:**
- Modify: `src/core/codex/codex-backend.ts`, `src/core/codex/codex-pricing.ts`
- Test: `test/core/codex/codex-backend.test.ts`, `test/core/codex/codex-vocab.test.ts` (pricing cases live there today)

**Interfaces:**
- Consumes: `CodexTokenUsageBreakdown` (codex-protocol), fake-codex `tokenUsage` step (`{ kind: "tokenUsage", last: {...}, contextWindow? }` — extend it: add optional `total?: { inputTokens: number; cachedInputTokens?: number; outputTokens?: number }`; when present the fake emits it as `tokenUsage.total`, else it mirrors `last` as today).
- Produces: `turnCostUsd(model, usage)` unchanged signature, RATES filled; CodexStream accumulates per-turn deltas.

- [ ] **Step 1: Write the failing tests.** In `test/core/codex/codex-backend.test.ts` append:

```ts
describe("CodexBackend — pricing aggregation", () => {
  it("sums per-update TOTAL deltas across a multi-call turn (fresh session baseline = zeros)", async () => {
    const { backend: b } = backend(() => [
      { kind: "tokenUsage", last: { inputTokens: 800, cachedInputTokens: 200 }, total: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 } },
      { kind: "tokenUsage", last: { inputTokens: 900, cachedInputTokens: 700 }, total: { inputTokens: 2600, cachedInputTokens: 900, outputTokens: 150 } },
      { kind: "turnEnd" },
    ]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts({ model: "gpt-5.5" })));
    const end = events.find((e) => e.kind === "turn_end") as { costUsd: number };
    // turn delta vs zeros: input 2600 (cached 900), output 150
    // cost = (2600-900)*5.00/1M + 900*0.50/1M + 150*30.00/1M = 0.0085 + 0.00045 + 0.0045
    expect(end.costUsd).toBeCloseTo(0.01345, 10);
  });

  it("resume: first tokenUsage update only sets the baseline (thread history not billed)", async () => {
    const { backend: b } = backend(() => [
      { kind: "tokenUsage", last: { inputTokens: 100 }, total: { inputTokens: 50_000, cachedInputTokens: 10_000, outputTokens: 9_000 } }, // history-inclusive
      { kind: "tokenUsage", last: { inputTokens: 100 }, total: { inputTokens: 51_000, cachedInputTokens: 10_500, outputTokens: 9_100 } },
      { kind: "turnEnd" },
    ]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts({ model: "gpt-5.5", resume: "th-1" })));
    const end = events.find((e) => e.kind === "turn_end") as { costUsd: number };
    // only the second update's delta bills: input 1000 (cached 500), output 100
    // cost = 500*5.00/1M + 500*0.50/1M + 100*30.00/1M = 0.0025 + 0.00025 + 0.003
    expect(end.costUsd).toBeCloseTo(0.00575, 10);
  });

  it("accumulator resets per turn and clamps negative deltas to 0", async () => {
    const { backend: b } = backend((_t, turn) => turn === 0
      ? [{ kind: "tokenUsage", last: { inputTokens: 1 }, total: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 } }, { kind: "turnEnd" }]
      : [{ kind: "tokenUsage", last: { inputTokens: 1 }, total: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 50 } }, { kind: "turnEnd" }]); // total went BACKWARD (compaction/reset) — clamp
    const q = new MessageQueue(); q.push("a"); q.push("b"); q.close();
    const events = await collect(b.openSession(q, baseOpts({ model: "gpt-5.5" })));
    const ends = events.filter((e) => e.kind === "turn_end") as Array<{ costUsd: number }>;
    expect(ends[0]!.costUsd).toBeCloseTo(1000 * 5 / 1e6 + 100 * 30 / 1e6, 10);
    expect(ends[1]!.costUsd).toBe(0); // clamped, not negative
  });
});
```

In `test/core/codex/codex-vocab.test.ts`, replace the pricing zero-table test with rate-table cases:

```ts
  it("prices known models and returns 0 for unknown/absent", () => {
    expect(turnCostUsd("gpt-5.5", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBeCloseTo(5.0, 10);
    expect(turnCostUsd("gpt-5.5", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.5, 10);
    expect(turnCostUsd("gpt-5.4-mini", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(4.5, 10);
    expect(turnCostUsd("gpt-5.5-pro", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(30.0, 10); // no cache discount tier
    expect(turnCostUsd("some-unknown", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(turnCostUsd("gpt-5.5", undefined)).toBe(0);
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/core/codex/` → the new cases fail (fake lacks `total`; RATES empty; no accumulation).

- [ ] **Step 3: Extend the fake.** In `test/helpers/fake-codex.ts`, the `tokenUsage` step gains `total?: { inputTokens: number; cachedInputTokens?: number; outputTokens?: number }`; its emission becomes `tokenUsage: { last: step.last, total: step.total ?? step.last, modelContextWindow: step.contextWindow ?? null }`.

- [ ] **Step 4: Fill RATES** in `src/core/codex/codex-pricing.ts` (verified 2026-07-06, developers.openai.com/api/docs/pricing, standard tier; keep the inclusive-input comment and add these notes verbatim):

```ts
// Verified 2026-07-06 (developers.openai.com/api/docs/pricing, standard tier, USD per 1M tokens).
// Reasoning tokens bill as output tokens (Responses API). Long-context surcharge (>272K input:
// 2x input / 1.5x output) is NOT modeled — Codex's harness caps gpt-5.5 context (~258K) below it.
// Pro tiers have no cached-input discount → cachedInput = input rate. Unknown model → 0.
const RATES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.5-pro": { input: 30.0, cachedInput: 30.0, output: 180.0 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
};
```

- [ ] **Step 5: Implement the accumulator** in `src/core/codex/codex-backend.ts` (CodexStream). Replace the `lastUsage` field with:

```ts
  // Per-turn billing accumulator: deltas of the thread-cumulative tokenUsage.total between
  // updates (multi-call turns sum every call — see docs/2026-07-06-p15-codex-followups.md Track B).
  // Fresh session: baseline zeros (thread totals start at 0). Resumed session: baseline null —
  // the FIRST update only sets it (its one call is uncounted; the resume response carries no baseline).
  private prevTotal: CodexTokenUsageBreakdown | null;
  private turnAccum = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
```

Initialize in the constructor: `this.prevTotal = opts.resume ? null : { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };`
In the `thread/tokenUsage/updated` handler (keep the existing `last`-based context tracking), add:

```ts
      const total = p?.tokenUsage?.total;
      if (total) {
        if (this.prevTotal === null) {
          this.prevTotal = total; // resumed stream: baseline only
        } else {
          this.turnAccum.inputTokens += Math.max(0, (total.inputTokens ?? 0) - (this.prevTotal.inputTokens ?? 0));
          this.turnAccum.cachedInputTokens += Math.max(0, (total.cachedInputTokens ?? 0) - (this.prevTotal.cachedInputTokens ?? 0));
          this.turnAccum.outputTokens += Math.max(0, (total.outputTokens ?? 0) - (this.prevTotal.outputTokens ?? 0));
          this.prevTotal = total;
        }
      }
```

In the `turn/completed` handler: `costUsd: turnCostUsd(this.overrideModel ?? (this.opts.model || this.deps.defaultModel()), this.turnAccum),` and after pushing turn_end reset `this.turnAccum = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };`. Remove the now-dead `lastUsage` field/updates.

- [ ] **Step 6: Green + gates** — `npx vitest run test/core/codex/ && npm run typecheck && npm test` → PASS. (Note: existing tests asserting `costUsd: 0` stay valid — their scripts emit no `total` deltas.)
- [ ] **Step 7: Commit** — `git add -A src test && git commit -m "feat(codex): per-turn cost from tokenUsage.total deltas + verified RATES table" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Fork timeout + always-explicit sandbox policy (daemon, TDD)

**Files:**
- Modify: `src/core/codex/codex-backend.ts`
- Test: `test/core/codex/codex-backend.test.ts` (+ `test/helpers/fake-codex.ts` if a "never answer thread/fork" knob is needed)

- [ ] **Step 1: Failing tests** (append):

```ts
describe("CodexBackend — fork timeout & explicit sandbox", () => {
  it("forkSession rejects after the timeout when the child never answers", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [], { silentForkHang: true }); // new opt: thread/fork gets NO response
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
      const p = b.forkSession("th-1");
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("every turn/start carries explicit approvalPolicy + sandboxPolicy derived from the CURRENT mode", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
    const q = new MessageQueue(); q.push("t1"); q.close();
    await collect(b.openSession(q, baseOpts({ permissionMode: "acceptEdits" })));
    const turn = fake.requests.find((r) => r.method === "turn/start")!.params as Record<string, unknown>;
    expect(turn.approvalPolicy).toBe("never");
    expect(turn.sandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: true }); // rookery decision: workspace-write is always network-on
  });
});
```

(Adjust imports: `vi` from vitest, `CodexBackend`, `fakeCodexSpawn` are already imported. The existing setModel/setPermissionMode override test asserts turn 1 has NO sandboxPolicy — that assertion inverts under this change: update it to assert turn 1 carries the SPAWN mode's policy (`dangerFullAccess` for bypassPermissions) and turn 2 carries the OVERRIDE's (`readOnly`). This is the one sanctioned assertion change; every other assertion stays.)

- [ ] **Step 2: Implement.**
  - fake: add `silentForkHang?: boolean` to `FakeCodexServerOpts` — when true, `thread/fork` requests get no response at all.
  - `forkSession`: wrap the body after client construction in a race:

```ts
  private static readonly FORK_TIMEOUT_MS = 15_000;

  async forkSession(threadId: string): Promise<{ sessionId: string }> {
    const transport = this.deps.spawn({ env: this.deps.env?.() });
    const client = new CodexClient(transport);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A hung ephemeral child must not wedge the worker.fork request forever.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`codex fork timed out after ${CodexBackend.FORK_TIMEOUT_MS / 1000}s`)), CodexBackend.FORK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.doFork(client, threadId), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      client.close();
    }
  }
```

with `doFork` holding the previous initialize→initialized→thread/fork body (minus close). NOTE: `this.deps.env?.()` appears here ahead of Task 3 introducing `env` — for THIS task use `this.deps.spawn({})` and let Task 3 change it; do not add the env dep yet.
  - Explicit per-turn policy: in pump's turn loop, replace the `modeOverride`-conditional spread with an unconditional current-mode application:

```ts
        const mode = mapPermissionMode(this.overrideMode ?? this.opts.permissionMode);
        // Always explicit: sandbox/approval identical regardless of path (spawn vs live override),
        // and workspace-write is always network-on by rookery decision (spec Track E).
        await client.request("turn/start", {
          threadId,
          input,
          ...(this.overrideModel ? { model: this.overrideModel } : {}),
          ...(effort ? { effort } : {}),
          approvalPolicy: mode.approvalPolicy,
          sandboxPolicy: sandboxPolicyFor(mode.sandbox),
        });
```

(the thread-start string `sandbox` stays as-is; rename local variables as needed to avoid the `mode` name already used at thread-start assembly — reuse it if scoping allows).

- [ ] **Step 3: Green + gates** — focused codex suite, then root typecheck+test.
- [ ] **Step 4: Commit** — `git add -A src test && git commit -m "feat(codex): fork timeout; always-explicit per-turn sandbox/approval (workspace-write network-on)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: In-app `codexApiKey` — CODEX_HOME redirection + RPC provisioning (daemon, TDD)

**Files:**
- Modify: `src/core/settings.ts` (write-only secret, EXACT `anthropicApiKey` pattern), `src/protocol/messages.ts` (settings.set key, same nullable/optional style as `anthropicApiKey`), `src/core/codex/codex-backend.ts` (deps + provisioning), `src/daemon/server.ts` (env resolver + apiKey wiring), `src/core/codex/codex-transport.ts` (no change expected — env passthrough already exists)
- Test: `test/core/codex/codex-backend.test.ts`, `test/core/settings.test.ts`, `test/daemon/connection.test.ts` (settings.set round trip: secret accepted, never echoed)

**Interfaces:**
- `CodexBackendDeps` gains `apiKey?: () => string | undefined` and `env?: () => NodeJS.ProcessEnv | undefined`; every `this.deps.spawn({})` call site becomes `this.deps.spawn({ env: this.deps.env?.() })`.
- server.ts wiring:

```ts
  const codexHomeDir = path.join(config.homeDir, "codex-home"); // adjust to the Config field's real name — read src/config.ts
  const codexBackend = new CodexBackend({
    spawn: realCodexSpawn(() => settings.codexBin()),
    defaultModel: () => settings.codexWorkerModel(),
    apiKey: () => settings.codexApiKey(),
    // In-app key set → redirect the child to a rookery-managed CODEX_HOME (auth.json + rollouts
    // live under our control; the user's ~/.codex is untouched). Unset → inherit ~/.codex (P1 behavior).
    env: () => {
      if (!settings.codexApiKey()) return undefined;
      fs.mkdirSync(codexHomeDir, { recursive: true });
      return { CODEX_HOME: codexHomeDir };
    },
  });
```

- Provisioning in `CodexStream.pump()`, immediately after `client.notify("initialized", {})`:

```ts
      // In-app API key: provision the (redirected) CODEX_HOME's auth.json once via RPC —
      // the app-server ignores CODEX_API_KEY env (P1 finding). Subsequent spawns skip via account/read.
      const apiKey = this.deps.apiKey?.();
      if (apiKey) {
        const acct = (await client.request("account/read", {})) as { requiresOpenaiAuth?: boolean } | null;
        if (acct?.requiresOpenaiAuth) {
          await client.request("account/login/start", { type: "apiKey", apiKey });
        }
      }
```

(a login failure rejects → pump throws → worker `error` with the auth message — intended.)

- [ ] **Step 1: Failing tests.** Backend: three cases via the fake — extend `FakeCodexServerOpts` with `requiresOpenaiAuth?: boolean` (default false) so `account/read` answers `{ requiresOpenaiAuth }` and `account/login/start` answers `{}` (both recorded in `requests` like everything else):
  - apiKey set + requiresOpenaiAuth:true → requests contain `account/read` then `account/login/start` with `{ type: "apiKey", apiKey: "sk-test" }`, before any `thread/start`;
  - apiKey set + requiresOpenaiAuth:false → `account/read` present, NO `account/login/start`;
  - no apiKey → NO `account/read`.
  Settings: `codexApiKey` registered write-only (mirror the existing anthropicApiKey settings test cases — set → `values()`/`all()` does NOT echo it; accessor returns it). Connection: settings.set with `codexApiKey` accepted and not present in the `settings.result` echo (mirror the anthropicApiKey case if one exists; else add both assertions in one new case).
- [ ] **Step 2: Implement** (settings + protocol key + backend deps/provisioning + server wiring as specced; find the exact secret-registration mechanism by reading how `anthropicApiKey` is declared in `src/core/settings.ts` — SECRET list/branch — and mirror it byte-for-pattern).
- [ ] **Step 3: Green + ALL gates** — root typecheck+test AND `npm -w apps/desktop run typecheck && npm -w apps/desktop test` (settings.set schema changed; secrets are not in SettingsValues so desktop fixtures should be untouched — the gate PROVES it).
- [ ] **Step 4: Commit** — `git add -A src test && git commit -m "feat(codex): in-app codexApiKey — CODEX_HOME redirection + account/login/start provisioning" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 4: Renderer — spawn modal provider selector (TDD)

**Files** (all under `apps/desktop/`):
- Modify: `src/renderer/components/WorkerSpawnModal.tsx`, `src/renderer/App.tsx`, `src/renderer/i18n/locales/ko/workerSpawnModal.ts`, `.../en/workerSpawnModal.ts`
- Test: `test/worker-spawn-modal.test.tsx`

Conventions map (from exploration — trust these anchors, read the files for exact surrounding code):
- Modal state pattern: `WorkerSpawnModal.tsx:30-37` (`useState` per field); selects block `:114-142`; **permissionMode select `:131-134` (hardcoded `<option>`s) is the idiom to copy**; callback signature `:26`; `spawn()` builder `:82-85` → `onSpawn(task, label, model?, effort?, base?, ticket?, permissionMode?)` — add `provider` as a new trailing optional arg.
- App wiring: modal rendered `App.tsx:1237-1248` (defaults from `s.settings.workerModel/workerEffort`); `spawnSub` handler `:647-659` builds the `fleet.spawn` request at `:651` — add `provider` there with the existing enum-cast idiom (`provider as "claude" | "codex" | undefined`).
- UI primitives: `src/renderer/ui/input.tsx` `<Select size="sm">` in the modal; `MODELS` catalog in `lib/models.ts` is Claude-only — do NOT touch it.

- [ ] **Step 1: Failing test** — in `test/worker-spawn-modal.test.tsx` (reuse its `renderModal()` helper + the `within(listbox)` gotcha documented there): a case selecting provider "codex", filling the task, spawning → `onSpawn` receives `provider === "codex"`; a default case → `provider === undefined` or `"claude"` (match whatever the implementation emits for default — pick `undefined` for wire-minimalism and assert that); and when provider is codex the MODEL field becomes a free-text input whose placeholder is the codex default (passed in as a new `codexDefaultModel` prop; assert placeholder swap).
- [ ] **Step 2: Implement:**
  - `provider` state (default `"claude"`); a `<Select size="sm">` with two options labeled via new i18n keys `workerSpawnModal.providerClaude` / `workerSpawnModal.providerCodex` (ko+en; values "Claude"/"Codex" both locales — proper nouns) + a `workerSpawnModal.provider` label key.
  - When `provider === "codex"`: swap the model `<Select>` for a free-text `<Input>` (empty → daemon default) with placeholder from a new optional prop `codexDefaultModel?: string`; keep the effort select (codex accepts low..xhigh; `max` maps daemon-side).
  - `spawn()` passes `provider === "claude" ? undefined : provider` as the trailing arg (wire-minimal: absent means claude).
  - `App.tsx`: extend `spawnSub`'s signature + the `fleet.spawn` request object; pass `codexDefaultModel={s.settings.codexWorkerModel || "gpt-5.5"}` where the modal is rendered.
- [ ] **Step 3: Gates** — `npx vitest run test/worker-spawn-modal.test.tsx` (from apps/desktop) then `npm -w apps/desktop run typecheck && npm -w apps/desktop test` AND root `npm run typecheck && npm test` (should be untouched — proves it).
- [ ] **Step 4: Commit** — `git add -A apps/desktop && git commit -m "feat(desktop): provider selector in worker spawn modal (codex model free-text)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 5: Renderer — provider badges + settings Codex tab (TDD)

**Files** (all under `apps/desktop/`):
- Modify: `src/renderer/views/RepoTree.tsx`, `src/renderer/components/WorkspaceHeaders.tsx`, `src/renderer/components/SettingsPage.tsx`, `src/renderer/App.tsx`, `src/renderer/i18n/locales/{ko,en}/settings.ts`
- Test: `test/workspace-headers.test.tsx`, `test/repo-tree.test.tsx`, `test/settings-page.test.tsx`

Conventions map anchors:
- `FleetRow extends WorkerRow` (`store/reduce.ts:17`) — `provider` already flows; default `"claude"` at render, NO type/store edits.
- Fleet row: `RepoTree.tsx` `subButton` `:105-173`, right-indicator cluster `:151-159` (`<WorkerCost>` :151, status tag :155) with the `group-hover:opacity-0` yield idiom; badge idiom = `StatusBadge.tsx` span (`inline-flex rounded-md border px-1.5 py-0.5 font-mono text-[11px]`).
- Worker header: `WorkspaceHeaders.tsx` `WorkerHeader` `:71-100` — badge next to the eyebrow `:80`/branch `:82`. Badge text "Codex" as a literal (proper noun — no i18n key needed for the text itself); render NO badge for claude/absent (visual default).
- Settings: new `"codex"` tab — union `SettingsPage.tsx:31`, `tabs` array `:84-89`, new `{tab === "codex" && ...}` section. The tab must KEEP the Save button (do NOT add it to the exclusion at `:361` — codex text fields are f-backed). Field pattern: worker-model Field `:140-145` (`f.codexBin ?? ""` etc.). Secret pattern for `codexApiKey`: mirror the Anthropic key block `:347-354` — separate `useState("")`, `type="password"`, placeholder `t("settings.secretSaved")` when set-state says so, dedicated save Button → new prop `onSaveCodexKey`; App.tsx handler mirrors `onSaveAnthropicKey` `:1017-1022` (`settings.set { codexApiKey: key }`). NOTE: unlike anthropicApiKey there is no auth-status indicator for codex — render the field without a "currently set" probe (placeholder logic: after save, clear local state and show a saved note via the same pattern the slack tokens use, see `:209-217`).
- i18n keys (ko+en both, parity test enforced): `settings.tabCodex`, `settings.codexTitle`, `settings.codexDesc`, `settings.codexBin`, `settings.codexBinHint` (hint MUST mention: desktop-spawned daemons often lack `~/.local/bin` on PATH — use an absolute path), `settings.codexWorkerModel`, `settings.codexWorkerModelHint`, `settings.codexApiKey`, `settings.codexApiKeyHint` (mention: empty = use `codex login` / `~/.codex/auth.json`).
- Fixture warning: `test/settings-page.test.tsx:5-12` full `SettingsValues` literal already carries codexBin/codexWorkerModel (hotfix 986da1b) — extend assertions, don't re-add fields.

- [ ] **Step 1: Failing tests:**
  - `workspace-headers.test.tsx`: WorkerHeader with `provider: "codex"` renders a "Codex" badge; with `provider: undefined` renders none.
  - `repo-tree.test.tsx`: a fleet row with `provider: "codex"` shows the badge (follow the file's existing row-fixture pattern).
  - `settings-page.test.tsx`: codex tab exists (`fireEvent.click(getByText("Codex"))` or via `settings.tabCodex` ko literal); `codexBin` input round-trips into `onSave(f)` payload; `onSaveCodexKey` fires with the typed key and the local field clears.
- [ ] **Step 2: Implement** per anchors above.
- [ ] **Step 3: Gates** — focused files, then `npm -w apps/desktop run typecheck && npm -w apps/desktop test`, then root gates.
- [ ] **Step 4: Commit** — `git add -A apps/desktop && git commit -m "feat(desktop): codex provider badges + settings Codex tab (bin/model/apiKey)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 6: Docs + full gates sweep

**Files:**
- Modify: `AGENTS.md`, `docs/2026-07-05-codex-backend-parity.md`, `docs/2026-07-06-p1-codex-worker-backend.md`, `docs/2026-07-06-p15-codex-followups.md`

- [ ] **Step 1: AGENTS.md** (grep for anchors; surgical):
  - Update the Codex-auth pitfalls bullet: in-app `codexApiKey` now EXISTS — when set, workers run under `<rookery home>/codex-home` (CODEX_HOME redirection + `account/login/start` provisioning; toggling the key strands old thread rollouts in the other home — resume of pre-toggle workers fails cleanly until restored). Unset → P1 behavior (`~/.codex`, `codex login`).
  - Add one pitfalls bullet: **root gates don't cover apps/desktop** — any change to shared daemon types consumed by the renderer (`SettingsValues`, `WorkerRow`, notice codes) must also run `npm -w apps/desktop run typecheck && npm -w apps/desktop test` (P1 broke desktop typecheck this way).
- [ ] **Step 2: Status blockquotes** — parity doc: P1.5 implemented (provider UX, pricing, apiKey, fork timeout, network alignment; remaining: P2 master, trust-cleanup, numTurns granularity). P1 spec doc: mark Track-E/M3 decision RESOLVED (always network-on) and codexApiKey deferral RESOLVED (P1.5 Track C). P1.5 spec doc: implemented status line.
- [ ] **Step 3: Full gates** — `npm run typecheck && npm test && npm run build && npm -w apps/desktop run typecheck && npm -w apps/desktop test` — all green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs(codex): P1.5 status; desktop-gate + CODEX_HOME pitfalls" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Post-plan (controller)

Live smoke: settings.set `codexApiKey` unset path is covered by the P1 smoke; re-run a priced turn and confirm non-zero `costUsd` on turn_end (gpt-5.5 RATES) + spawn modal manual sanity is deferred to the user's next desktop run (renderer verified by component tests). Then final whole-branch review (fable) → merge.

## Self-Review Notes

- Task order: daemon (1-3) before renderer (4-5) because Task 5's settings tab needs Task 3's `codexApiKey` protocol key.
- Task 2/Task 3 both touch `forkSession` (timeout wraps body; env lands in Task 3) — sequenced to avoid conflict: Task 2 keeps `spawn({})`, Task 3 swaps every spawn call to `{ env: this.deps.env?.() }`.
- The ONE sanctioned assertion change (Task 2: override test's turn-1 no-sandboxPolicy inverts) is called out explicitly — everything else is append-only.
- Pricing math cross-checked by hand: 0.01345 = 1700×5e-6 + 900×0.5e-6 + 150×30e-6 ✓; 0.00575 = 500×5e-6 + 500×0.5e-6 + 100×30e-6 ✓.
