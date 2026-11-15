# Worker spawn as a full page — design

Date: 2026-11-15 · Status: implemented on `feat/worker-spawn-page` (owner delegated the design: "decide and build it")

## Why
The "New worker" dialog (520px modal) felt cramped: the task box was small, the GitHub/Linear results list was a
44-unit dropdown that pushed the dialog past the viewport, and seven unlabeled controls (provider, model, effort, a bare
cost field, speed, permission, base) were stacked with placeholders as their only labels. New Session already lives as a
full main-area page; spawning a worker should feel the same.

## Decisions
- **Navigation:** a new overlay `spawnWorker` in the single Location model, carrying the target repo in the existing
  `repoId` slot (same pattern as `repoSettings`). Back/forward and the sidebar behave like every other full page. The
  repo tree's `+` navigates there; a successful spawn selects the new worker (existing `selectSub`), which closes the page.
- **Component:** `WorkerSpawnPage` replaces `WorkerSpawnModal`. All form logic moves over unchanged (provider/model/effort
  resolution, speed, cost budget parsing, source search + keyboard handling, spawn-once guard, error keeps the form).
- **Layout (IDE skill: 13px chrome, no hero, labels over placeholders):**
  - Title bar like New Session: `New worker` · repo breadcrumb · close ×.
  - Centred 720px column: one quiet heading; a repo row (registered repos as ghost buttons — switching repo re-targets
    branches and source search); source tabs (Write directly / GitHub / Linear, underline variant).
  - Source mode: a full-width search field with an inline results list (taller, no clipping); the picked item shows as a
    row with a clear button.
  - Task box styled like the composer surface (larger textarea) with a bottom control row: provider · model · effort ·
    speed as quiet selects, and the Spawn button on the right. ⌘/Ctrl+Enter spawns.
  - "Options" section under it: a labeled 2-column grid — Label, Base branch, Permission mode, Cost budget (USD) — each
    with a 12px label, plus the worktree footnote and the Codex estimate note.
  - Footer actions: Cancel (closes the page) and Spawn.
- **Escape** does not close the page (keeps the typed task safe — same as the old dialog); Escape inside the source search
  only closes the results list.
- **Not in scope:** persisting the draft across navigation, multi-repo spawn, image attachments (the spawn protocol has none).

## Verification
Unit tests ported from the two modal test files to the page, plus navigation (overlay + repoId) and repo switching; desktop
typecheck/tests; a live screenshot of the page at default and narrow widths.
