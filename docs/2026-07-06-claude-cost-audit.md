# 2026-07-06 — Claude cost/turns accounting audit (findings)

**Question (carried backlog, flagged in the P1.5/P2/P2.5 reviews):** does the Claude path double-count cost/turns? The Codex adapter was fixed in P1.5 to sum *per-turn* usage deltas; the Claude adapter does `cumCostUsd += result.total_cost_usd` and `cumTurns += result.num_turns` each turn — if the SDK's `total_cost_usd`/`num_turns` were conversation-cumulative (growing each resumed send), that accumulation would inflate the session total.

## Verdict: NO bug — the accounting is correct.

`total_cost_usd` and `num_turns` on the Claude Agent SDK's `result` message are **per-send** (this `query()` invocation's own cost + agentic-loop count), **not** conversation-cumulative. So `cumCostUsd += ` / `cumTurns += ` correctly build a lifetime session total. Cost and turn displays are accurate; no inflation.

### Empirical evidence (`.superpowers/sdd/probe-claude-cost.mjs`, `probe-claude-turns.mjs` — real SDK, claude-haiku-4-5, resumed session)
- Trivial 2-turn resume: t1 `num_turns=1 cost=$0.0384`; t2 (same `session_id`) `num_turns=1 cost=$0.0051`. **t2 cost < t1 cost** — impossible if cumulative.
- Multi-loop (forced Bash tool calls) 2-turn resume: t1 `num_turns=2 cost=$0.0785`; t2 (same session) `num_turns=3 cost=$0.0117`. **t2 cost < t1**, and t2's `num_turns` reflects only t2's own loops (independent of t1's 2), not a cumulative ~5.
- `session_id` was identical across both turns → resume genuinely continued the conversation; the small independent t2 values are the *resumed* turn's own cost/turns.

Two independent probes, both decisive on cost (t2 < t1 rules out cumulative); the multi-loop probe additionally rules it out for `num_turns`.

## What this corrects
The prior code comment (`worker.ts`, pre-fix) claimed `num_turns` is "the provider's conversation-cumulative agentic turn count per send" and warned "Do NOT use cumTurns (double-counts across sends)." **Both claims are false** — an untested assumption baked into the P1 maxTurns design. The code was nonetheless correct (per-send accumulation is right; the cap using `ev.numTurns` is a legitimate *per-send* runaway guard, matching the `maxTurns` field's documented "per-result num_turns cap" intent). The comment is corrected to state the empirically-verified per-send semantics so a future change doesn't "fix" the correct accumulation into a real bug.

## Related (already resolved, not this issue)
The 2026-07-03 agent-loop audit flagged a *different* cost/turns defect — `cumCostUsd`/`cumTurns` not re-seeded from persisted history on a cold rebuild (restart/fork), producing a non-monotonic series. That was fixed: `worker.ts` and `master-agent.ts` re-seed both counters from the last persisted `result` on `resume()`/construction.

## Scope
Findings + a comment correction (no behavior change — the accounting was already correct). No further Claude cost work needed.

## Addendum 2026-10-19 — conclusion superseded for SDK >= 0.3.277
Re-probed against SDK 0.3.303 (claude-haiku-4-5): `result.total_cost_usd` is now a **running total**, not per-send. Resumed master-style turns reported $0.03168 → $0.03421 → $0.03619 (each = previous + that turn); a `forkSession` fork's first result ($0.03816) = the source's total + the fork turn; and results within a single streaming-input `query()` also accumulate ($0.00881 → $0.01624 → $0.01964), so long-lived streaming workers over-counted even on 0.3.259. `num_turns` stayed 1 in every case (still per-send). The "accumulate per-send values" statement above no longer holds for cost.

Fix: `ClaudeBackend` differences the total against a watermark (`AgentSessionOptions.costBaselineUsd`, emitted as `turn_end.costTotalUsd`); `turn_end.costUsd` is the per-turn delta. Master/Worker persist the watermark as `providerCostTotalUsd` inside the `master.result`/worker `result` payload and pass it back on every resumed stream (forks inherit it because they copy the transcript events). No backfill: `cumCostUsd` values already inflated in existing DBs are left as-is. A resume with no stored watermark (legacy rows) charges one turn as $0 and adopts the total.
