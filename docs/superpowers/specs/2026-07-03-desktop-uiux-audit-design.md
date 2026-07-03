# Desktop UI/UX Audit — Design

**Date:** 2026-07-03
**Status:** Approved (design). Workflow authored at `.claude/workflows/desktop-uiux-audit.js` — **not yet run.**

## Goal

Produce a prioritized, evidence-backed inventory of UI/UX issues in the desktop
app (`apps/desktop`) — visual, interaction, structural, copy, and accessibility —
so improvement waves can be chosen deliberately instead of fixing whatever is
noticed first. This is a **discovery** phase: no fixes are made during the audit.

## Approach (chosen: capture-once → parallel lens audit)

Driving the GUI is interactive, finicky work; analysis is what parallelizes.
So the app is launched and screenshotted **once, inline** (Phase 0), and a
multi-agent workflow then fans out **lens agents** that analyze the screenshot
set together with the renderer source. Per-screen agents each driving their own
app instance was rejected: N agents contend for one GUI and share one
PID-locked daemon, cross-contaminating state.

A second structural decision, made explicitly: agents **discover** issues, but
**do not decide** what or how to fix. Direction/taste decisions happen with the
user over the finished report; only then does implementation fan out.

## Phase 0 — Capture (inline, prerequisite for the workflow)

Launch: Node 22 → root `npm run build` → `npm -w apps/desktop run dev` with
`--remote-debugging-port` → capture via CDP `Page.captureScreenshot` (fallback:
macOS `screencapture`). Shots + a `manifest.md` (one line per shot describing
what it shows) go to `.superpowers/uiux-audit/shots/` (gitignored).

Capture checklist:

- **Sessions**: list grouped by date (ui/slack badges), empty state
- **Conversation**: streaming bubble, thinking block, tool cards
  (in-progress + complete), notice chip, interaction card, metrics row, composer
- **Dock workspace**: default template, file tab (Monaco), diff tab, commit tab,
  terminal panel, custom tabs
- **Right sidebar**: Files / Git / Worker segments
- **RepoTree**: repo + worker tree, worker transcript/detail
- **Pages**: Settings (every section incl. Slack), Automation page + form/modal,
  NewSessionPage
- **Modals**: WorkerSpawnModal, RepoModal, Onboarding/GettingStartedChecklist
  (DataConsentModal only if a fresh profile is convenient)
- **Edge states**: no repos, no workers, daemon-down banner, reconnecting
- **Locales**: ko and en for a handful of key screens
- Longstanding pending item — **dock visual verification** — is folded into
  this pass.

## Workflow — `.claude/workflows/desktop-uiux-audit.js`

Args: `{ shotsDir (required, absolute), notes?, outPath? }`.

1. **Lens audit** — 7 parallel lens agents, each reading `manifest.md`,
   relevant shots, `apps/desktop/AGENTS.md` (to avoid reporting intentional
   design), and renderer source:
   - `visual-consistency` — spacing/typography/color/density drift
   - `state-coverage` — loading/empty/error/skeleton gaps
   - `interaction-feedback` — hover/focus/disabled, in-flight feedback,
     rollback UX, toasts, confirmations
   - `ia-navigation` — dock/tab/sidebar model, discoverability, flow length
   - `copy-i18n` — wording quality both locales, truncation, tone drift
     (key parity is test-enforced and out of scope)
   - `a11y-keyboard` — focus traps/restore, tab order, aria, shortcuts
   - `pixel-pass` — screenshots only, "demanding design reviewer" first look
2. **Verify** — every finding gets an adversarial verifier (refute-first;
   uncertain → rejected) that also scores it: severity `high|medium|low`
   (blocks/confuses a core flow → noticeable friction → polish), effort
   `S|M|L` (<1h single-file → multi-file/design decision → structural).
   Verification pipelines per lens (no barrier) — cross-lens duplicates are
   merged later at synthesis.
3. **Synthesize** — one agent merges duplicates, groups by theme, writes
   `docs/2026-07-03-desktop-uiux-audit.md` (Korean, English technical terms):
   요약 + quick wins → priority table → per-theme detail → rejected-findings
   appendix (transparency).
4. **Critique** — a completeness critic re-checks the report against the
   confirmed-findings JSON (nothing dropped, evidence cited, table↔detail
   consistency) and fixes gaps in place.

Expected scale: ~7 lens agents + one verifier per finding (est. 40–80) + 2.

## After the audit (separate cycle, out of scope here)

Review the report together → pick improvement waves → each wave gets its own
design/plan/implementation cycle (worktree fan-out where items are independent).

## Non-goals

- No fixes, refactors, or design proposals beyond per-finding suggestions.
- No code-correctness auditing (covered by the 2026-07-03 agent-loop audit).
- No i18n key-parity checks (already test-enforced).
