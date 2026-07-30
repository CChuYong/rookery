# Codex Usage Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx ccusage codex daily` report rookery's codex masters and workers alongside the user's own codex usage, without changing any runtime path.

**Architecture:** A new daemon-side module hardlinks every rollout under `<ROOKERY_HOME>/codex-homes/*/sessions/` into the user's real `CODEX_HOME` at `archived_sessions/<same relative path>`. ccusage scans that tree; codex keeps archived rollouts out of `thread/list` and refuses to resume them, so the user's own picker stays clean and the shared inode never gets a second writer. `src/daemon/server.ts` calls the sync at boot, on a `usageRefreshMs` interval, and once per target immediately before its home is deleted.

**Tech Stack:** TypeScript (ESM, NodeNext — relative imports need the `.js` extension), Node 22, vitest, `node:fs` only (no new dependency).

Spec: [`docs/superpowers/specs/2026-07-30-codex-usage-mirror-design.md`](../specs/2026-07-30-codex-usage-mirror-design.md)

## Global Constraints

- **Node 22 must be active** before anything (`nvm use 22`) — `better-sqlite3` is built against ABI 127.
- ESM NodeNext: relative imports carry `.js`; type-only imports use `import type` (`verbatimModuleSyntax: true`).
- `src/core/` must not be touched by this feature — it is transport-agnostic and must not write to the user's filesystem. All new code lives in `src/daemon/`.
- The mirror **never throws**. Every failure degrades to a counter, matching `src/daemon/codex-home.ts`'s contract.
- Directories created with mode `0700`; the `EXDEV` copy fallback chmods the copy to `0600`.
- Destination-relative paths come from `path.relative(<home>/sessions, file)` — never string-prefix stripping.
- No new setting, no protocol change, no event, no migration. The mirror is always on.
- Comments in English (repo convention). Commit trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Gates before the final commit: `npm run typecheck` and `npm test`. The desktop workspace gates are not implicated — no shared type the renderer consumes changes.

---

### Task 1: `codex-usage-mirror.ts` — full-sweep sync

**Files:**
- Create: `src/daemon/codex-usage-mirror.ts`
- Test: `test/daemon/codex-usage-mirror.test.ts`

**Interfaces:**
- Consumes: `codexHomeDirFor(rookeryHome, targetId, kind)` from `./codex-home.js` (Task 2 only).
- Produces:
  ```ts
  export interface CodexUsageMirrorResult { linked: number; skipped: number; failed: number }
  export interface CodexUsageMirrorDeps {
    link?: (src: string, dest: string) => void;   // default fs.linkSync — injectable for the EXDEV test
  }
  export function syncCodexUsageMirror(
    rookeryHome: string,
    realCodexHome: string,
    deps?: CodexUsageMirrorDeps,
  ): CodexUsageMirrorResult
  ```

- [ ] **Step 1: Write the failing test**

Create `test/daemon/codex-usage-mirror.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncCodexUsageMirror } from "../../src/daemon/codex-usage-mirror.js";

let tmp: string;
let rookeryHome: string;
let realCodexHome: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-test-"));
  rookeryHome = path.join(tmp, "rookery");
  realCodexHome = path.join(tmp, "codex");
  fs.mkdirSync(realCodexHome, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Writes a rollout into a rookery codex home and returns its absolute path.
function writeRollout(homeName: string, rel: string, content = '{"type":"session_meta"}\n'): string {
  const file = path.join(rookeryHome, "codex-homes", homeName, "sessions", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const mirrored = (rel: string): string => path.join(realCodexHome, "archived_sessions", rel);

describe("syncCodexUsageMirror", () => {
  it("hardlinks every home's rollouts under archived_sessions, preserving the sessions-relative path", () => {
    const a = writeRollout("019f-master", "2026/07/06/rollout-a.jsonl");
    const b = writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl");

    const result = syncCodexUsageMirror(rookeryHome, realCodexHome);

    expect(result).toEqual({ linked: 2, skipped: 0, failed: 0 });
    expect(fs.existsSync(mirrored("2026/07/06/rollout-a.jsonl"))).toBe(true);
    expect(fs.existsSync(mirrored("2026/07/30/rollout-b.jsonl"))).toBe(true);
    // Same inode is what makes a live worker's ongoing appends show up with no re-sync.
    expect(fs.statSync(mirrored("2026/07/06/rollout-a.jsonl")).ino).toBe(fs.statSync(a).ino);
    expect(fs.statSync(mirrored("2026/07/30/rollout-b.jsonl")).ino).toBe(fs.statSync(b).ino);
  });

  it("counts an already-mirrored rollout as skipped, so fork-ancestor copies in two homes are deduped", () => {
    // A codex fork copies the ancestor rollout into the new target's home, so the SAME relative path
    // legitimately exists twice. Linking it once is what keeps the token total from double-counting.
    const rel = "2026/07/09/rollout-shared.jsonl";
    writeRollout("worker-one", rel);
    writeRollout("worker-two", rel);

    const result = syncCodexUsageMirror(rookeryHome, realCodexHome);

    expect(result.linked).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("is idempotent", () => {
    writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl");
    syncCodexUsageMirror(rookeryHome, realCodexHome);

    expect(syncCodexUsageMirror(rookeryHome, realCodexHome)).toEqual({ linked: 0, skipped: 1, failed: 0 });
  });

  it("reflects appends to an already-mirrored rollout", () => {
    const file = writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl", "first\n");
    syncCodexUsageMirror(rookeryHome, realCodexHome);

    fs.appendFileSync(file, "second\n");

    expect(fs.readFileSync(mirrored("2026/07/30/rollout-b.jsonl"), "utf8")).toBe("first\nsecond\n");
  });

  it("falls back to copying when link reports EXDEV, and refreshes a stale copy", () => {
    const file = writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl", "first\n");
    const exdev = (): never => {
      const err = new Error("cross-device link") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    };

    expect(syncCodexUsageMirror(rookeryHome, realCodexHome, { link: exdev })).toEqual({ linked: 1, skipped: 0, failed: 0 });
    const dest = mirrored("2026/07/30/rollout-b.jsonl");
    expect(fs.readFileSync(dest, "utf8")).toBe("first\n");
    expect(fs.statSync(dest).ino).not.toBe(fs.statSync(file).ino); // a copy, not a link

    // Unchanged source → nothing to do.
    expect(syncCodexUsageMirror(rookeryHome, realCodexHome, { link: exdev })).toEqual({ linked: 0, skipped: 1, failed: 0 });

    // A copy cannot follow appends, so a grown source must be re-copied.
    fs.appendFileSync(file, "second\n");
    expect(syncCodexUsageMirror(rookeryHome, realCodexHome, { link: exdev })).toEqual({ linked: 1, skipped: 0, failed: 0 });
    expect(fs.readFileSync(dest, "utf8")).toBe("first\nsecond\n");
  });

  it("never throws when codex-homes is missing or a home is unreadable", () => {
    expect(syncCodexUsageMirror(path.join(tmp, "nope"), realCodexHome)).toEqual({ linked: 0, skipped: 0, failed: 0 });

    writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl");
    const unreadable = path.join(rookeryHome, "codex-homes", "worker-locked", "sessions");
    fs.mkdirSync(unreadable, { recursive: true });
    fs.chmodSync(unreadable, 0o000);
    try {
      expect(syncCodexUsageMirror(rookeryHome, realCodexHome).linked).toBe(1);
    } finally {
      fs.chmodSync(unreadable, 0o700); // let afterEach clean up
    }
  });

  it("creates the mirror root even when the real codex home does not exist yet", () => {
    writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl");
    const fresh = path.join(tmp, "codex-fresh");

    expect(syncCodexUsageMirror(rookeryHome, fresh).linked).toBe(1);
    expect(fs.existsSync(path.join(fresh, "archived_sessions", "2026/07/30/rollout-b.jsonl"))).toBe(true);
  });

  it("ignores non-rollout files", () => {
    const home = path.join(rookeryHome, "codex-homes", "worker-abc", "sessions");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "notes.txt"), "x");

    expect(syncCodexUsageMirror(rookeryHome, realCodexHome)).toEqual({ linked: 0, skipped: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/daemon/codex-usage-mirror.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/codex-usage-mirror.js`.

- [ ] **Step 3: Write the implementation**

Create `src/daemon/codex-usage-mirror.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { codexHomeDirFor } from "./codex-home.js";

// Accounting mirror (docs/superpowers/specs/2026-07-30-codex-usage-mirror-design.md). `ccusage codex`
// scans ONE CODEX_HOME, while rookery gives every codex master/worker its own home under
// <ROOKERY_HOME>/codex-homes — so none of that spend is visible in the user's usage report. This module
// hardlinks each home's rollouts into the real home under `archived_sessions/`, which ccusage counts
// while codex keeps archived rollouts out of `thread/list` and refuses to resume them (verified on
// codex-cli 0.145.0 by scripts/probe-codex-usage-mirror.mjs). The runtime homes themselves are NOT
// touched: config.toml (the per-session MCP bridge token), auth.json, and the state/memories sqlite
// stay isolated per target.
//
// A hardlink shares the inode, so a LIVE worker's ongoing appends are reflected with no re-sync — the
// periodic sweep only exists to notice new rollout FILES. Nothing here ever deletes: once mirrored, a
// rollout survives its home's `rm -rf`, which is what preserves usage history for deleted workers.

const MIRROR_DIR = "archived_sessions";

export interface CodexUsageMirrorResult {
  linked: number;  // newly mirrored this pass
  skipped: number; // already mirrored (EEXIST) — also the natural dedup for fork-ancestor copies
  failed: number;  // per-file failure; the sweep continues
}

export interface CodexUsageMirrorDeps {
  // Defaults to fs.linkSync. Injectable so the cross-device fallback is testable on one volume.
  link?: (src: string, dest: string) => void;
}

// Mirrors every rookery codex home. Best-effort and never throws: a missing codex-homes dir, an
// unreadable home, EACCES on the real home, ENOSPC — all degrade to counters.
export function syncCodexUsageMirror(
  rookeryHome: string,
  realCodexHome: string,
  deps: CodexUsageMirrorDeps = {},
): CodexUsageMirrorResult {
  const base = path.join(rookeryHome, "codex-homes");
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return { linked: 0, skipped: 0, failed: 0 }; // no codex target has ever run
  }
  const total: CodexUsageMirrorResult = { linked: 0, skipped: 0, failed: 0 };
  for (const name of names) {
    add(total, mirrorHome(path.join(base, name), realCodexHome, deps));
  }
  return total;
}

// Mirrors ONE target's home. Called immediately before a session/worker delete removes it, so the
// usage record outlives the directory.
export function syncCodexUsageMirrorForTarget(
  rookeryHome: string,
  realCodexHome: string,
  targetId: string,
  kind: "master" | "worker",
  deps: CodexUsageMirrorDeps = {},
): CodexUsageMirrorResult {
  return mirrorHome(codexHomeDirFor(rookeryHome, targetId, kind), realCodexHome, deps);
}

function add(into: CodexUsageMirrorResult, from: CodexUsageMirrorResult): void {
  into.linked += from.linked;
  into.skipped += from.skipped;
  into.failed += from.failed;
}

function mirrorHome(homeDir: string, realCodexHome: string, deps: CodexUsageMirrorDeps): CodexUsageMirrorResult {
  const sessions = path.join(homeDir, "sessions");
  const result: CodexUsageMirrorResult = { linked: 0, skipped: 0, failed: 0 };
  const link = deps.link ?? ((src, dest) => fs.linkSync(src, dest));
  for (const file of rolloutFiles(sessions)) {
    // path.relative — NOT prefix stripping, which produced an archived_sessions/Users/... tree during
    // the design PoC.
    const dest = path.join(realCodexHome, MIRROR_DIR, path.relative(sessions, file));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      link(file, dest);
      result.linked++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") result.skipped++;
      else if (code === "EXDEV") add(result, copyAcrossDevices(file, dest));
      else result.failed++;
    }
  }
  return result;
}

// The mirror root is on another volume, so no inode can be shared. Copy instead, and re-copy whenever
// the source has grown or changed — a copy cannot follow a live rollout's appends, so freshness is
// only ever as good as the last sweep.
function copyAcrossDevices(file: string, dest: string): CodexUsageMirrorResult {
  try {
    const src = fs.statSync(file);
    let stale = true;
    try {
      const existing = fs.statSync(dest);
      stale = existing.size !== src.size || existing.mtimeMs < src.mtimeMs;
    } catch {
      /* destination absent → copy */
    }
    if (!stale) return { linked: 0, skipped: 1, failed: 0 };
    fs.copyFileSync(file, dest);
    fs.chmodSync(dest, 0o600);
    return { linked: 1, skipped: 0, failed: 0 };
  } catch {
    return { linked: 0, skipped: 0, failed: 1 };
  }
}

// Recursive walk of a home's sessions/ tree. Mirrors codex-home.ts's rolloutFiles: unreadable
// directories are skipped rather than fatal.
function rolloutFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
    }
  };
  visit(root);
  return files;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/daemon/codex-usage-mirror.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/codex-usage-mirror.ts test/daemon/codex-usage-mirror.test.ts
git commit -m "feat(daemon): hardlink codex rollouts into the real home for ccusage accounting"
```

---

### Task 2: per-target sync

**Files:**
- Modify: `src/daemon/codex-usage-mirror.ts` (already contains `syncCodexUsageMirrorForTarget` from Task 1 — this task only adds its test)
- Test: `test/daemon/codex-usage-mirror.test.ts`

**Interfaces:**
- Consumes: `syncCodexUsageMirrorForTarget(rookeryHome, realCodexHome, targetId, kind, deps?)` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` block in `test/daemon/codex-usage-mirror.test.ts` (add `syncCodexUsageMirrorForTarget` to the import):

```ts
  it("mirrors only the named target, resolving the worker- prefix like codexHomeDirFor", () => {
    writeRollout("worker-abc", "2026/07/30/rollout-worker.jsonl");
    writeRollout("019f-master", "2026/07/06/rollout-master.jsonl");

    const worker = syncCodexUsageMirrorForTarget(rookeryHome, realCodexHome, "abc", "worker");

    expect(worker).toEqual({ linked: 1, skipped: 0, failed: 0 });
    expect(fs.existsSync(mirrored("2026/07/30/rollout-worker.jsonl"))).toBe(true);
    expect(fs.existsSync(mirrored("2026/07/06/rollout-master.jsonl"))).toBe(false);

    const master = syncCodexUsageMirrorForTarget(rookeryHome, realCodexHome, "019f-master", "master");

    expect(master).toEqual({ linked: 1, skipped: 0, failed: 0 });
    expect(fs.existsSync(mirrored("2026/07/06/rollout-master.jsonl"))).toBe(true);
  });

  it("never throws for a target whose home is already gone", () => {
    expect(syncCodexUsageMirrorForTarget(rookeryHome, realCodexHome, "vanished", "worker"))
      .toEqual({ linked: 0, skipped: 0, failed: 0 });
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run test/daemon/codex-usage-mirror.test.ts`
Expected: FAIL if `syncCodexUsageMirrorForTarget` is missing or resolves the `worker-` prefix by hand; PASS if Task 1's implementation is correct as written (that is the point of the test — it pins the `codexHomeDirFor` contract so a later refactor can't silently change the directory convention).

- [ ] **Step 3: Fix the implementation if needed**

No change expected. If the test fails, the cause is `syncCodexUsageMirrorForTarget` not delegating to `codexHomeDirFor` — make it delegate rather than building the path inline.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/daemon/codex-usage-mirror.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add test/daemon/codex-usage-mirror.test.ts
git commit -m "test(daemon): pin the per-target codex usage mirror to codexHomeDirFor"
```

---

### Task 3: wire the mirror into the daemon

**Files:**
- Modify: `src/daemon/server.ts` — import block (near the `codex-home.js` import at `:53-54`), boot sweep (after `gcOrphanCodexHomes(...)`, `:320-324`), `onSessionDelete` (`:257-260`), `fleet`'s `onWorkerDiscard` (`:306-308`), the periodic timer (next to the `usageRefreshMs` resolution at `:443-444`), and `close()` (next to `usageCollector.stop()`, `:712`).

**Interfaces:**
- Consumes: `syncCodexUsageMirror`, `syncCodexUsageMirrorForTarget` from Task 1.
- Produces: nothing importable — this is the composition root.

There is no unit test for this task: `startDaemon()` is the composition root and is covered by the smoke/live paths, not by unit tests. Verification is the typecheck plus the manual daemon run in Step 6.

- [ ] **Step 1: Import the module**

In `src/daemon/server.ts`, next to the existing `codex-home.js` import (which currently brings in `removeCodexHome` / `removeCodexWorkerHome` around `:53-54`), add:

```ts
import { syncCodexUsageMirror, syncCodexUsageMirrorForTarget } from "./codex-usage-mirror.js";
```

- [ ] **Step 2: Reuse the existing real-codex-home constant**

No new resolution is needed. `server.ts:169` already has

```ts
const realCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
```

and it is declared before every site this task touches (`onSessionDelete` `:257`, the fleet options `:306`, the boot sweep `:320`, the usage wiring `:443`). Pass that same constant to the mirror so a user who relocates their codex home gets the mirror there — the value `materializeCodexHome` already reads config.toml/auth.json from.

- [ ] **Step 3: Sweep at boot**

Immediately after the `gcOrphanCodexHomes(...)` call (`:320-324`), add:

```ts
  // Codex usage accounting (docs/superpowers/specs/2026-07-30-codex-usage-mirror-design.md): hardlink
  // every codex target's rollouts into the user's real CODEX_HOME so `ccusage codex` can see them.
  // Boot sweep reconciles homes created by the previous process; never throws.
  logMirror(syncCodexUsageMirror(config.home, realCodexHome));
```

- [ ] **Step 4: Add the log helper and the periodic sweep**

Near the `usageRefreshMs` resolution (`:443-444`), after `usageRefreshMs` is defined:

```ts
  // One line per sweep, only when something happened. Rollout CONTENTS are never read — only linked —
  // so nothing sensitive can reach the log.
  const logMirror = (r: { linked: number; skipped: number; failed: number }): void => {
    if (r.linked > 0 || r.failed > 0) console.log(`codex usage mirror: linked=${r.linked} skipped=${r.skipped} failed=${r.failed}`);
  };
  // Periodic sweep on the usage cadence. Deliberately NOT folded into UsageCollector: src/core is
  // transport-agnostic and must not write to the user's home. Existing links follow live appends via
  // the shared inode, so this only needs to notice NEW rollout files.
  const usageMirrorTimer = setInterval(() => logMirror(syncCodexUsageMirror(config.home, realCodexHome)), usageRefreshMs);
  usageMirrorTimer.unref?.();
```

`logMirror` is used by Step 3, which runs earlier in the function body — so declare `logMirror` **above** the boot sweep (move it up next to the boot sweep and keep only the timer at `:444`). Hoisting a `const` arrow function is not allowed; put the helper immediately before the boot sweep call.

- [ ] **Step 5: Mirror before each teardown**

In `onSessionDelete` (`:257`):

```ts
  const onSessionDelete = (id: string): void => {
    bridge.release(id);
    // Mirror BEFORE the home is removed, or this session's usage record dies with the directory.
    syncCodexUsageMirrorForTarget(config.home, realCodexHome, id, "master");
    removeCodexHome(config.home, id);
  };
```

In `fleet`'s `onWorkerDiscard` (`:306`):

```ts
    onWorkerDiscard: (id, provider) => {
      if ((provider ?? repos.getWorker(id)?.provider ?? "claude") === "codex") {
        syncCodexUsageMirrorForTarget(config.home, realCodexHome, id, "worker"); // before the rm -rf below
        removeCodexWorkerHome(config.home, id);
      }
    },
```

In `close()` next to `usageCollector.stop()` (`:712`):

```ts
    clearInterval(usageMirrorTimer);
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck
npm test
npm run build && node dist/index.js daemon   # boot once; expect no throw, and a "codex usage mirror: …" line when links are new
```

Then confirm the accounting actually moved:

```bash
CODEX_HOME=$HOME/.codex npx ccusage@latest codex daily | tail -5
node scripts/probe-codex-usage-mirror.mjs   # expect PASS
```

- [ ] **Step 7: Commit**

```bash
git add src/daemon/server.ts
git commit -m "feat(daemon): sweep the codex usage mirror at boot, on the usage tick, and pre-teardown"
```

---

### Task 4: document it

**Files:**
- Modify: `CLAUDE.md` (= `AGENTS.md`, a symlink) — the `~/.rookery` home layout paragraph and the env-var/settings notes if they mention usage collection.
- Modify: `docs/reference/` — whichever file catalogs daemon behaviour around usage (check `docs/README.md` for the right one; if none fits, skip rather than invent a file).

- [ ] **Step 1: Update the home-layout line**

In the `~/.rookery` home layout paragraph of `AGENTS.md`, extend the `codex-homes/...` entry so the mirror is discoverable:

```
· `codex-homes/<session-id>/` and `codex-homes/worker-<worker-id>/` (target-specific config, auth link/provisioning, and rollout state; their rollouts are additionally hardlinked into the user's real `CODEX_HOME` under `archived_sessions/` so `ccusage codex` can account for them — `src/daemon/codex-usage-mirror.ts`, never deleted, secret-free)
```

- [ ] **Step 2: Verify the docs claim matches the code**

Run: `grep -n "codex-usage-mirror" AGENTS.md src/daemon/server.ts`
Expected: both the doc line and the two wiring call sites appear.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs
git commit -m "docs: note the codex usage mirror in the home layout"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| New module `codex-usage-mirror.ts`, `syncCodexUsageMirror` | 1 |
| `syncCodexUsageMirrorForTarget` | 1 (impl) + 2 (test) |
| `archived_sessions/` destination, `path.relative`, `0700` dirs | 1 |
| EEXIST dedup / EXDEV copy + staleness / never throws | 1 |
| Boot sweep after `gcOrphanCodexHomes` | 3 |
| Periodic sweep at `usageRefreshMs`, cleared in `close()` | 3 |
| Pre-teardown sweep in `onSessionDelete` / `onWorkerDiscard` | 3 |
| Log line without secrets | 3 |
| Tests 1–8 from the spec | 1 and 2 (the spec's list maps 1:1 onto the ten `it(...)` blocks; the spec's item 8 "destination uses the sessions-relative layout" is the first test's path assertions plus Task 2's isolation test) |
| Probe for codex-version-dependent facts | already committed as `scripts/probe-codex-usage-mirror.mjs` |
| No setting, no protocol change | Global Constraints |

**Placeholder scan:** none — every step carries real code or a real command.

**Type consistency:** `CodexUsageMirrorResult` / `CodexUsageMirrorDeps` / `syncCodexUsageMirror` / `syncCodexUsageMirrorForTarget` are spelled identically in Tasks 1–3, and the `{ linked, skipped, failed }` shape used by `logMirror` in Task 3 matches the interface in Task 1.
