# AGENTS.md — apps/desktop

`@rookery/desktop` ("Rookery"): the Electron mission-control GUI for the rookery daemon. When launched, it **automatically starts the daemon as an external Node 22 process**, connects to it over an authenticated WebSocket, and live-renders master session chat and fleet management (worker spawn/diff/stop/discard). It is the root project's **only npm workspace** and directly imports daemon types at compile time via the `@daemon/*` alias. It follows the root conventions (Node 22 ABI, ESM `.js` extensions, `import type`) per [../../AGENTS.md](../../AGENTS.md).

## Commands

```bash
npm run dev          # ROOKERY_NODE="$(node -p 'process.execPath')" electron-vite dev  (renderer HMR)
npm run build        # electron-vite build → out/
npm run build:mac    # + electron-builder --mac
npm run typecheck    # tsc --noEmit -p tsconfig.json
npm test             # vitest run  (jsdom, globals, test/setup.ts loads jest-dom)
```

⚠️ **dev requires the root's compiled `dist/` to exist first.** This is because `DAEMON_ENTRY` points to `../../../../dist/index.js` (root dist) — if you haven't run `npm run build` at the root, you'll see a "Cannot connect to daemon" banner. The root `npm run dev` (tsx watch) does not produce dist. To bring everything up in one shot, use the root's `./scripts/dev.sh`.

## Three-layer architecture (main ↔ preload ↔ renderer)

`electron.vite.config.ts` produces three build targets.

- **main** (`src/main/`, Node): creates the `BrowserWindow` (`contextIsolation:true`, `nodeIntegration:false`), owns the `DaemonManager`, registers all `ipcMain.handle` channels, reads `~/.rookery/ws-token`, and handles native dialogs. It also **injects a Content-Security-Policy + window-open/navigation guards** (`csp.ts` — pure decision logic, applied via `onHeadersReceived`/`setWindowOpenHandler`/`will-navigate`; external `http(s)` opens in the OS browser via `shell.openExternal`, everything else is denied) and **tightens `~/.rookery` permissions** (0700/0600, best-effort, never throws) before spawning the daemon (`fs-hardening.ts`, an intentional duplicate of the daemon's own — main can't runtime-import daemon code).
- **preload** (`src/preload/`, CJS `index.cjs`): **the only bridge.** Exposed via `contextBridge.exposeInMainWorld("rookery", …)` — daemon/dialogs (`daemon.ensure/status`, `wsUrl`, `pickDirectory`, `pickFile`, `getPathForFile`), plus app-local IPC domain bridges (`ws.*` fs/git, `term.*` PTY, `resources.get`, `notify`). All are thin wrappers over `*:*` IPC.
- **renderer** (`src/renderer/`, React 18 + Tailwind v4 + Zustand): all of the UI.

> **Key point: data flows over WS, not IPC.** IPC is used only for (a) guaranteeing the daemon is started and (b) the WS URL+token / file·directory selection. All session, fleet, and repo data is exchanged directly with the daemon by the renderer's browser `WebSocket` (`ws/client.ts`).

> **Exception — the integrated terminal**: the terminal is the only feature whose data flows over **IPC** (`term:*`). The PTY is owned by the main process's `TerminalManager` (`src/main/terminal-manager.ts`) — `node-pty` is the app's **first native module**. node-pty 1.1 is an **N-API prebuild, so no Electron ABI rebuild is needed**, but when npm unpacks the prebuild it loses the +x on `spawn-helper`, causing `posix_spawnp failed` → restored by `postinstall: scripts/fix-pty-perms.cjs`. The renderer only displays and accepts input via `xterm.js` (`components/TerminalView.tsx`); tab state is a per-session pure reducer (`store/terminals.ts`). Because this is an app-local OS feature unrelated to the session/fleet domain, it does not detour through WS→daemon. The worker worktree cwd is resolved by main from `ROOKERY_HOME`+subId (no protocol change). **Build pitfall:** `node-pty` **must be external** in main via `externalizeDepsPlugin()` in `electron.vite.config.ts` — if bundled, the `.node` dynamic require dies **at runtime** with `Could not dynamically require ./prebuilds/.../pty.node` (the build passes, so it's only caught with `npm run dev`).

> **Workspace (files·git·Monaco)**: the main area is a **tab container** (tab 0, the conversation tab (master·worker), is pinned and non-closable, followed by file/diff tabs), with a `TabBar` below the header. The right sidebar is a **Files | Git | Worker** segment (`RightSidebar`; collapse/resize uses the same `useResizableWidth(side:"right")` as the left) — **the Worker segment hosts the former `NestedAgents`** (NestedAgents was refactored into a list component with no wrapper of its own). fs·git is handled by main's `WorkspaceManager` (`src/main/workspace-manager.ts`, TDD'd with injectable fs/exec) and flows over **`fs:*`/`git:*` IPC** (the same app-local boundary as the terminal, not WS). The work root is **shared with the terminal** via `resolveWorkRoot` in `resolve-root.ts` (worker worktree > session cwd > home). Clicking a file → `MonacoEditor` (edit·`Cmd+S` save·watch for external changes → reload/banner); clicking a git change → `MonacoDiff` (left HEAD / right working tree, read-only). **Monaco is pure JS**, so it has none of node-pty's ABI/asar issues — only the worker is self-hosted in `monaco-setup.ts` via Vite `?worker` (imported at the very top of `main.tsx`). Tab/explorer state is **per-page** (`store/workspace.ts`, `byPage[pageKey]`); the right sidebar open/width/segment is global.

> **State persistence (restore on restart)**: renderer UI state uses **zustand `persist`** (localStorage, synchronous restore → no flicker) — workspace tabs/right sidebar (`store/workspace.ts`, `rookery.ws`), terminal **layout (tab count + open) + height** (`store/terminals.ts`, `rookery.term`). The live `byPage` (which includes PTY ids) is **volatile** (not saved) — since terminals die when the PTY exits, only the slots are restored by **spawning N new shells on the page's first view** (no scrollback; on reload, live PTYs are reconnected via `term.list`). The last-viewed location is `lib/view-state.ts` (`rookery.view`) — **SAVE is gated until after restore** (to prevent the mount-time initial value from overwriting the saved value). Window size/position/maximized state is stored by **main's** `window-state.ts` in `~/.rookery/window-state.json` (off-screen clamp, `getNormalBounds`). All restores are **validated before being applied** (session exists, within a display); dead pages are cleaned up by `pruneWsPages`/`pruneLayout` after sessions·fleet arrive. persist is defended against schema changes via `version`+`migrate`.

## Daemon spawn & Node 22 ABI (`src/main/daemon-manager.ts`)

Because of `better-sqlite3` (native, ABI 127), the daemon **cannot run on Electron's built-in Node** → it must be spawned with an external Node 22.
- `runEnsure()`: `ping(/health)` → if up, returns `"already-up"`. Otherwise it does an **ABI pre-check** (`execFile(nodePath, ["-p","process.versions.modules"])`) to verify `REQUIRED_NODE_ABI(=127, env `ROOKERY_NODE_ABI`)` → on mismatch/unrunnable it returns `"bad-node"` **without spawning** (an immediate, clear error instead of a silent `require()` crash + timeout).
- Spawned with `ROOKERY_NODE` (the dev script sets it to the current Node path; defaults to `node`). `detached:true` + `.unref()` → **the daemon outlives the GUI** (it isn't killed when the window closes and is rediscovered via `/health` on the next launch). stdout/stderr go to `~/.rookery/daemon.log`. If the repo has an `.env`, `--env-file=` is prepended to load Slack tokens and the like.
- `ensure()` has an in-flight guard (`ensurePromise ??= …`) so concurrent calls spawn only once. `EnsureResult = "already-up" | "spawned" | "failed" | "bad-node"`. On an ABI mismatch, a localized banner (the `app.badNode` i18n key, set as the daemon "note") guides the user to Node 22.

## Renderer state model (`src/renderer/store/`)

A single Zustand store. `WsClient.onEvent` → `applyEvent(e)` → `set(s => reduceEvent(s, e))`. **`reduceEvent` is a pure, immutable function** (`store/reduce.ts`) that is unit-tested separately.

`AppState` core (the event-reduced part): `logsBySession` (session transcript) · `workerLogs` · `fleet` (global `Record<id, FleetRow>`) · `nested` (activity of nested agents spawned by a worker via Task, **live-only·non-persistent**) · `pendingBySession`/`pendingByWorker` (optimistic, not-yet-echoed user messages, reconciled by `clientMsgId`). Store-level (outside the reducer): `sessions/activeSessionId/repos/diff/daemon/usage/settings/overrides/models/automations/integrations/authStatus/slack`. `LogItem` is a `message | thinking | tool | worker | notice | interaction | metrics` discriminated union (the `notice` variant carries optional `code`/`params` so the chip is re-localized at render via the renderer's `notice.*` catalog; the `interaction` variant is the inline approve/AskUserQuestion card).

Event mapping (summary): `master.message.delta` → streaming bubble, `master.thinking` → collapsible reasoning block, `master.tool` start/end → tool card in_progress/complete, `master.notice` → centered chip, `interaction.request`/`resolved` → inline `InteractionCard`, `master.result` → metrics row, `worker.*` → fleet row + log. User messages echoed by the daemon are deduped via `isEchoUser` (to avoid conflicting with the optimistic render).

**Attention queue (헤더 벨)**: `lib/attention-queue.ts` derives a ranked "needs you now" list purely from existing store state (tier 0 = unresolved live interactions · 1 = worker/automation failures · 2 = the unread `attention`/`sessionAttention` maps promoted with context); `components/AttentionBell.tsx` renders it in both sidebar states (badge highlights tier 0; row click navigates). Dismissal routes by kind: failures → persisted ack (`store/acks.ts`, `rookery.acks`, pruned+capped), review items → flip the live unread map (so a re-settle re-surfaces). Tier-0 also fires an OS notification (`interaction.request` while unfocused) — the notify IPC carries `{workerId?|sessionId?}` targets (was worker-only). Design: docs/superpowers/specs/2026-07-11-attention-queue-design.md.

`ws/client.ts`: correlates requests and responses via an injected `reqId` (`q0`, `q1`…). **Auto-reconnect with a 1-second backoff**; on reconnect, `seedHistory` restores the session transcript — `session.history` returns the **master transcript events (session_events)** and `seedSessionLog` replays them through the master's own `reduceEvent` (not just text but tool/thinking/metrics/notice too) to build the committed transcript, then preserves the previous uncommitted tail. **Because the master streams thinking only as deltas** (not persisted), `MasterAgent` coalesces the accumulated thinking summary into a single `master.thinking` event when it starts an answer/tool and persists it. Workers use `worker.history` + `applySubEvent` (full events persisted from the start). On open, `App.connect()` fires `session.list`/`fleet.list`/`repos.list`/`settings.get` + **`events.subscribe` (the global channel — no per-session attach needed)**.

## Views (`src/renderer/views/`)

`Conversation` (chat·composer, ignores Enter during IME composition) · `Sessions` (left session list, grouped by activity date, ui/slack badges) · `RepoTree` (per-repo worker tree — **the live fleet UI currently lives here**) · `NestedAgents` (nested-agent panel, live-only). Worker git diff/changes are unified into the right Git panel (`GitChanges`/`GitHistory`) and the main-area `diff:`/`commit:` tabs (`MonacoDiff`/`CommitView`).

## First-run gates & in-app config

- **Data-transmission consent (`DataConsentModal.tsx`)**: a **blocking** first-run modal (Accept-only) gates the app on the persisted `hasAcceptedDataNotice` setting. The gate is conditioned on `daemon up && settings != null && hasAcceptedDataNotice !== "1"` so it doesn't flash before settings load; Accept writes `settings.set { hasAcceptedDataNotice: "1" }`.
- **In-app Anthropic API key**: the Settings page has a masked key field that writes the write-only `anthropicApiKey` setting (never echoed back). The daemon prefers this DB key over the env `ANTHROPIC_API_KEY`, so users can run without an env/OAuth setup. (See root `CLAUDE.md` for the daemon-side auth chain.)
- **CSP & navigation**: the renderer runs under a Content-Security-Policy injected by main (`csp.ts`); `window.open`/external navigation is denied, and `http(s)` links open in the OS browser via `shell.openExternal`. jsdom does not enforce CSP, so CSP regressions are caught only by `npm run dev` / `build:mac`, not by tests.

## Pitfalls

- **Hard requirement of ABI 127** — anything other than Node 22 yields `bad-node`. If you bump the Node version, also update `REQUIRED_NODE_ABI`/`ROOKERY_NODE_ABI`.
- **dev requires a pre-built root `dist/`** (see Commands above).
- **The daemon does not die when the window closes** (detached+unref) — logs·diagnostics are in `~/.rookery/daemon.log`.
- **The `nested` map is non-persistent** — reloading makes the nested panel disappear.
- **Slack-originated sessions are read-only in the UI** (composer disabled, badge shown) — converse with those from Slack.
- **Never runtime-import `better-sqlite3` or daemon code from main/renderer** (ABI conflict). `@daemon/*` is for **type-only** imports only.

## i18n (localization — `src/renderer/i18n/`)

A zero-dependency in-house i18n. It switches between two catalogs, Korean (ko) and English (en), at runtime via a React context (no reload needed).

- **Every new user-facing string must go through i18n** — JSX text·`placeholder`/`title`/`aria-label`/`alt`·`confirm/alert`·toasts/banners. **Code comments are written in English.**
- In a component: `const t = useT();` (a hook — outside conditionals) → `t("ns.key")` or the interpolated form `t("ns.key", { count })`. Non-component modules (e.g. `lib/notify.ts`) take `t: TFunc` as an argument and the caller passes it in.
- Strings go into per-**namespace (= camelCase component name)** files: `i18n/locales/ko/<ns>.ts` + `en/<ns>.ts` (`export default { "<ns>.key": "…" } satisfies Catalog`). The ko value = the displayed Korean original, en = natural English. **`catalog.ts` auto-collects them via `import.meta.glob`** → no central index editing needed (just add the file). Shared terms (Save/Cancel/Close/Loading…/Refresh, etc.) reuse `common.*`.
- **Invariant**: ko and en must have the same key set (`test/i18n/catalog.test.ts` parity) + every `t("…")` literal key in the source must exist in the catalog (`test/i18n/used-keys.test.ts`). `useT` **falls back to ko** when no provider is present (protecting Korean-asserting component tests).
- Language preference is renderer-local — `store/prefs.ts` (zustand persist `rookery.prefs`, `system|ko|en`, default `system`). Change it in the "Language" section of the settings page; applied immediately. The system locale comes from `window.rookery.system.getLocale()` (preload→main `app.getLocale()`); `main.tsx` awaits it once just before render and injects it into the `I18nProvider` (no flicker). The `system` choice maps `ko*` → ko and everything else → en.
- **Main-process strings** (terminal/workspace errors, etc.) live in a separate, self-contained `src/main/i18n.ts` (`mt(key)`) — independent of the renderer catalog/Vite glob. The renderer pushes the active locale via `system.setLocale`.
- **Daemon-emitted notices** (`master.notice`) carry a `code`+`params`; the renderer re-localizes them via the `notice.*` namespace. ⚠️ Those keys + param names must stay byte-identical to the daemon catalog (`src/core/i18n.ts`) — an intentional cross-build duplicate. **Slack's output language** is a separate daemon-side setting (`slackLocale`), edited in the Slack section of the settings page (distinct from this renderer-local Language toggle).
