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
- **Layout (revised after owner feedback: "as minimal as the reference — merge into the text box, hide what's rarely
  touched behind small buttons"):**
  - Title bar: `New worker` and a close ×.
  - Column (720px, vertically centred like New Session): a quiet left-aligned one-liner in New Session's style
    ("What should the worker do in `orbitkit`?") — the repo is part of the sentence and becomes an inline select when
    several repos are registered; then a single rounded box — the task textarea; in source mode the issue/ticket search
    (with an inline results list) or the picked item sits at the top of the box; the box footer holds the source switch
    (Write directly / GitHub / Linear) on the left and agent backend · model · effort plus a round send button on the right.
  - A quiet meta row under the box: base branch, permission mode, and "More".
  - "More" reveals label, cost budget and speed (kept mounted while hidden, so values survive collapsing).
- **Keys:** the page is not a modal (sidebar and status bar stay live), so it captures no window-level keys — menus keep
  their own Escape. Escape does not close the page (keeps the typed task safe); Escape inside the source search only
  closes the results list. The repo row is disabled while a spawn is in flight.
- **Not in scope:** persisting the draft across navigation, multi-repo spawn, image attachments (the spawn protocol has none).

## Verification
Unit tests ported from the two modal test files to the page, plus navigation (overlay + repoId) and repo switching; desktop
typecheck/tests; a live screenshot of the page at default and narrow widths.
