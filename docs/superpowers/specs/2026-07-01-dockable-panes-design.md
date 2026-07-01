# Dockable Panes (VSCode-like workspace) — Design

**Date:** 2026-07-01
**Branch:** `feat/dockable-panes`
**Status:** Approved (design), pending implementation plan

## Goal

Replace the desktop app's static, edge-fixed panel layout with a VSCode-like
dockable/splittable pane system: drag tabs between groups, split any pane
(horizontal/vertical), dock panels to any edge, resize via sashes, and
persist/restore the arrangement. Deliver it PoC-first, behind a feature flag,
so the existing UI keeps working until the new one is validated.

## Scope

**In scope (full parity target):**
- Drag tabs between groups
- Split any group horizontally/vertically
- Dock panels to any edge of any group
- Resize via sashes
- Show/hide panels (files, git, terminal, nested)
- Persist + restore layout (per page)

**Stretch:** floating groups (draggable, within the same window).

**Explicitly out of scope:**
- OS-level popout windows (separate `BrowserWindow`). Cost/risk (CSP, preload,
  IPC, Monaco/xterm re-init in a new document) is disproportionate. Separate
  future effort if ever.

**Boundaries (to bound blast radius):**
- The **left rail** (session/repo nav + usage + daemon/slack status) stays
  **fixed** — it is the app shell ("which agent am I looking at"), not workspace
  content. Not dockable.
- **Overlays** (settings / newSession / automation / daemon-down) keep their
  current **full-replace** behavior over the workspace area.
- Dock target = **everything right of the left rail** (the `<main>` area).

## Key technical finding (drives the library choice)

Instance preservation across docking moves is the make-or-break property:

- **Monaco** (`MonacoEditor.tsx`): `automaticLayout:true` handles resize, but on
  unmount it calls `ed.dispose()` and on remount reloads from disk → **unsaved
  edits are lost on remount**. (Today, page switches already remount it via the
  `key={pageId}` wrapper, so cross-page loss is existing behavior, not a
  regression.)
- **xterm** (`TerminalView.tsx`): the PTY lives in main; unmount `detach`s and
  remount `attach`s with scrollback replay → **no data loss on remount**, only a
  brief flash.

Therefore, dragging a panel to a new group must **not remount** its React
subtree, or Monaco edits are lost. The library that guarantees this is
**dockview**: it renders each panel through a **React portal** into a
dockview-managed container, so moving a panel moves only the DOM node while the
React tree position stays stable → Monaco/xterm instances survive.

- react-mosaic remounts on tree restructuring → unsafe for Monaco.
- rc-dock can preserve but has a rougher API.
- dockview is MIT, pure JS/CSS (no native deps → no ABI/asar issues, as safe to
  bundle as Monaco).

This preservation assumption is **validated first**, in Phase 0, before any
migration.

## Target architecture

```
<div flex h-screen>
  <WindowControls/>
  <LeftRail/>              ← existing <aside> unchanged (sessions/repos/usage/status)
  <ResizeHandle/>
  <main>
    {reconnect strip}
    {overlay ? <OverlayPage/>                  ← full replace (unchanged)
             : <WorkspaceDock pageKey kind/>}   ← NEW: the dockview workspace
  </main>
</div>
```

`WorkspaceDock` (new) owns one dockview instance, registers the **panel
registry**, binds content by `pageKey`, and persists layout per `pageKey`. The
workspace portion of `App.tsx`'s static JSX (~lines 652–975) moves here → App.tsx
shrinks substantially.

### Panel registry (each is a dockview panel component)

| panel id | content (existing component) | notes |
|---|---|---|
| `conversation` | `ConversationPane` (master/worker chat + composer) | primary, non-closable |
| `editor:<path>` | `MonacoEditor` / `MonacoDiff` / `CommitView` / `ImagePreview` | **one dockview tab per file** — replaces custom `TabBar`; enables editor splits |
| `terminal` | `TerminalPanel` | PoC: keep internal PTY tabs (single panel); later: promote each PTY to a dockview tab |
| `files` | `FileTree` | RightSidebar segment decomposed |
| `git` | `GitChanges` | |
| `nested` | `NestedAgents` | |

The existing `RightSidebar` Files|Git|Worker segment control is decomposed into
three independent panels (stacking them in one group reproduces the old
segmented look).

## State & persistence

- **dockview becomes the source of truth for layout.** The existing
  `workspace.ts` `byPage.tabs` (editor tab list) is replaced by dockview's
  serialized layout JSON. `openFile_` / `closeTab_` / `setActive_` reducers are
  replaced by dockview API calls (`addPanel` / `removePanel` / `setActive`).
- **Layout is serialized per `pageKey`** (extends the existing per-page model). A
  new page is seeded from a **default template** (conversation left · editor
  center · terminal bottom · files/git right) with content bound to that page.
  Per-page arrangement is acceptable — each page is a distinct workspace.
  (Resolved open decision ②: per-page over a single global template.)
- `expandedByPage` (file-tree expansion) and the terminal store (`height` /
  `layout`) are largely retained. dockview theme CSS is mapped onto the rookery
  `@theme` tokens (coral/ink).

## Resolved open decisions

1. **OS popout windows: excluded.** (cost/risk)
2. **Layout arrangement: per-page** (extends existing model; recommended).
3. **Left rail: fixed** (app shell, not dockable; recommended).

## Phased plan (flag-gated, PoC-first, reversible)

Build dockview **alongside** the existing layout behind a feature flag; validate,
then migrate. The app stays functional throughout.

- **Phase 0 — Spike (validation gate):** put real `MonacoEditor` (with unsaved
  edits) + `TerminalView` (with scrollback) + `ConversationPane` into a dockview
  and confirm **instance preservation** across drag-split and drag-between-groups.
  If it fails, reconsider the library here (rc-dock, or accept remount+restore).
  **This is the real answer to "is it feasible?"**
- **Phase 1 — PoC (worker page only):** implement the worker workspace
  (conversation + editor + terminal + files + git) via `WorkspaceDock` with
  per-`pageKey` layout persistence, behind the flag. Session pages and overlays
  keep the existing path.
- **Phase 2 — Generalize + persist:** extend to session pages; default template,
  restore, prune, page-switch content rebinding, dockview theming.
- **Phase 3 — Migrate:** remove the custom `TabBar` / `RightSidebar` /
  right+bottom `ResizeHandle`; clean up App.tsx; remove the flag.
- **Phase 4 — Stretch:** floating groups.

Each phase gates on `npm run typecheck` + vitest. dockview interactions are weak
to unit-test under jsdom, so a `npm run dev` manual check is an explicit
checkpoint at each phase.

## Risks

- **R1 (core):** dockview instance-preservation assumption — validated in Phase 0.
  The whole plan is premised on it.
- **R2:** handing editor tabs to dockview means rewriting the `byPage.tabs`
  persistence/restore; saved tabs need migration.
- **R3:** dockview CSS theming to match the rookery design tokens is non-trivial
  polish work (deferred within phases, not blocking).

## Non-goals / preserved behavior

- Left rail, overlays, WS/IPC data flow, terminal PTY ownership in main, and
  Monaco's fs/watch behavior are unchanged.
- Cross-page unsaved-edit loss is existing behavior; not addressed here.
