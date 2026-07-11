# Codex Usage Panel (Provider Tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop bottom-left Usage panel gains a Claude|Codex tab toggle (Claude default); the Codex tab shows live 5h/weekly utilization gauges and today/weekly token counts fetched from a short-lived `codex app-server` child.

**Architecture:** A poll provider (`makeCodexUsageProvider`, mirroring `codex-models-provider.ts`) reads `account/rateLimits/read` + `account/usage/read` per fetch; `UsageCollector` calls it each refresh like `oauthUsage` and carries the result in a new `UsageSnapshot.codex` field; the existing `usage.get` protocol flows it to the renderer unchanged; `UsagePanel` renders per-tab bodies. Spec: `docs/superpowers/specs/2026-07-11-codex-usage-panel-design.md` (records the live-probed RPC shapes).

**Tech Stack:** TypeScript ESM (NodeNext — `.js` on relative imports, `import type`), vitest, React 18 + Tailwind (desktop), zero-dep in-house i18n.

## Global Constraints

- Node 22 required (`node --version` must be v22) before any npm/vitest command.
- Code comments in English.
- Root gates: `npm test && npm run typecheck`. Desktop gates (Task 3): `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- Provider failure contract: ANY failure (spawn / timeout / RPC error / malformed / no usable data) → `fetch()` resolves `null`; it never throws and never caches.
- The provider must use the same `env`/`apiKey` resolvers the codex turn children use (account-mismatch prevention — parity with models-provider findings [25]/[26]).
- Codex shows NO `$` figures anywhere (plan billing has no USD notion).
- i18n invariants: ko/en key parity + every `t("…")` literal exists in the catalog (enforced by `apps/desktop/test/i18n` tests).
- Commit trailer (verbatim): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Live-probed response shapes (2026-07-11, codex 0.144.1):
  - `account/rateLimits/read` → `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":1,"windowDurationMins":300,"resetsAt":1783762463},"secondary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1784310150},"credits":{...},"planType":"pro",...}}` (resetsAt = unix seconds)
  - `account/usage/read` → `{"summary":{"lifetimeTokens":4390142180,...},"dailyUsageBuckets":[{"startDate":"2026-05-06","tokens":454185},...]}`

---

### Task 1: Core provider — `makeCodexUsageProvider` + fake-codex support

**Files:**
- Create: `src/core/codex-usage-provider.ts`
- Modify: `test/helpers/fake-codex.ts` (two new opts + handlers)
- Test: `test/core/codex-usage-provider.test.ts` (new)

**Interfaces:**
- Consumes: `CodexClient` (`src/core/codex/codex-client.js`), `CodexSpawn` (`src/core/codex/codex-transport.js`) — same as `codex-models-provider.ts`.
- Produces (Task 2 depends on these exact names):
  - `export interface CodexRateWindow { usedPercent: number; resetsAt: number | null }`
  - `export interface CodexUsage { fiveHour: CodexRateWindow | null; sevenDay: CodexRateWindow | null; planType: string | null; todayTokens: number | null; weeklyTokens: number | null }`
  - `export function mapCodexUsage(rateLimitsRes: unknown, usageRes: unknown, now: Date): CodexUsage | null`
  - `export function makeCodexUsageProvider(opts: { spawn: CodexSpawn; timeoutMs?: number; env?: () => NodeJS.ProcessEnv | undefined; apiKey?: () => string | undefined; now?: () => Date }): { fetch(): Promise<CodexUsage | null> }`

- [ ] **Step 1: Add the two response opts to the fake codex server**

In `test/helpers/fake-codex.ts`, add to `FakeCodexServerOpts`:

```ts
  rateLimits?: unknown; // account/rateLimits/read result (absent → generic empty {} via the fallback)
  accountUsage?: unknown; // account/usage/read result (absent → generic empty {})
```

and add handlers right before the final generic-fallback line (`// any other request: generic empty result`):

```ts
        if (msg.method === "account/rateLimits/read") { send({ id: msg.id, result: opts.rateLimits ?? {} }); return; }
        if (msg.method === "account/usage/read") { send({ id: msg.id, result: opts.accountUsage ?? {} }); return; }
```

- [ ] **Step 2: Write the failing tests**

Create `test/core/codex-usage-provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeCodexUsageProvider, mapCodexUsage } from "../../src/core/codex-usage-provider.js";
import { fakeCodexSpawn } from "../helpers/fake-codex.js";
import type { CodexSpawn, CodexTransport } from "../../src/core/codex/codex-transport.js";

// Live-probed shapes (2026-07-11, codex 0.144.1) — see the design spec.
const RATE_LIMITS = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1783762463 },
    secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1784310150 },
    planType: "pro",
  },
};
const ACCOUNT_USAGE = {
  summary: { lifetimeTokens: 4390142180 },
  dailyUsageBuckets: [
    { startDate: "2026-07-11", tokens: 1000 },
    { startDate: "2026-07-08", tokens: 200 },
    { startDate: "2026-07-01", tokens: 99999 }, // outside the 7-day window
  ],
};
const NOW = new Date(2026, 6, 11, 12, 0, 0); // local 2026-07-11

// Spawn/handshake-level failure (codex binary missing): never answers, exits immediately.
function erroringTransport(): CodexTransport {
  let exitCb: (info: { code: number | null; message?: string }) => void = () => {};
  queueMicrotask(() => exitCb({ code: 1, message: "spawn failed" }));
  return { write: () => {}, onLine: () => {}, onExit: (cb) => { exitCb = cb; }, kill: () => {} };
}
const erroringSpawn: CodexSpawn = () => erroringTransport();

describe("mapCodexUsage", () => {
  it("maps gauges (primary→fiveHour, secondary→sevenDay), planType, today/weekly bucket sums", () => {
    const u = mapCodexUsage(RATE_LIMITS, ACCOUNT_USAGE, NOW)!;
    expect(u.fiveHour).toEqual({ usedPercent: 37, resetsAt: 1783762463 });
    expect(u.sevenDay).toEqual({ usedPercent: 12, resetsAt: 1784310150 });
    expect(u.planType).toBe("pro");
    expect(u.todayTokens).toBe(1000);
    expect(u.weeklyTokens).toBe(1200); // 07-11 + 07-08; 07-01 excluded (last-7-days window)
  });

  it("partial: rateLimits only → gauges with null tokens; usage only → tokens with null gauges", () => {
    const rlOnly = mapCodexUsage(RATE_LIMITS, null, NOW)!;
    expect(rlOnly.fiveHour?.usedPercent).toBe(37);
    expect(rlOnly.todayTokens).toBeNull();
    expect(rlOnly.weeklyTokens).toBeNull();
    const usageOnly = mapCodexUsage(null, ACCOUNT_USAGE, NOW)!;
    expect(usageOnly.fiveHour).toBeNull();
    expect(usageOnly.sevenDay).toBeNull();
    expect(usageOnly.weeklyTokens).toBe(1200);
  });

  it("no usable data at all → null (treated as failure upstream)", () => {
    expect(mapCodexUsage(null, null, NOW)).toBeNull();
    expect(mapCodexUsage({}, {}, NOW)).toBeNull();
    expect(mapCodexUsage({ rateLimits: { primary: { usedPercent: "bad" } } }, { dailyUsageBuckets: "nope" }, NOW)).toBeNull();
  });

  it("a day with no bucket → todayTokens 0 (buckets exist), not null", () => {
    const u = mapCodexUsage(null, { dailyUsageBuckets: [{ startDate: "2026-07-08", tokens: 200 }] }, NOW)!;
    expect(u.todayTokens).toBe(0);
    expect(u.weeklyTokens).toBe(200);
  });
});

describe("makeCodexUsageProvider", () => {
  it("fetches both RPCs from a scripted app-server and maps them", async () => {
    const fake = fakeCodexSpawn(() => [], { rateLimits: RATE_LIMITS, accountUsage: ACCOUNT_USAGE });
    const provider = makeCodexUsageProvider({ spawn: fake.spawn, now: () => NOW });
    const u = await provider.fetch();
    expect(u?.fiveHour?.usedPercent).toBe(37);
    expect(u?.weeklyTokens).toBe(1200);
    expect(fake.requests.map((r) => r.method)).toEqual(["initialize", "account/rateLimits/read", "account/usage/read"]);
  });

  it("does NOT cache: a second fetch hits the server again (fresh child)", async () => {
    const fake = fakeCodexSpawn(() => [], { rateLimits: RATE_LIMITS, accountUsage: ACCOUNT_USAGE });
    const provider = makeCodexUsageProvider({ spawn: fake.spawn, now: () => NOW });
    await provider.fetch();
    await provider.fetch();
    expect(fake.spawns.length).toBe(2);
  });

  it("spawn failure → null (never throws)", async () => {
    const provider = makeCodexUsageProvider({ spawn: erroringSpawn, timeoutMs: 200 });
    await expect(provider.fetch()).resolves.toBeNull();
  });

  it("provisions the in-app apiKey before reading (account/read → account/login/start ordering)", async () => {
    const fake = fakeCodexSpawn(() => [], { rateLimits: RATE_LIMITS, accountUsage: ACCOUNT_USAGE, requiresOpenaiAuth: true });
    const provider = makeCodexUsageProvider({ spawn: fake.spawn, apiKey: () => "sk-test", now: () => NOW });
    const u = await provider.fetch();
    expect(u).not.toBeNull();
    expect(fake.requests.map((r) => r.method)).toEqual(["initialize", "account/read", "account/login/start", "account/rateLimits/read", "account/usage/read"]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/core/codex-usage-provider.test.ts`
Expected: FAIL (module `src/core/codex-usage-provider.ts` does not exist).

- [ ] **Step 4: Implement the provider**

Create `src/core/codex-usage-provider.ts`:

```ts
import { CodexClient } from "./codex/codex-client.js";
import type { CodexSpawn } from "./codex/codex-transport.js";

// One codex rate-limit window (from account/rateLimits/read). resetsAt is unix SECONDS.
export interface CodexRateWindow { usedPercent: number; resetsAt: number | null }

// Codex account usage for the Usage panel's Codex tab. No USD anywhere — codex plan billing has
// no per-token cost notion (design spec non-goal).
export interface CodexUsage {
  fiveHour: CodexRateWindow | null; // rateLimits.primary (observed windowDurationMins 300)
  sevenDay: CodexRateWindow | null; // rateLimits.secondary (observed 10080)
  planType: string | null;
  todayTokens: number | null; // dailyUsageBuckets entry with startDate === today (local)
  weeklyTokens: number | null; // sum of buckets in the last 7 days (today inclusive)
}

const CLIENT_INFO = { name: "rookery", title: "rookery", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 10_000;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mapWindow(w: unknown): CodexRateWindow | null {
  const o = w as { usedPercent?: unknown; resetsAt?: unknown } | null | undefined;
  if (typeof o?.usedPercent !== "number") return null;
  return { usedPercent: o.usedPercent, resetsAt: typeof o.resetsAt === "number" ? o.resetsAt : null };
}

// Pure response→CodexUsage mapping (exported for tests). Tolerant duck-typed decode: each side
// failing alone still yields the other's data; NOTHING usable → null (the provider treats that
// as a failed fetch so the collector keeps its previous snapshot).
export function mapCodexUsage(rateLimitsRes: unknown, usageRes: unknown, now: Date): CodexUsage | null {
  const rl = (rateLimitsRes as { rateLimits?: { primary?: unknown; secondary?: unknown; planType?: unknown } } | null | undefined)?.rateLimits;
  const fiveHour = mapWindow(rl?.primary);
  const sevenDay = mapWindow(rl?.secondary);
  const planType = typeof rl?.planType === "string" ? rl.planType : null;

  const buckets = (usageRes as { dailyUsageBuckets?: unknown } | null | undefined)?.dailyUsageBuckets;
  let todayTokens: number | null = null;
  let weeklyTokens: number | null = null;
  if (Array.isArray(buckets)) {
    const todayStr = ymd(now);
    const last7 = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      last7.add(ymd(d));
    }
    let weekSum = 0;
    let sawAny = false;
    for (const b of buckets) {
      const o = b as { startDate?: unknown; tokens?: unknown };
      if (typeof o.startDate !== "string" || typeof o.tokens !== "number") continue;
      sawAny = true;
      if (o.startDate === todayStr) todayTokens = (todayTokens ?? 0) + o.tokens;
      if (last7.has(o.startDate)) weekSum += o.tokens;
    }
    if (sawAny) {
      weeklyTokens = weekSum;
      todayTokens = todayTokens ?? 0; // buckets exist but none for today = genuinely 0, not unknown
    }
  }

  if (!fiveHour && !sevenDay && todayTokens == null && weeklyTokens == null) return null;
  return { fiveHour, sevenDay, planType, todayTokens, weeklyTokens };
}

// Poll provider for the Usage panel's Codex tab: one short-lived `codex app-server` child per
// fetch() — initialize → (optional in-app apiKey provisioning, same dance as the models/auth
// providers) → account/rateLimits/read + account/usage/read → map. NEVER caches (rate limits must
// stay fresh; the UsageCollector interval is the cadence) and never throws — any failure → null.
// env/apiKey are the SAME resolvers the codex turn children use, so the child authenticates under
// the account the turns run under (models-provider findings [25]/[26] parity).
export function makeCodexUsageProvider(opts: {
  spawn: CodexSpawn;
  timeoutMs?: number;
  env?: () => NodeJS.ProcessEnv | undefined;
  apiKey?: () => string | undefined;
  now?: () => Date;
}): { fetch(): Promise<CodexUsage | null> } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async fetch() {
      let client: CodexClient | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Inside the try so a synchronously-throwing spawn also degrades to null (models-provider parity).
        client = new CodexClient(opts.spawn({ env: opts.env?.() }));
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("codex usage read timed out")), timeoutMs);
        });
        await Promise.race([client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }), timeout]);
        client.notify("initialized", {});
        const apiKey = opts.apiKey?.();
        if (apiKey) {
          const acct = (await Promise.race([client.request("account/read", {}), timeout])) as { requiresOpenaiAuth?: boolean } | null;
          if (acct?.requiresOpenaiAuth) await Promise.race([client.request("account/login/start", { type: "apiKey", apiKey }), timeout]);
        }
        // Per-read catch: one read failing alone must not sink the other (partial data beats none).
        const rateLimits = await Promise.race([client.request("account/rateLimits/read", {}), timeout]).catch(() => null);
        const usage = await Promise.race([client.request("account/usage/read", {}), timeout]).catch(() => null);
        return mapCodexUsage(rateLimits, usage, opts.now?.() ?? new Date());
      } catch {
        return null; // codex missing / not authed / timeout / malformed → null
      } finally {
        if (timer) clearTimeout(timer);
        client?.close();
      }
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/core/codex-usage-provider.test.ts`
Expected: ALL pass.

- [ ] **Step 6: Full root gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/codex-usage-provider.ts test/helpers/fake-codex.ts test/core/codex-usage-provider.test.ts
git commit -m "feat(core): codex usage provider (rate-limit gauges + daily token buckets)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Snapshot + collector + daemon wiring

**Files:**
- Modify: `src/core/usage.ts` (UsageSnapshot + UsageCollector)
- Modify: `src/daemon/server.ts` (provider construction + collector opt)
- Test: `test/core/usage.test.ts` (append)

**Interfaces:**
- Consumes: `CodexUsage`, `makeCodexUsageProvider` from Task 1 (exact names above); existing `codexEnv` / `codexApiKey` / `realCodexSpawn(() => settings.codexBin())` closures in server.ts (the ones `makeCodexModelsProvider` already receives).
- Produces: `UsageSnapshot.codex: CodexUsage | null` (Task 3 renders it); `UsageCollector` opt `codexUsage?: () => Promise<CodexUsage | null>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/core/usage.test.ts` (reuse the file's existing imports/fixtures; add `import type { CodexUsage } from "../../src/core/codex-usage-provider.js";` and `emptyUsage` to the usage.js import):

```ts
describe("UsageCollector — codex", () => {
  const cx: CodexUsage = { fiveHour: { usedPercent: 37, resetsAt: 1783762463 }, sevenDay: { usedPercent: 12, resetsAt: null }, planType: "pro", todayTokens: 1000, weeklyTokens: 1200 };
  const failingExec = { run: async () => { throw new Error("no ccusage"); } };

  it("emptyUsage carries codex: null", () => {
    expect(emptyUsage().codex).toBeNull();
  });

  it("collect stores a successful codex fetch in the snapshot", async () => {
    const c = new UsageCollector({ exec: failingExec, refreshMs: 999999, codexUsage: async () => cx });
    await c.collect();
    expect(c.snapshot().codex).toEqual(cx);
  });

  it("a null/throwing codex fetch keeps the previous codex value (transient failure must not blank the panel)", async () => {
    let fail = false;
    const c = new UsageCollector({ exec: failingExec, refreshMs: 999999, codexUsage: async () => { if (fail) throw new Error("down"); return cx; } });
    await c.collect();
    fail = true;
    await c.collect();
    expect(c.snapshot().codex).toEqual(cx); // kept
    const c2 = new UsageCollector({ exec: failingExec, refreshMs: 999999, codexUsage: async () => null });
    await c2.collect();
    expect(c2.snapshot().codex).toBeNull(); // never had data — stays null
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/core/usage.test.ts`
Expected: FAIL (`codex` not on the snapshot type / unknown collector opt).

- [ ] **Step 3: Implement**

In `src/core/usage.ts`:
- Add `import type { CodexUsage } from "./codex-usage-provider.js";` at the top.
- Add to `UsageSnapshot` (after `pct`): `codex: CodexUsage | null; // codex account usage (rate-limit gauges + token buckets); null = codex absent/unfetched`
- Add `codex: null` to the object in `emptyUsage()`.
- Add to the `UsageCollector` constructor opts (after `oauthUsage`): `codexUsage?: () => Promise<CodexUsage | null>; // codex gauges/tokens (if absent, codex is not collected)`
- In `doCollect()`, insert between the oauth block and the ccusage block:

```ts
    // codex gauges/tokens — short-lived app-server child (fast). Failure keeps the previous value:
    // a transient spawn/auth blip must not blank the panel.
    if (this.opts.codexUsage) {
      try {
        const cx = await this.opts.codexUsage();
        if (cx) this.snap = { ...this.snap, codex: cx, updatedAt: stamp() };
      } catch {
        /* keep the previous codex */
      }
    }
```

In `src/daemon/server.ts`:
- Add `import { makeCodexUsageProvider } from "../core/codex-usage-provider.js";` next to the `makeCodexModelsProvider` import.
- Directly above the `new UsageCollector({ … })` construction, add:

```ts
  // Codex usage for the desktop Usage panel's Codex tab — same spawn/env/apiKey closures as the
  // codex models/auth providers so it authenticates under the account the turns run under.
  const codexUsageProvider = makeCodexUsageProvider({ spawn: realCodexSpawn(() => settings.codexBin()), env: codexEnv, apiKey: codexApiKey });
```

- Add `codexUsage: () => codexUsageProvider.fetch(),` to the `UsageCollector` constructor opts (next to `oauthUsage`).
- ⚠️ `codexEnv`/`codexApiKey` are defined earlier in `startDaemon` (they're already passed to `makeCodexModelsProvider`); if the UsageCollector block sits above their definitions, move the provider construction to just after them and only reference it in the collector opts — do not reorder unrelated code.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/usage.test.ts`
Expected: ALL pass (new + pre-existing).

- [ ] **Step 5: Full root gate**

Run: `npm test && npm run typecheck`
Expected: PASS. (Watch for other `UsageSnapshot` literal constructions failing the new required field — fix by adding `codex: null`.)

- [ ] **Step 6: Commit**

```bash
git add src/core/usage.ts src/daemon/server.ts test/core/usage.test.ts
git commit -m "feat(daemon): carry codex usage in the UsageSnapshot (collector + wiring)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Desktop — Claude|Codex tabs in the Usage panel

**Files:**
- Modify: `apps/desktop/src/renderer/components/UsagePanel.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/usagePanel.ts` + `en/usagePanel.ts`
- Test: `apps/desktop/test/usage-panel.test.tsx` (existing literals + new tests)

**Interfaces:**
- Consumes: `UsageSnapshot.codex` from Task 2 (type flows via the `@daemon/core/usage.js` type-only import); existing `Meter`/`Stat`/`fmtTok` in UsagePanel.
- Produces: UI only.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/test/usage-panel.test.tsx`:
- Add `fireEvent` to the testing-library import.
- The existing `UsageSnapshot` literal(s) gain `codex: null` (Task 2 made the field required — desktop typecheck enforces it).
- Append:

```tsx
  const cx = { fiveHour: { usedPercent: 37, resetsAt: 1783762463 }, sevenDay: { usedPercent: 12, resetsAt: null }, planType: "pro", todayTokens: 1000, weeklyTokens: 1200 };
  const base: UsageSnapshot = { session: null, weekly: null, today: null, pct: null, codex: null, updatedAt: null, error: null };

  it("defaults to the Claude tab; clicking Codex swaps title and body", () => {
    render(<UsagePanel usage={{ ...base, today: { totalTokens: 1000, costUSD: 1.23 }, codex: cx }} />);
    expect(screen.getByText("Claude 사용량 (계정 전체)")).toBeInTheDocument(); // Claude default
    expect(screen.getByText("1.0k · $1.23")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("Codex 사용량 (계정 전체)")).toBeInTheDocument();
    expect(screen.getByText(/37%/)).toBeInTheDocument(); // 5h gauge
    expect(screen.getByText(/12%/)).toBeInTheDocument(); // weekly gauge
    expect(screen.getByText("1.0k")).toBeInTheDocument(); // today tokens, NO $
    expect(screen.queryByText("1.0k · $1.23")).toBeNull(); // claude body hidden
  });

  it("Codex tab without data shows the unavailable hint (tab stays discoverable)", () => {
    render(<UsagePanel usage={{ ...base, today: { totalTokens: 5, costUSD: 0 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("Codex 사용량 없음 — codex 설치/로그인을 확인하세요")).toBeInTheDocument();
  });

  it("switching back to Claude restores the claude body", () => {
    render(<UsagePanel usage={{ ...base, today: { totalTokens: 1000, costUSD: 1.23 }, codex: cx }} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByText("1.0k · $1.23")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm -w apps/desktop test -- usage-panel`
Expected: FAIL (no tab buttons; `codex` unknown on the literals until Task 2's field lands — run after Task 2).

- [ ] **Step 3: Add the i18n keys**

`apps/desktop/src/renderer/i18n/locales/ko/usagePanel.ts` — add:

```ts
  "usagePanel.tabClaude": "Claude",
  "usagePanel.tabCodex": "Codex",
  "usagePanel.titleCodex": "Codex 사용량 (계정 전체)",
  "usagePanel.titleHintCodex": "codex app-server의 계정 레이트리밋·일별 토큰 집계 — 이 앱 사용분만이 아니라 계정 전체 사용량입니다.",
  "usagePanel.codexUnavailable": "Codex 사용량 없음 — codex 설치/로그인을 확인하세요",
  "usagePanel.resets": "{time} 리셋",
```

`en/usagePanel.ts` — add:

```ts
  "usagePanel.tabClaude": "Claude",
  "usagePanel.tabCodex": "Codex",
  "usagePanel.titleCodex": "Codex usage (account-wide)",
  "usagePanel.titleHintCodex": "Account rate limits and daily tokens from the codex app-server — account-wide, not just this app's usage.",
  "usagePanel.codexUnavailable": "No Codex usage — check codex install/login",
  "usagePanel.resets": "resets {time}",
```

- [ ] **Step 4: Implement the tabs**

In `apps/desktop/src/renderer/components/UsagePanel.tsx`:
- `import { memo, useState } from "react";`
- Add a reset-time formatter next to `fmtTok`/`usd`:

```tsx
function fmtReset(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
```

- Rework `UsagePanelImpl`:

```tsx
function UsagePanelImpl({ usage, loadFailed }: { usage: UsageSnapshot | null; loadFailed?: boolean }): JSX.Element {
  const t = useT();
  // Provider tab: Claude is the default (user direction); not persisted (YAGNI).
  const [tab, setTab] = useState<"claude" | "codex">("claude");
  const p = usage?.pct;
  const wk = usage?.weekly;
  const hasAny = !!(p || usage?.session || wk || usage?.today);
  const cdx = usage?.codex;
  return (
    <div className="border-t border-line pt-1">
      {/* Always-rendered header (audit #55/#56): per-tab title + provider tab toggle. */}
      <div className="flex items-center gap-1 px-2 pt-1 text-[10.5px] text-muted">
        <span>{t(tab === "claude" ? "usagePanel.title" : "usagePanel.titleCodex")}</span>
        <Tooltip label={t(tab === "claude" ? "usagePanel.titleHint" : "usagePanel.titleHintCodex")} side="top">
          <Info size={11} tabIndex={0} aria-label={t(tab === "claude" ? "usagePanel.titleHint" : "usagePanel.titleHintCodex")} className="shrink-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent/50" />
        </Tooltip>
        <div className="ml-auto flex items-center gap-0.5">
          {(["claude", "codex"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              className={cn("rounded px-1.5 py-0.5 text-[10px] leading-none transition-colors", tab === k ? "bg-line text-fg" : "text-muted hover:text-fg-dim")}
            >
              {t(k === "claude" ? "usagePanel.tabClaude" : "usagePanel.tabCodex")}
            </button>
          ))}
        </div>
      </div>

      {/* Shared pre-load states (gate on the snapshot itself, not per-tab). */}
      {!usage && !loadFailed && <SkeletonRows rows={2} className="px-2 py-1.5" />}
      {!usage && loadFailed && <div className="px-2 py-1.5 text-[10.5px] text-muted">{t("usagePanel.loadFailed")}</div>}

      {usage && tab === "claude" && (
        <>
          {!hasAny && <div className="px-2 py-1.5 text-[10.5px] text-muted">{t("usagePanel.loading")}</div>}
          {hasAny && (
            <>
              {/* Server-side % (official, same source as /usage) */}
              {p?.fiveHour != null && <Meter label={t("usagePanel.session5h")} pct={p.fiveHour} sub={usage.session ? `${fmtTok(usage.session.totalTokens)} · ${usd(usage.session.costUSD)}` : undefined} />}
              {p?.sevenDay != null && <Meter label={t("usagePanel.weekly")} pct={p.sevenDay} sub={wk ? `${fmtTok(wk.totalTokens)} · ${usd(wk.costUSD)}` : undefined} />}
              {p?.sevenDayOpus != null && <Meter label={t("usagePanel.weeklyOpus")} pct={p.sevenDayOpus} />}
              {p?.sevenDaySonnet != null && <Meter label={t("usagePanel.weeklySonnet")} pct={p.sevenDaySonnet} />}

              {/* ccusage tokens/$ (no gauge needed) */}
              {!p && usage.session && <Stat label={t("usagePanel.session5h")} value={`${fmtTok(usage.session.totalTokens)} · ${usd(usage.session.costUSD)}`} />}
              {!p && wk && <Stat label={t("usagePanel.weekly")} value={`${fmtTok(wk.totalTokens)} · ${usd(wk.costUSD)}`} />}
              {usage.today && <Stat label={t("usagePanel.today")} value={`${fmtTok(usage.today.totalTokens)} · ${usd(usage.today.costUSD)}`} />}
              {p?.extra && <Stat label={t("usagePanel.extraCredits")} value={`${usd(p.extra.usedCredits)} / ${usd(p.extra.monthlyLimit)}`} />}
            </>
          )}
        </>
      )}

      {usage && tab === "codex" && (
        cdx ? (
          <>
            {/* codex plan billing has no USD — tokens only, never $ */}
            {cdx.fiveHour && <Meter label={t("usagePanel.session5h")} pct={cdx.fiveHour.usedPercent} sub={cdx.fiveHour.resetsAt != null ? t("usagePanel.resets", { time: fmtReset(cdx.fiveHour.resetsAt) }) : undefined} />}
            {cdx.sevenDay && <Meter label={t("usagePanel.weekly")} pct={cdx.sevenDay.usedPercent} sub={cdx.weeklyTokens != null ? fmtTok(cdx.weeklyTokens) : undefined} />}
            {cdx.todayTokens != null && <Stat label={t("usagePanel.today")} value={fmtTok(cdx.todayTokens)} />}
          </>
        ) : (
          <div className="px-2 py-1.5 text-[10.5px] text-muted">{t("usagePanel.codexUnavailable")}</div>
        )
      )}
    </div>
  );
}
```

(The Claude branch is the existing body verbatim, only re-indented under the tab condition — do not alter its expressions.)

- [ ] **Step 5: Run the desktop gates**

Run: `npm -w apps/desktop run typecheck && npm -w apps/desktop test`
Expected: PASS — new tests green, existing usage-panel tests green (Claude default preserves them), i18n parity/used-keys tests pick up the new keys.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/components/UsagePanel.tsx apps/desktop/src/renderer/i18n/locales/ko/usagePanel.ts apps/desktop/src/renderer/i18n/locales/en/usagePanel.ts apps/desktop/test/usage-panel.test.tsx
git commit -m "feat(desktop): Claude|Codex tabs in the Usage panel (codex gauges + tokens)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Post-plan (main session, not a subagent task)

Live verification per spec §6: exercise `makeCodexUsageProvider` against the real codex binary (a small tsx script mirroring the unit test but with `realCodexSpawn`) and confirm a real `CodexUsage` comes back; optionally boot the daemon and confirm `usage.get` carries the `codex` block.
