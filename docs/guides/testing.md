# Testing

> **Source of truth:** `test/helpers/fake-query.ts`, `test/core/master-agent.test.ts`, `test/persistence/db.test.ts`, the root and `apps/desktop` vitest configs — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

Tests run on **vitest**. Thanks to the transport-agnostic core and dependency-injected ports, **unit tests run with no real SDK, git, or network** — every external boundary has a fake. The gate before committing is always `npm run typecheck` **and** `npm test` (tsx/vitest do not typecheck).

## Layout

Tests mirror `src/**` **1:1** under `test/**` (e.g. `src/core/scheduler.ts` → `test/core/scheduler.test.ts`). Shared fakes/builders live in `test/helpers/`. The desktop has its own suite under `apps/desktop/test/**` (jsdom).

## The injected ports + their fakes

The core never imports WS/CLI/Slack/Electron; it receives ports as interfaces, so tests pass fakes:

- **`QueryFn` (the SDK `query()`)** → `fakeQuery` / `fakeStreamingQuery` (`test/helpers/fake-query.ts`). The canonical SDK mock. You give it a script of `FakeStep`s (`assistant` text, `tool_use`, `tool_result`, `thinking`, `message_start` usage, `result`, …) and it yields SDK-shaped messages.
- **`GitOps`** → `FakeGitOps` (records calls, no shell-out). `RealGitOps` is verified separately against a temp repo (`fs.mkdtempSync`).
- **`Repositories`** → `new Repositories(openDb(":memory:"), now?)`. In-memory SQLite; pass an injected `now()` clock for deterministic timestamps.
- **`EventBus`** → real, but you `bus.subscribe(channel, (e) => events.push(e))` to assert emitted events.
- **Scheduler/dispatcher** take injected `now()` / `schedule()` so time-based logic is deterministic (no real timers).

## `fakeQuery` — the two variants and the caveat

- `fakeQuery(script, opts?)` (`test/helpers/fake-query.ts:56`) — **finite**: it runs through the script once and the generator **terminates**. This matches the **master's** single-shot turn model (string prompt + `resume`).
- `fakeStreamingQuery(responder)` (`test/helpers/fake-query.ts:83`) — faithful to the streaming-input SDK: it stays alive per `MessageQueue` message until the input is closed. This matches the **worker** model and exposes the "stay idle after a turn" lifecycle.

⚠️ **Caveat:** `fakeQuery` is finite, so the worker reaches `done` when the script ends. A **real** streaming iterator only ends when its input is closed. This gap hides happy-path lifecycle bugs — **don't treat green `fakeQuery` tests as end-to-end proof** of worker lifecycle; use `fakeStreamingQuery` for worker-lifecycle tests.

## Capturing `query()` options

To assert what options (`model`/`effort`/`systemPrompt`/`permissionMode`) the agent passed to `query()`, wrap the fake in a capturing closure. See `capture()` in `test/core/master-agent.test.ts:22`:

```ts
function capture(d) {
  let captured = {};
  const wrapped = ((input) => { captured = input.options ?? {}; return d.queryFn(input); });
  return { d: { ...d, queryFn: wrapped }, opts: () => captured };
}
```

This is how the "model/effort re-evaluated every turn" behavior is verified — change the resolver between turns and assert `opts()` reflects it. The same file's `deps()` (`test/core/master-agent.test.ts:12`) is the canonical way to assemble a `MasterAgent`'s dependency bag (in-memory repos + EventBus + FakeGitOps + fake fleet factory + `model`/`effort`/`name` resolvers).

## Fleet flows

Background fleet work (spawn → run → settle) is async. Await it with `FleetOrchestrator.waitAllSettled()` — `waitUntilSettled()` resolves **only on termination** (stopped/done/error), not on idle. Don't poll or `setTimeout`; use the settle promise.

## Schema/version test

`test/persistence/db.test.ts` asserts `currentVersion(db) === MIGRATIONS.length`, that expected tables exist, and that a future-versioned DB is rejected. Add to it when you change the schema (see [add-a-db-migration.md](add-a-db-migration.md)).

## Desktop tests

`apps/desktop` runs vitest under **jsdom** (globals on, `test/setup.ts` loads `jest-dom`). Notable suites:
- `apps/desktop/test/i18n/catalog.test.ts` — ko/en key-set parity + no namespace collisions.
- `apps/desktop/test/i18n/used-keys.test.ts` — every literal `t("ns.key")` in renderer source exists in the ko catalog.
- The store reducer (`store/reduce.ts`) is a pure function, unit-tested directly.

Component tests assert **Korean** text because `useT` **falls back to ko** when no `I18nProvider` is present. Keep that in mind when writing assertions. CSP regressions are *not* caught by jsdom (only by `npm run dev` / `build:mac`).

## Commands

```bash
# root (daemon/engine)
npm test                                            # vitest run
npm run test:watch
npx vitest run test/core/fleet-orchestrator.test.ts # one file
npx vitest run -t "spawns"                           # by test-name pattern
npm run typecheck                                    # REQUIRED gate (tsx/vitest don't typecheck)

# desktop
npm -w apps/desktop test
npm -w apps/desktop run typecheck
```

Node 22 is mandatory — `better-sqlite3` (used by in-memory test DBs) is built for ABI 127; the wrong Node fails to load it. See [AGENTS.md](../../AGENTS.md).

Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
