# Worker `background` State Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every desktop/daemon consumer of the worker state union treat `background` as a live, interactive state and stop relying on the retired `done` state, so a worker running a Dynamic Workflow can still be messaged, stopped, filtered, and reported on.

**Architecture:** The 2026-07-11 worker-state-graph change (docs/superpowers/specs/2026-07-11-worker-state-graph-design.md) added `background` and retired `done` from live writes. The *display* layer of the renderer was updated (`lib/status.ts` RAIL/TAG/TONE, `WorkspaceHeaders`), but the *interaction gate* layer was not: composer enable/placeholder, context-menu Stop, the "live" tree filter, optimistic-bubble retention, and unread marking all still test `running | idle` (or `done`). This plan fixes each gate at its source, and extracts the duplicated composer gate in `App.tsx` into one pure, unit-testable helper so the two render paths (dockable + static layout) can never drift again.

**Tech Stack:** TypeScript (ESM NodeNext, `.js` import extensions), React 18 + Zustand (renderer), Vitest + @testing-library/react (desktop), Vitest (root daemon).

## Global Constraints

- Node 22 required (`better-sqlite3` ABI 127). Run `nvm use 22` before any command.
- ESM NodeNext: **all relative imports need the `.js` extension**; type-only imports use `import type`.
- Code comments are written in **English**. Chat/report replies to the user stay Korean.
- Every new user-facing string goes through i18n, added to **both** `apps/desktop/src/renderer/i18n/locales/ko/<ns>.ts` and `en/<ns>.ts` with an identical key set (enforced by `test/i18n/catalog.test.ts`).
- Root gates do not cover `apps/desktop`. After renderer changes run **both**: `npm run typecheck && npm test` (root) and `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- The worker state union is `running | idle | background | stopped | done | error` plus the orchestrator-only DB states `failed` / `orphaned`, plus the pre-start DB state `provisioning`. `done` must be **kept readable** (legacy rows) but must never be required for live behavior.
- Do not change daemon state-machine semantics. `WorkerNotifier` excluding `background` from SETTLED is deliberate and stays as is.
- Commit after each task with a `fix(desktop):` / `fix(slack):` style message and the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Background: why each gate is wrong

Verified against the daemon source before writing this plan:

- `src/core/worker.ts:246` `Worker.send()` explicitly allows sends while `running`, `background`, **or** `idle` — it only rejects terminal states. The daemon was built for background sends; only the desktop refuses them.
- `src/core/fleet-orchestrator.ts:511` `send()` → `requireLive()` rejects only terminal entries, so `fleet.send` to a background worker succeeds today.
- `fleet.stop` (App.tsx `onStop`, line 896) is the **only** control that kills background tasks — `interrupt` deliberately does not (it aborts a turn; the settle-grace/auto-wake design keeps bg shells alive). So gating the context-menu Stop out of `background` leaves a background worker with no stop path at all.

## File Structure

| File | Role | Change |
|---|---|---|
| `apps/desktop/src/renderer/lib/status.ts` | single source of status→visual channels | `isLive` gains `background` |
| `apps/desktop/src/renderer/components/StatusBadge.tsx` | status chip | end-flash keyed off `isLive`, not `"running"` |
| `apps/desktop/src/renderer/lib/worker-composer.ts` | **new** — pure worker composer gate | created |
| `apps/desktop/src/renderer/App.tsx` | both worker render paths | consume the new helper |
| `apps/desktop/src/renderer/i18n/locales/{ko,en}/app.ts` | strings | new `app.backgroundAddable` |
| `apps/desktop/src/renderer/store/store.ts` | `setFleet` prune + `worker.status` unread | retain bubbles in `background`; mark unread on `stopped` |
| `apps/desktop/src/renderer/views/RepoTree.tsx` | fleet tree | Stop menu + "live" filter include `background` |
| `apps/desktop/src/renderer/lib/notify.ts` | OS notification mapping | `error` maps to the failure line |
| `src/slack/reporter.ts` | Slack worker status relay | terminal icon stops depending on retired `done` |

---

### Task 1: `background` counts as live in the visual channels

**Files:**
- Modify: `apps/desktop/src/renderer/lib/status.ts:39`
- Modify: `apps/desktop/src/renderer/components/StatusBadge.tsx:9-11`
- Test: `apps/desktop/test/lib/status.test.ts`, `apps/desktop/test/status-badge.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `isLive(s: string): boolean` — now true for `"running"` **and** `"background"`. Consumed by `StatusBadge`, `MessageList:130`, `RepoTree:156`.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/lib/status.test.ts`:

```ts
import { isLive } from "../../src/renderer/lib/status.js";

// background = turn ended but harness-tracked background tasks still run. It is still WORKING,
// so it must carry the same live signature as running (LED pulse), not a settled/idle look.
describe("isLive (worker-state-graph: background is live)", () => {
  it("treats running and background as live", () => {
    expect(isLive("running")).toBe(true);
    expect(isLive("background")).toBe(true);
  });

  it("does not treat settled or terminal states as live", () => {
    for (const s of ["idle", "stopped", "done", "error", "failed", "orphaned", "provisioning"]) {
      expect(isLive(s)).toBe(false);
    }
  });
});
```

Append to `apps/desktop/test/status-badge.test.tsx`:

```tsx
it("keeps the live LED while background tasks run, and does not fire the end-flash on running→background", () => {
  const { container, rerender } = render(<StatusBadge status="running" />);
  rerender(<StatusBadge status="background" />);
  const dot = container.querySelector("span span")!;
  expect(dot.className).toContain("led-live");
  // The turn ended but the worker is still working — an end-flash here would read as "finished".
  expect(dot.className).not.toContain("status-flash");
});

it("fires the end-flash when background settles to a terminal state", () => {
  const { container, rerender } = render(<StatusBadge status="background" />);
  rerender(<StatusBadge status="stopped" />);
  const dot = container.querySelector("span span")!;
  expect(dot.className).toContain("status-flash");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm -w apps/desktop test -- lib/status.test.ts status-badge.test.tsx
```

Expected: FAIL — `isLive("background")` returns `false`; the badge dot lacks `led-live` and the background→stopped flash does not fire.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/renderer/lib/status.ts`, replace line 39:

```ts
export const isLive = (s: string): boolean => s === "running";
```

with:

```ts
// Live = the worker is still working. `background` is a turn that ended while harness-tracked background
// tasks (run_in_background shells, Dynamic Workflow runs) keep going — the SDK auto-wakes it, so it is
// working, not settled. Keeping it out of isLive made an actively-working worker look dormant.
export const isLive = (s: string): boolean => s === "running" || s === "background";
```

In `apps/desktop/src/renderer/components/StatusBadge.tsx`, replace lines 9-11:

```tsx
  // status-flash fires once only on the running→terminal transition. It does not fire on history
  // replay where the component mounts already in a terminal state (useJustEnded is false at mount).
  const justEnded = useJustEnded(status === "running");
```

with:

```tsx
  // status-flash fires once only on the live→settled transition. Keyed off isLive (not "running") so a
  // running→background hand-off — where work continues — does not flash a false "finished" cue. It does
  // not fire on history replay where the component mounts already settled (useJustEnded is false at mount).
  const justEnded = useJustEnded(isLive(status));
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm -w apps/desktop test -- lib/status.test.ts status-badge.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/lib/status.ts apps/desktop/src/renderer/components/StatusBadge.tsx apps/desktop/test/lib/status.test.ts apps/desktop/test/status-badge.test.tsx
git commit -m "$(cat <<'EOF'
fix(desktop): treat worker background as a live state in status visuals

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: worker composer gate — extract and fix (the headline bug)

A worker in `background` fell through the placeholder chain to `app.agentEndedReadonly` ("Worker ended — view only") and had its composer disabled, even though `Worker.send()` accepts the message and queues it. The gate is duplicated verbatim in two `App.tsx` render paths (dockable panes and the static layout), so it is extracted into one pure helper.

**Files:**
- Create: `apps/desktop/src/renderer/lib/worker-composer.ts`
- Modify: `apps/desktop/src/renderer/App.tsx:1046-1066` (dockable path) and `apps/desktop/src/renderer/App.tsx:1493-1514` (static path)
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/app.ts`, `apps/desktop/src/renderer/i18n/locales/en/app.ts`
- Test: `apps/desktop/test/lib/worker-composer.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface WorkerComposerState {
    disabled: boolean;        // composer input blocked
    controlsEditable: boolean; // model / permission-mode pickers editable
    placeholderKey: string;   // i18n key for the composer placeholder
  }
  export function workerComposerState(status: string): WorkerComposerState;
  ```
  Consumed by both `App.tsx` worker render paths.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/lib/worker-composer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { workerComposerState } from "../../src/renderer/lib/worker-composer.js";
import { catalogs } from "../../src/renderer/i18n/catalog.js";

// The composer gate for a worker page. Worker.send() (src/core/worker.ts) accepts sends while
// running, background, AND idle — it rejects only terminal states — so the UI gate must match.
describe("workerComposerState", () => {
  it("keeps the composer open for every live state (running, background, idle)", () => {
    for (const s of ["running", "background", "idle"]) {
      expect(workerComposerState(s).disabled).toBe(false);
      expect(workerComposerState(s).controlsEditable).toBe(true);
    }
  });

  it("gives background its own placeholder instead of the ended/read-only line", () => {
    const bg = workerComposerState("background");
    expect(bg.placeholderKey).toBe("app.backgroundAddable");
    expect(bg.placeholderKey).not.toBe("app.agentEndedReadonly");
  });

  it("labels running and idle with their existing placeholders", () => {
    expect(workerComposerState("running").placeholderKey).toBe("app.busyAddable");
    expect(workerComposerState("idle").placeholderKey).toBe("app.instructWorker");
  });

  it("blocks input while the worktree is still being created", () => {
    const p = workerComposerState("provisioning");
    expect(p.disabled).toBe(true);
    expect(p.controlsEditable).toBe(false);
    expect(p.placeholderKey).toBe("app.creatingWorktree");
  });

  it("blocks input for terminal states, with the restart hint for orphaned", () => {
    expect(workerComposerState("orphaned")).toEqual({ disabled: true, controlsEditable: false, placeholderKey: "app.sessionEndedRestart" });
    for (const s of ["stopped", "done", "error", "failed"]) {
      expect(workerComposerState(s).disabled).toBe(true);
      expect(workerComposerState(s).placeholderKey).toBe("app.agentEndedReadonly");
    }
  });

  it("fails closed for an unknown state (never silently editable)", () => {
    expect(workerComposerState("bogus").disabled).toBe(true);
  });

  it("every placeholder key it can return exists in both locale catalogs", () => {
    for (const s of ["running", "background", "idle", "provisioning", "orphaned", "stopped", "done", "error", "failed", "bogus"]) {
      const key = workerComposerState(s).placeholderKey;
      expect(catalogs.ko).toHaveProperty(key);
      expect(catalogs.en).toHaveProperty(key);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm -w apps/desktop test -- lib/worker-composer.test.ts
```

Expected: FAIL — `Failed to resolve import ".../lib/worker-composer.js"`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/renderer/lib/worker-composer.ts`:

```ts
// Composer gate for a worker page: may the user type, may they change model/permission mode, and what
// does the placeholder say. Extracted from App.tsx, where the identical chain was duplicated across the
// dockable and static render paths — the duplicate is why `background` was missed in both at once.
//
// Liveness mirrors the daemon: Worker.send() (src/core/worker.ts) accepts sends while running,
// background, or idle and rejects only terminal states, so `background` must stay writable here. A
// message sent to a busy worker is queued and released at the next turn boundary, which is exactly
// what the running/background placeholders promise.
export interface WorkerComposerState {
  disabled: boolean;
  controlsEditable: boolean;
  placeholderKey: string;
}

const PLACEHOLDER_KEY: Record<string, string> = {
  running: "app.busyAddable",
  background: "app.backgroundAddable",
  idle: "app.instructWorker",
  provisioning: "app.creatingWorktree",
  orphaned: "app.sessionEndedRestart",
};

// Live = the daemon will accept a send. Unknown states fall through to read-only (fail closed).
const LIVE = new Set(["running", "background", "idle"]);

export function workerComposerState(status: string): WorkerComposerState {
  const live = LIVE.has(status);
  return {
    disabled: !live,
    controlsEditable: live,
    placeholderKey: PLACEHOLDER_KEY[status] ?? "app.agentEndedReadonly",
  };
}
```

Add the new string to `apps/desktop/src/renderer/i18n/locales/ko/app.ts`, directly after the `"app.busyAddable"` line:

```ts
  "app.backgroundAddable": "백그라운드 작업 중… (메시지 추가 가능)",
```

Add to `apps/desktop/src/renderer/i18n/locales/en/app.ts`, directly after its `"app.busyAddable"` line:

```ts
  "app.backgroundAddable": "Background tasks running… (you can add messages)",
```

In `apps/desktop/src/renderer/App.tsx`, add the import next to the other `lib/` imports (near line 23, where `notifyFor` is imported):

```ts
import { workerComposerState } from "./lib/worker-composer.js";
```

In the **dockable** path, replace lines 1046-1066:

```tsx
            controls={{
              provider: activeSub.provider,
              model: activeSub.model ?? (activeSub.provider === "codex" ? s.settings?.codexWorkerModel : s.settings?.workerModel) ?? "claude-opus-4-8",
              editable: activeSub.status === "running" || activeSub.status === "idle",
              onModel: (m) => subSetModel(activeSub.id, m),
              permissionMode: activeSub.permissionMode ?? "bypassPermissions",
              onPermissionMode: (m) => subSetPermissionMode(activeSub.id, m),
              permissionModes: ["bypassPermissions", "plan"] as const,
            }}
            disabled={activeSub.status !== "running" && activeSub.status !== "idle"}
            placeholder={
              activeSub.status === "provisioning"
                ? t("app.creatingWorktree")
                : activeSub.status === "running"
                  ? t("app.busyAddable")
                  : activeSub.status === "idle"
                    ? t("app.instructWorker")
                    : activeSub.status === "orphaned"
                      ? t("app.sessionEndedRestart")
                      : t("app.agentEndedReadonly")
            }
```

with:

```tsx
            controls={{
              provider: activeSub.provider,
              model: activeSub.model ?? (activeSub.provider === "codex" ? s.settings?.codexWorkerModel : s.settings?.workerModel) ?? "claude-opus-4-8",
              editable: workerComposerState(activeSub.status).controlsEditable,
              onModel: (m) => subSetModel(activeSub.id, m),
              permissionMode: activeSub.permissionMode ?? "bypassPermissions",
              onPermissionMode: (m) => subSetPermissionMode(activeSub.id, m),
              permissionModes: ["bypassPermissions", "plan"] as const,
            }}
            disabled={workerComposerState(activeSub.status).disabled}
            placeholder={t(workerComposerState(activeSub.status).placeholderKey)}
```

In the **static** path, replace lines 1493-1514 the same way (note this block keeps its existing explanatory comment above `provider`):

```tsx
                      controls={{
                        // while running, the model + permission mode can be changed live (query.setModel / query.setPermissionMode). effort can't → omitted.
                        provider: activeSub.provider,
                        model: activeSub.model ?? (activeSub.provider === "codex" ? s.settings?.codexWorkerModel : s.settings?.workerModel) ?? "claude-opus-4-8",
                        editable: workerComposerState(activeSub.status).controlsEditable,
                        onModel: (m) => subSetModel(activeSub.id, m),
                        permissionMode: activeSub.permissionMode ?? "bypassPermissions",
                        onPermissionMode: (m) => subSetPermissionMode(activeSub.id, m),
                        permissionModes: ["bypassPermissions", "plan"] as const, // workers: only bypass + plan (no default/acceptEdits)
                      }}
                      disabled={workerComposerState(activeSub.status).disabled}
                      placeholder={t(workerComposerState(activeSub.status).placeholderKey)}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm -w apps/desktop test -- lib/worker-composer.test.ts i18n
npm -w apps/desktop run typecheck
```

Expected: PASS for both, including the ko/en catalog parity and used-keys tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/lib/worker-composer.ts apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/i18n/locales/ko/app.ts apps/desktop/src/renderer/i18n/locales/en/app.ts apps/desktop/test/lib/worker-composer.test.ts
git commit -m "$(cat <<'EOF'
fix(desktop): keep the worker composer writable while background tasks run

Extract the duplicated App.tsx composer gate into workerComposerState so the
dockable and static render paths cannot drift again.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: keep optimistic "waiting" bubbles for background workers

`setFleet` prunes `pendingByWorker` down to workers whose status is `running`. With Task 2 landed, a message sent to a `background` worker would render its optimistic bubble and then lose it on the next `fleet.list` refresh (which fires on every worker terminal transition anywhere in the fleet), before the daemon's deferred echo arrives at the turn boundary.

**Files:**
- Modify: `apps/desktop/src/renderer/store/store.ts:304`
- Test: `apps/desktop/test/store-pending.test.ts`

**Interfaces:**
- Consumes: `workerComposerState` semantics from Task 2 (background is sendable).
- Produces: no new API — `setFleet` retains `pendingByWorker` entries for `running` and `background`.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/store-pending.test.ts`:

```ts
describe("setFleet pending retention across the worker state graph", () => {
  const row = (id: string, status: string) => ({
    id, label: id, repoPath: "/code/app", status, branch: `rookery/${id}`,
    model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null,
  });

  beforeEach(() => {
    useStore.setState({ pendingByWorker: {}, fleet: {}, deletingWorkers: {}, connectionEpoch: 0 } as never);
  });

  it("keeps the pending bubble for a background worker (its send is queued to the next turn boundary)", () => {
    useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "also check the logs" });
    useStore.getState().setFleet([row("w1", "background")] as never);
    expect(useStore.getState().pendingByWorker.w1).toHaveLength(1);
  });

  it("keeps the pending bubble for a running worker", () => {
    useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "hi" });
    useStore.getState().setFleet([row("w1", "running")] as never);
    expect(useStore.getState().pendingByWorker.w1).toHaveLength(1);
  });

  it("still drops ghost bubbles for settled and terminal workers", () => {
    for (const status of ["idle", "stopped", "error"]) {
      useStore.setState({ pendingByWorker: {} } as never);
      useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "hi" });
      useStore.getState().setFleet([row("w1", status)] as never);
      expect(useStore.getState().pendingByWorker.w1 ?? []).toHaveLength(0);
    }
  });
});
```

The store action is `pushWorkerPending` (verified at `store.ts:331`) — note the word order differs from
`pendingByWorker`; its sibling is `dropWorkerPending` at `store.ts:333`.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm -w apps/desktop test -- store-pending.test.ts
```

Expected: FAIL on the background case — the bubble is pruned, `toHaveLength(1)` sees 0.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/renderer/store/store.ts`, replace line 304:

```ts
      pendingByWorker: Object.fromEntries(Object.entries(s.pendingByWorker).filter(([id]) => rowsById.get(id)?.status === "running")),
```

with:

```ts
      // Retain optimistic bubbles only while the worker can still consume the message. `background` counts:
      // the send is accepted and released at the next turn boundary, so pruning it here would erase a live
      // "waiting" bubble before the daemon's deferred echo arrives. Settled/terminal rows still get pruned
      // (A6: no ghost pending bubbles for workers that will never answer).
      pendingByWorker: Object.fromEntries(
        Object.entries(s.pendingByWorker).filter(([id]) => {
          const status = rowsById.get(id)?.status;
          return status === "running" || status === "background";
        }),
      ),
```

Also update the comment block above `setFleet` (line ~294) so it no longer claims running-only retention:

```ts
  // Prune vanished workers. Even for those that remain, if the worker can no longer consume a queued message
  // (not running/background), clear pending (A6: prevent ghost "pending" bubbles for settled workers on reconnect).
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm -w apps/desktop test -- store-pending.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/store/store.ts apps/desktop/test/store-pending.test.ts
git commit -m "$(cat <<'EOF'
fix(desktop): retain optimistic worker bubbles while in background

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: RepoTree — Stop stays reachable and the live filter keeps background workers

Two gates in the fleet tree. The Stop menu item matters most: `onStopSub` issues `fleet.stop`, the **only** control that kills background tasks (`interrupt` deliberately does not), and it was hidden exactly when the worker had background tasks to kill.

**Files:**
- Modify: `apps/desktop/src/renderer/views/RepoTree.tsx:113` and `apps/desktop/src/renderer/views/RepoTree.tsx:303`
- Test: `apps/desktop/test/repo-tree.test.tsx`

**Interfaces:**
- Consumes: `isLive` from Task 1 (already imported by `RepoTree.tsx:7`).
- Produces: no new API.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/repo-tree.test.tsx`:

```tsx
describe("RepoTree background-state affordances", () => {
  const repoRow = { name: "app", path: "/code/app", description: "", base: null };
  const bgWorker = {
    id: "wbg", label: "workflow worker", repoPath: "/code/app", status: "background",
    branch: "rookery/wbg", model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null,
  };

  it("offers Stop for a background worker — fleet.stop is the only control that kills background tasks", () => {
    const onStopSub = vi.fn();
    render(
      <RepoTree
        repos={[repoRow] as never}
        fleet={[bgWorker] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
        onStopSub={onStopSub}
      />,
    );
    fireEvent.contextMenu(screen.getByText("workflow worker"));
    fireEvent.click(screen.getByText("중단")); // repoTree.menuStop (tests run under the ko fallback catalog)
    expect(onStopSub).toHaveBeenCalledWith("wbg");
  });

  it("keeps a background worker visible under the live filter", () => {
    render(
      <RepoTree
        repos={[repoRow] as never}
        fleet={[bgWorker] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("활성")); // repoTree.onlyActive — the "live" toggle in the en catalog
    expect(screen.getByText("workflow worker")).toBeInTheDocument();
  });
});
```

Label reference (verified): `repoTree.menuStop` is `"중단"` and `repoTree.onlyActive` is `"활성"` in the ko
catalog, which is what component tests see (`useT` falls back to ko with no provider). The English catalog
renders the same toggle as `live`, which is what the bug-report screenshot showed.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm -w apps/desktop test -- repo-tree.test.tsx
```

Expected: FAIL — the Stop item is absent from the context menu for a background worker, and the live filter hides the row.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/renderer/views/RepoTree.tsx`, replace line 113:

```tsx
  const isActiveWorker = (f: FleetRow): boolean => f.status === "running" || f.status === "idle" || f.status === "provisioning" || !!p.attention?.[f.id];
```

with:

```tsx
  // "Active" for the live filter = anything not settled for good. `background` (bg tasks still running) is the
  // most active state there is — hiding it made a worker vanish from the tree mid-Dynamic-Workflow.
  const isActiveWorker = (f: FleetRow): boolean =>
    f.status === "running" || f.status === "background" || f.status === "idle" || f.status === "provisioning" || !!p.attention?.[f.id];
```

Replace line 303:

```tsx
            ...(menuSub.status === "running" || menuSub.status === "idle" ? [{ label: t("repoTree.menuStop"), onClick: () => p.onStopSub?.(menu.id) }] : []),
```

with:

```tsx
            // stop: whenever the worker is not terminal — running/background/idle. `background` especially:
            // fleet.stop tears down the subprocess tree and is the ONLY way to kill background tasks
            // (interrupt aborts a turn and deliberately leaves them alive), so hiding it here left a
            // background worker with no stop path at all.
            ...(menuSub.status === "running" || menuSub.status === "background" || menuSub.status === "idle"
              ? [{ label: t("repoTree.menuStop"), onClick: () => p.onStopSub?.(menu.id) }]
              : []),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm -w apps/desktop test -- repo-tree.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/views/RepoTree.tsx apps/desktop/test/repo-tree.test.tsx
git commit -m "$(cat <<'EOF'
fix(desktop): keep Stop and the live filter working for background workers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: unread marking survives the retirement of `done`

The `worker.status` unread branch marks `idle | done | error | failed`. Since `done` is retired from live writes, a worker that ends naturally now emits `stopped` and gets no unread dot and no tier-2 attention-bell entry.

**Files:**
- Modify: `apps/desktop/src/renderer/store/store.ts:262`
- Test: `apps/desktop/test/store-reduce.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new API — the unread set becomes `idle | stopped | done | error | failed` (`background` and `running` deliberately excluded).

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/store-reduce.test.ts`:

```ts
describe("worker.status unread marking (done is retired from live writes)", () => {
  const seed = (status: string) => {
    useStore.setState({
      fleet: { w1: { id: "w1", label: "w1", repoPath: "/code/app", status, branch: "rookery/w1", permissionMode: "bypassPermissions" } },
      attention: {}, activeWorkerId: null, deletingWorkers: {}, workerLogs: {},
    } as never);
  };

  it("marks unread when a worker ends naturally (stopped — the live replacement for done)", () => {
    seed("background");
    useStore.getState().applyEvent({ type: "worker.status", workerId: "w1", status: "stopped" } as never);
    expect(useStore.getState().attention.w1).toBe(true);
  });

  it("still marks unread on idle and on failure", () => {
    for (const status of ["idle", "error", "failed"]) {
      seed("running");
      useStore.getState().applyEvent({ type: "worker.status", workerId: "w1", status } as never);
      expect(useStore.getState().attention.w1).toBe(true);
    }
  });

  it("does NOT mark unread for background — the worker is still working, not awaiting review", () => {
    seed("running");
    useStore.getState().applyEvent({ type: "worker.status", workerId: "w1", status: "background" } as never);
    expect(useStore.getState().attention.w1).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm -w apps/desktop test -- store-reduce.test.ts
```

Expected: FAIL on the `stopped` case — `attention.w1` is undefined.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/renderer/store/store.ts`, replace line 262:

```ts
        if (e.status === "idle" || e.status === "done" || e.status === "error" || e.status === "failed") {
```

with:

```ts
        // Settled-and-worth-a-look. `stopped` is included because the worker state graph retired `done` from
        // live writes: a natural stream end now lands on `stopped` (+ a notice), so leaving it out meant a
        // finished worker produced no unread dot and no attention-bell entry at all. `background` is excluded
        // on purpose — the turn ended but the work has not, so there is nothing to review yet.
        if (e.status === "idle" || e.status === "stopped" || e.status === "done" || e.status === "error" || e.status === "failed") {
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm -w apps/desktop test -- store-reduce.test.ts attention-queue.test.ts attention-bell.test.tsx
```

Expected: PASS (the attention-queue/bell suites confirm no downstream ranking regression).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/store/store.ts apps/desktop/test/store-reduce.test.ts
git commit -m "$(cat <<'EOF'
fix(desktop): mark unread when a worker settles on stopped

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: OS notification for a crashed worker

`notifyFor`'s map covers `idle | done | stopped | failed`. A worker that dies with `error` — the live counterpart of `failed` written by `Worker.transition` — produces no OS notification at all. Reuse the existing `notify.failed` string rather than adding a near-duplicate key.

**Files:**
- Modify: `apps/desktop/src/renderer/lib/notify.ts`
- Test: `apps/desktop/test/notify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `notifyFor` returns a notification for `error` (body = `notify.failed`), and still returns `null` for `background`.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/notify.test.ts`:

```ts
describe("notifyFor across the worker state graph", () => {
  it("notifies on error — the live sibling of failed (Worker.transition writes error, the orchestrator writes failed)", () => {
    expect(notifyFor("running", "error", "app", ko)?.body).toMatch(/실패|에러/);
    expect(notifyFor("running", "error", "app", en)?.body).toBe("Failed — an error occurred");
  });

  it("does NOT notify on entering background — the worker is still working", () => {
    expect(notifyFor("running", "background", "app", ko)).toBeNull();
  });

  it("notifies on stopped, the live replacement for the retired done state", () => {
    expect(notifyFor("background", "stopped", "app", ko)?.body).toMatch(/중지/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm -w apps/desktop test -- notify.test.ts
```

Expected: FAIL — `notifyFor("running", "error", …)` returns `null`.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/renderer/lib/notify.ts`, replace the `KEYS` map:

```ts
const KEYS: Record<string, string> = {
  idle: "notify.idle",
  done: "notify.done",
  stopped: "notify.stopped",
  failed: "notify.failed",
};
```

with:

```ts
// Settled states worth an OS notification. `error` and `failed` share one line: they are the same outcome
// written by two different authorities (Worker.transition vs FleetOrchestrator.setStatus). `done` is retired
// from live writes but stays mapped for legacy rows replayed from the DB. `running`/`background`/`provisioning`
// are mid-work and deliberately absent.
const KEYS: Record<string, string> = {
  idle: "notify.idle",
  done: "notify.done",
  stopped: "notify.stopped",
  failed: "notify.failed",
  error: "notify.failed",
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm -w apps/desktop test -- notify.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/lib/notify.ts apps/desktop/test/notify.test.ts
git commit -m "$(cat <<'EOF'
fix(desktop): notify on worker error, not only failed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Slack worker-status icon stops depending on the retired `done`

`reporter.ts:293` picks `✅` only for `done`, which no longer occurs live, so every terminal transition — including outright failures — posts the same neutral `🤖`. Slack genuinely cannot distinguish a natural end from a user-requested stop (both are `stopped`), so do not fabricate a success mark; distinguish the one thing that *is* knowable — failure.

**Files:**
- Modify: `src/slack/reporter.ts:288-295`
- Test: `test/slack/reporter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new API — terminal `worker.status` posts use `⚠️` for `error`/`failed`/`orphaned` and `🤖` otherwise; `done` keeps `✅` for legacy replay.

- [ ] **Step 1: Write the failing test**

Append to `test/slack/reporter.test.ts`, reusing the file's existing `Rec` / `fakeClient` / `target` / `ev`
harness (defined near the top; `ev.status(s)` builds a `worker.status` event for worker `a1`):

```ts
describe("worker.status terminal icons (done retired from live writes)", () => {
  it("flags a failure transition with a warning icon instead of the neutral robot", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.status("error"));
    await r.idle();
    expect(rec.posts.some((p) => p.includes("⚠️") && p.includes("a1"))).toBe(true);
  });

  it("posts a neutral icon for stopped — Slack cannot tell a natural end from a user stop", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.status("stopped"));
    await r.idle();
    expect(rec.posts.some((p) => p.includes("🤖") && p.includes("a1"))).toBe(true);
    expect(rec.posts.some((p) => p.includes("⚠️"))).toBe(false);
  });

  it("still suppresses non-terminal chatter (running/idle/background)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    for (const status of ["running", "idle", "background"]) r.onEvent(ev.status(status));
    await r.idle();
    expect(rec.posts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/slack/reporter.test.ts
```

Expected: FAIL — the `error` transition posts `🤖`, not `⚠️`.

- [ ] **Step 3: Write the implementation**

In `src/slack/reporter.ts`, replace line 293:

```ts
        const icon = e.status === "done" ? "✅" : "🤖";
```

with:

```ts
        // Failure is the only terminal outcome Slack can identify from status alone: `stopped` covers both a
        // natural stream end and a user-requested stop since the state graph retired `done` from live writes,
        // so a success mark there would be fabricated. `done` keeps its check for legacy rows replayed from DB.
        const FAILED = new Set(["error", "failed", "orphaned"]);
        const icon = FAILED.has(e.status) ? "⚠️" : e.status === "done" ? "✅" : "🤖";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/slack/reporter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slack/reporter.ts test/slack/reporter.test.ts
git commit -m "$(cat <<'EOF'
fix(slack): flag failed worker transitions instead of relying on retired done

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Full-gate verification and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-worker-state-graph-design.md` (append a follow-up section)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Run every gate**

```bash
npm run typecheck && npm test
npm -w apps/desktop run typecheck && npm -w apps/desktop test
```

Expected: all green. Baseline before this plan was root 1272 passed / 104 files, desktop 1093 passed / 142 files — the new counts must be strictly higher with zero failures.

- [ ] **Step 2: Re-sweep for surviving gates**

```bash
grep -rn '"running"' apps/desktop/src/renderer --include=*.ts --include=*.tsx | grep -v "background" | grep -iv "workflow\|master\|session\|tool"
grep -rn '"done"' apps/desktop/src/renderer src/slack src/core --include=*.ts --include=*.tsx
```

Expected: every remaining `"running"`-only comparison is deliberately master/session/workflow scoped (not worker-state), and every remaining `"done"` is a legacy-read path with a comment saying so. If a genuine new gap turns up, add a task rather than patching silently.

- [ ] **Step 3: Document the follow-up**

Append to `docs/superpowers/specs/2026-07-11-worker-state-graph-design.md`:

```markdown
## Follow-up: 2026-07-19 desktop interaction-gate gaps

The original change updated the renderer's *display* channels (`lib/status.ts` RAIL/TAG/TONE,
`WorkspaceHeaders`) but not its *interaction gates*, so a worker in `background` was rendered correctly and
yet could not be typed to, stopped, or filtered for. Fixed in the same sweep:

- `lib/worker-composer.ts` (new) — the single worker composer gate, replacing a chain duplicated across
  App.tsx's dockable and static render paths. `background` is writable, matching `Worker.send()`.
- `store.ts setFleet` — optimistic bubbles retained for `background`, not just `running`.
- `RepoTree` — context-menu Stop and the "live" filter include `background`. Stop matters most:
  `fleet.stop` is the only control that kills background tasks; `interrupt` deliberately does not.
- `store.ts worker.status` — unread marking includes `stopped`, since `done` no longer occurs live.
- `lib/notify.ts` — `error` notifies (previously only `failed` did).
- `lib/status.ts isLive` / `StatusBadge` — `background` keeps the live LED and does not fire the end-flash.
- `slack/reporter.ts` — terminal icon flags failures rather than depending on the retired `done`.

Deliberately unchanged: `WorkerNotifier` still excludes `background` from SETTLED (no premature master
wake), and `ConversationPane`'s composer stop button stays keyed to `running` — during `background` there
is no turn to interrupt, and offering a stop that cannot kill background tasks would be misleading. The
real stop lives in the tree's context menu.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-11-worker-state-graph-design.md
git commit -m "$(cat <<'EOF'
docs: record the 2026-07-19 worker background gate sweep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
