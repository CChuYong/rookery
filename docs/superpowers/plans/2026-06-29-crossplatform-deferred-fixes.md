# Cross-platform deferred fixes Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. TDD where the logic is pure; platform branches must be no-ops on macOS so the existing suite stays green.

**Goal:** Resolve the three deferred cross-platform findings from the 2026-06-28 audit — Windows graceful daemon shutdown (#1), Windows resource snapshot (#3), and a safe cross-platform "Open in file manager" slice of the macOS-only launcher (#2).

**Architecture:** Add a token-authenticated `POST /shutdown` HTTP endpoint to the daemon so the desktop can trigger `daemon.close()` on Windows (where SIGTERM is a hard kill); make `DaemonManager` prefer that graceful path before signals on every platform. Branch `psSnapshot` to PowerShell on win32 (reusing the existing `parsePsRows`). Branch the app launcher to a `shell.openPath`-based file-manager launcher off macOS.

**Tech Stack:** Node 22 (ESM, `.js` import specifiers, `import type`), Electron main, node http, vitest.

## Global Constraints
- Node 22 ABI 127; ESM NodeNext (relative imports need `.js`; type-only uses need `import type`).
- Platform branches MUST be inert on macOS (the test suite runs on macOS) — guard with `process.platform`.
- Code comments in English. No new user-facing strings needed (app names are literals).
- The full Windows/Linux **editor + terminal** detection/launch port is OUT OF SCOPE (untestable on the dev host; tracked in memory `clovot-crossplatform-deferred`). Only the `shell.openPath` file-manager slice of #2 is in scope.

---

### Task 1: Daemon `POST /shutdown` endpoint (graceful close on demand)

**Files:**
- Modify: `src/daemon/auth.ts` (export a token-compare helper)
- Modify: `src/daemon/server.ts` (`StartDaemonOptions.onShutdownRequest`; handle `POST /shutdown`)
- Modify: `src/index.ts` (pass `onShutdownRequest: shutdown`; restructure so `shutdown` is defined before `startDaemon`)
- Test: `test/daemon/server.test.ts`

**Interfaces:**
- Produces: `tokenMatches(expected: string, given: string | undefined | null): boolean` (auth.ts); `StartDaemonOptions.onShutdownRequest?: () => void`; daemon now returns 200 on authenticated `POST /shutdown` and invokes the callback.

- [ ] Step 1: auth.ts — export `export function tokenMatches(expected: string, given: string | null | undefined): boolean { return typeof given === "string" && timingSafeEq(expected, given); }`
- [ ] Step 2: server.ts — add `onShutdownRequest?: () => void;` to `StartDaemonOptions`.
- [ ] Step 3: server.ts — in the http handler, before the 404, add:
  ```ts
  if (req.method === "POST" && req.url === "/shutdown") {
    const given = (req.headers["x-rookery-token"] as string | undefined) ?? undefined;
    if (!tokenMatches(token, given)) { res.writeHead(401).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    opts.onShutdownRequest?.();
    return;
  }
  ```
- [ ] Step 4: index.ts — restructure: `let daemon: DaemonHandle;` then `const shutdown = () => { if (shuttingDown) return; shuttingDown = true; void daemon.close().then(() => process.exit(0)); };` then `daemon = await startDaemon({ config, onShutdownRequest: shutdown });` (keep SIGINT/SIGTERM → shutdown).
- [ ] Step 5: server.test.ts — test that `POST /shutdown` with the wrong token → 401 and does NOT call the callback; with the right token → 200 and calls it. Use `acquireLock: false`, a temp home, `onShutdownRequest: vi.fn()`, real http request to `127.0.0.1:<port>`.
- [ ] Step 6: `npx vitest run test/daemon/server.test.ts` → PASS; then `git commit`.

---

### Task 2: DaemonManager graceful-first shutdown + main wiring

**Files:**
- Modify: `apps/desktop/src/main/daemon-manager.ts` (add `shutdown?` dep; `waitDown()` helper; try graceful HTTP before signals in `stop()`/`restart()`)
- Modify: `apps/desktop/src/main/index.ts` (wire `shutdown` dep: authenticated `POST /shutdown`)
- Test: `apps/desktop/test/daemon-manager.test.ts`

**Interfaces:**
- Consumes: `DaemonManagerOptions.deps`.
- Produces: `DaemonDeps.shutdown?: () => Promise<boolean>`; `stop()`/`restart()` call `deps.shutdown` first and skip signals if `/health` then goes down.

- [ ] Step 1: daemon-manager.ts — add to `DaemonDeps`: `shutdown?: () => Promise<boolean>; // graceful POST /shutdown (works on Windows where SIGTERM hard-kills). Returns true if accepted.`
- [ ] Step 2: daemon-manager.ts — add private `private async waitDown(): Promise<boolean> { const { deps, host, port } = this.opts; const deadline = this.opts.maxWaitMs ?? 5000; for (let w = 0; w < deadline; w += 100) { if (!(await deps.ping(host, port))) return true; await deps.sleep(100); } return false; }`
- [ ] Step 3: daemon-manager.ts — rewrite `stop()`: try `deps.shutdown` first (`await this.waitDown()` → return on success), else existing SIGTERM→waitDown→SIGKILL using `waitDown()`.
- [ ] Step 4: daemon-manager.ts — rewrite `restart()` the same way (graceful first → `return this.ensure()`), else signals → `this.ensure()`.
- [ ] Step 5: daemon-manager.test.ts — add: "stop() uses graceful shutdown and skips kill when it works" (deps.shutdown resolves + ping goes down → no kill); keep existing signal tests passing (no `shutdown` dep → signal path unchanged).
- [ ] Step 6: index.ts — wire the dep into `new DaemonManager({ ... deps: { ...existing, shutdown: () => postShutdown() } })` where `postShutdown` does `http.request({ host, port, path: "/shutdown", method: "POST", headers: { "x-rookery-token": token } })` resolving true on 200, false otherwise (token from the existing `~/.rookery/ws-token` read).
- [ ] Step 7: `npx vitest run test/daemon-manager.test.ts` (in apps/desktop) → PASS; `npm run typecheck`; `git commit`.

---

### Task 3: Windows resource snapshot (psSnapshot)

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (`psSnapshot` win32 branch)
- Test: `apps/desktop/test/resource-monitor.test.ts` (assert `parsePsRows` handles the PowerShell-formatted line)

**Interfaces:**
- Consumes: `parsePsRows(stdout)` (unchanged — PowerShell emits the same `pid ppid pcpu rss` 4-column format with pcpu=0).

- [ ] Step 1: resource-monitor.test.ts — add a test: `parsePsRows("1234 5678 0 120560\n")` → `[{pid:1234, ppid:5678, pcpu:0, rssKb:120560}]` (the Windows format with pcpu placeholder 0).
- [ ] Step 2: `npx vitest run test/resource-monitor.test.ts` → PASS (parser already supports it; this locks the contract).
- [ ] Step 3: index.ts — branch `psSnapshot`: on `process.platform === "win32"` run `execFile("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) 0 $([math]::Round($_.WorkingSetSize/1024))\" }"], {...})` → `parsePsRows(stdout)`; else the existing `ps -axo`. (CPU% is 0 on Windows — RSS is correct; documented in a comment.)
- [ ] Step 4: `npm run typecheck` → clean; `git commit`.

---

### Task 4: Cross-platform "Open in file manager" (non-macOS slice of #2)

**Files:**
- Modify: `apps/desktop/src/main/app-launcher.ts` (`createFileManagerLauncher`)
- Modify: `apps/desktop/src/main/index.ts` (use it off macOS)
- Test: `apps/desktop/test/app-launcher.test.ts`

**Interfaces:**
- Produces: `createFileManagerLauncher(openPath: (dir: string) => Promise<string>): { list(): Promise<DetectedApp[]>; open(id, dir): Promise<{ok; error?}> }` — `list()` returns a single `{ id: "files", name: "File manager", kind: "finder", icon: null }`; `open()` calls `openPath(dir)` (Electron `shell.openPath` returns "" on success, else an error string).

- [ ] Step 1: app-launcher.test.ts — add: `createFileManagerLauncher` lists one finder entry; `open("files", "/x")` calls openPath and maps "" → `{ok:true}`, a non-empty string → `{ok:false,error}`.
- [ ] Step 2: `npx vitest run test/app-launcher.test.ts` → FAIL (not defined).
- [ ] Step 3: app-launcher.ts — implement `createFileManagerLauncher`.
- [ ] Step 4: index.ts — `const appLauncher = process.platform === "darwin" ? createAppLauncher({...mac...}) : createFileManagerLauncher((dir) => shell.openPath(dir));`
- [ ] Step 5: `npx vitest run test/app-launcher.test.ts` → PASS; `npm run typecheck`; full `npm test` (root + desktop) + `npm run build` (desktop); `git commit`.

---

### Out of scope (deferred — see memory `clovot-crossplatform-deferred`)
- #1 documentation only: none needed (graceful path implemented).
- #2 FULL: Windows/Linux editor + terminal detection & launch, plus icon extraction. Untestable on the macOS dev host; high surface. Left for a session that can verify on the target OS.
- #3 Windows CPU%: instantaneous per-process CPU% needs two PerfData samples; the RSS + tree is delivered, CPU shows 0 on Windows (documented).

## Self-Review
- Spec coverage: #1 → Tasks 1+2; #3 → Task 3; #2 safe slice → Task 4; #2 full → explicitly deferred. ✓
- Placeholders: none (code shown for each step). ✓
- Type consistency: `tokenMatches`, `onShutdownRequest`, `DaemonDeps.shutdown`, `waitDown`, `createFileManagerLauncher` names used identically across tasks. ✓
