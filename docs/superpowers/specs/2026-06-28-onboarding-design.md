# Onboarding + default session folder — design

Date: 2026-06-28

## Problem

On first run the only UI is the data-consent modal (`hasAcceptedDataNotice`). After accepting,
a new user lands in an empty app with no guidance. The two real prerequisites to actually use
rookery — Claude auth (no auth → the SDK can't run) and a sensible working folder — are not
surfaced, and rookery's master/worker-fleet/memory model is unusual enough to need a one-time
explanation. Separately, starting a session without picking a folder falls back to the daemon's
`process.cwd()` (`connection.ts`), which feels like an arbitrary `~/` rather than an intended default.

## Goal

A **hybrid** onboarding: a short welcome + concept (modal, 2 screens) → a non-blocking,
auto-detecting "Getting Started" checklist in the empty main area. Plus a companion fix: a
configurable **default session folder**.

## Design

### 1. State & trigger
- New setting `onboardingDone` ("0"/"1", default "0") — same mechanism as `hasAcceptedDataNotice`.
- Order: data consent (existing) → if `onboardingDone !== "1"` show onboarding → on finish/skip set `onboardingDone="1"`.
- Re-openable later via a "Getting Started / 둘러보기" entry (so it isn't strictly one-time).

### 2. Welcome + concept (modal, 2 screens, reuses the consent card style)
- Screen 1 — welcome: rookery one-liner (an orchestrator agent with memory).
- Screen 2 — concept: You → Master (orchestrator) → Worker fleet (one per isolated worktree) + Memory.
- Step dots, Back/Next/Skip.

### 3. Getting Started checklist (persistent, non-blocking, dismissible, auto-checking)
Lives in the empty main area when there is no active session. Items auto-complete from live state:
1. **Claude auth** — ✓ when `authStatus.method !== "none"` (warning tone if none). Action → Settings → Claude.
2. **Default work folder** — ✓ when `defaultSessionCwd` is set. Action → folder picker → save.
3. **First session** — ✓ when ≥1 session exists. Action → New Session.
- Collapsed "more": register repo / Slack / automation — plain links, non-blocking.
- Shows progress (e.g. 2/3) and a close button.

### 4. Default session folder (companion fix)
- New settings value `defaultSessionCwd`, mirroring `slackCwd` in `settings.ts` (settings-only, falls back to `process.cwd()`).
- `connection.ts`: session creation uses `msg.cwd ?? settings.defaultSessionCwd() ?? process.cwd()`, applied consistently (create / getOrCreateByKey / commands.list cwd resolution).
- `NewSessionPage` folder picker: when nothing is selected, show the actual default folder name instead of the generic "default folder" label.
- Settings → General: a "default work folder" field (folder picker), like the Slack cwd field.

### 5. i18n
- New onboarding + settings keys in both ko and en catalogs (keys/params byte-identical; parity test).

## Scope / YAGNI
- Concept = 2 screens. Checklist = 3 core items; optional items are plain links.
- No new animations beyond the existing `rise-in`.
- No server-side persistence of checklist dismissal beyond `onboardingDone` (checklist visibility derives from live state + the dismiss flag).

## Out of scope
- Interactive product tour / tooltips overlay.
- Multi-step repo/Slack wizards (just links into existing settings).
