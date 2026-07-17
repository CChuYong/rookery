# Slack Context Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Slack-origin master turn starts with `[Slack] sender: … · channel: … · thread: …` so the model knows who asked and where. Spec: `docs/superpowers/specs/2026-07-17-slack-context-prefix-design.md`.

**Architecture:** One helper in `handle-incoming.ts` builds the header (best-effort names via the existing `SlackRefResolver` carried on `IncomingCtx`); `handleIncoming` prepends it to the turn text after the empty-turn check; `app.ts` passes the connection's resolver at both event call sites.

## Global Constraints

- Header is exactly one line; name values whitespace-collapsed and byte-capped at 80 via `truncateBytes`.
- Resolver absence/failure degrades to raw ids — never blocks or throws into the turn.
- The empty-turn guard evaluates the ORIGINAL text+attachments, not the header.
- Gates: `npm run typecheck` && `npm test` on Node 22.

---

### Task 1: header builder + prepend (TDD)

**Files:** Modify `src/slack/handle-incoming.ts`, `test/slack/handle-incoming.test.ts`.

**Interfaces produced:**
- `IncomingCtx` gains `nameResolver?: SlackRefResolver`.
- `export async function buildSlackContextPrefix(ctx: Pick<IncomingCtx, "channel" | "threadTs" | "userId" | "nameResolver">): Promise<string>`.

**Steps:**
- [ ] Failing tests (use the existing `capturing(prompts)` helper; pass `nameResolver` fakes on ctx):
  - resolved: prompt starts with `[Slack] sender: clover (U1) · channel: #general (C1) · thread: 100.1` and contains the original text after a blank line
  - unresolved/no-resolver: `[Slack] sender: U1 · channel: C1 · thread: 100.1`
  - no userId: header has no `sender:` segment
  - sanitization: a display name `"evil\nname"` renders as `evil name` (single line)
  - update `prompts[0]).toBe("@/dl/F2/diagram.png")` → header + `\n\n@/dl/F2/diagram.png` shape
- [ ] Implement `buildSlackContextPrefix` (resolver → `resolve([channel], userId ? [userId] : [])`, clean = collapse whitespace + `truncateBytes(..., 80)`, segments joined with `" · "`), and in `handleIncoming` replace `runTurn(turnText)` with `runTurn(`${await buildSlackContextPrefix(ctx)}\n\n${turnText}`)`.
- [ ] `npx vitest run test/slack/handle-incoming.test.ts` → PASS; commit `feat(slack): prepend sender/channel context header to slack turns`.

### Task 2: wire the resolver + docs + gates

**Files:** Modify `src/slack/app.ts`, `AGENTS.md`.

**Steps:**
- [ ] `app.ts`: move the `nameResolver` creation above the `Assistant` construction; add `nameResolver` to both `IncomingCtx` literals (assistant `userMessage`, `app_mention`).
- [ ] AGENTS.md Slack adapter section: note that Slack turns carry a `[Slack] sender/channel/thread` header (names best-effort via the connection's name resolver).
- [ ] `npm run typecheck` && `npm test` → PASS; commit `feat(slack): wire context header resolver and document it`.
