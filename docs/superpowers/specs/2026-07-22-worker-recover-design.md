# Worker recover (stuck-Stop escalation) — design

## Problem

Pressing the chat composer's **Stop** on a worker sometimes leaves it spinning forever; only a daemon restart clears it. Observed on a worker running a Dynamic Workflow (`c0e1ac9a`, the $2681 / 7-agent audit).

Root cause, confirmed in code:

- The composer Stop for a worker is **`worker.interrupt`** → `Worker.interruptTurn()` → SDK `query.interrupt()` — a **soft, turn-only** interrupt. It does **not** `abort.abort()` the subprocess.
- A worker leaves the `running` state only when the consume loop sees a `turn_end`/result frame (`worker.ts` — that's the sole place `turnActive` is set false). The SDK's soft interrupt can't preempt a turn blocked **inside a long-running in-flight tool call** — most acutely a **Dynamic Workflow** orchestrating many sub-agents. So `turn_end` never arrives, `turnActive` stays true, the fleet row stays `running`, and the composer's Stop spinner (which resets only when the status leaves `running`, and is `disabled` meanwhile) spins indefinitely.
- The only live control that actually kills it is **`fleet.stop`** (RepoTree right-click) → `Worker.stop()` → `abort.abort()` (kills the subprocess tree) — **but it's terminal**: the worker goes `stopped` → "Worker ended — view only", unusable live (worktree kept; a daemon restart's `rehydrate()` lazy-resumes it back to idle).

So neither live control gives "abort the wedged turn and keep using the worker" — the user's actual need. That's what a daemon restart does (kill subprocess + rehydrate-resume), but bluntly, to the whole fleet.

## Solution: per-worker recover (= the daemon-restart rehydrate, scoped to one worker)

**`Worker.abandon()`** — hard-kill the subprocess **without** a terminal transition: `queue.close()` + `abort.abort()` + best-effort `stream.interrupt()`, then `await this.loop`. The consume loop's aborted-return paths (both the natural-end `if (abort.signal.aborted) return` and the catch's) end it with **no `stopped`/`error` transition and no "Stream ended" notice** — unlike `stop()`, which transitions first.

**`FleetOrchestrator.recover(id)`** — `abandon()` the live agent, then re-arm the entry as a **lazy resume of the same `sdk_session_id`** (`agent = undefined`, `resumeSessionId = sdk`, `setStatus(idle, force)`). The next `send` materializes a fresh worker resuming the same conversation (`requireLive` → `materialize`). Rejects when there's no `sdk_session_id` or the worktree is gone (nothing to resume → use stop/discard). This is exactly `rehydrate()`'s lazy-resume applied live.

- Protocol: **`worker.recover`** (`id`) → `fleet.ack{action:"recover"}`; non-terminal, unlike `fleet.stop`.
- ⚠️ **Caveat (inherent, same as a daemon restart):** the in-flight turn's **live output is lost** — killing the subprocess is the only way to break a wedged tool call. The conversation itself is preserved (resumed from `sdk_session`), and the worktree is untouched. The killed subprocess takes its bg tasks / workflow with it, so the re-armed worker starts with an empty task set.

## UI: Stop → Recover escalation (composer)

The composer Stop stays a soft interrupt (unchanged for the common case). When Stop is clicked and the worker is **still busy `STUCK_STOP_MS` (6s) later**, the dead spinner is swapped for a **"Recover"** button (`worker.recover`). Worker-only: `onRecover` is passed to the worker composers, not the master (whose interrupt lands normally). The escalation resets when the turn ends (`busy` flips false).

This fixes both halves of the reported problem: the **functional** gap (a wedged worker can now be recovered live, without a restart and without losing the worker) and the **UX** dead-end (the Stop spinner no longer spins forever with no escape).

## Not done / follow-ups

- The daemon's Dynamic-Workflow activity registry may still show the abandoned run as running (it tails journals; the killed run gets no terminal frame). Cosmetic; not addressed here.
- Recover after an abrupt mid-tool-call kill relies on the SDK resuming the session cleanly (the same path a daemon restart uses). Not live-e2e verified in this change — unit-covered via fake ports only.
