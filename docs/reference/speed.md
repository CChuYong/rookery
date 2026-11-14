# Speed preferences and accounting

Source of truth: [`speed.ts`](../../src/core/speed.ts), provider adapters, [`codex-pricing.ts`](../../src/core/codex/codex-pricing.ts) and [`codex-version.ts`](../../src/core/codex/codex-version.ts).

`SpeedPreference` is `standard|fast`. Nullable session, Worker and automation overrides inherit the live provider/role [setting](settings-and-env.md), initially Standard. Speed travels through create/send/fork, fleet MCP and automation actions. A busy target finishes its active turn; selection changes apply at the next user-turn boundary. Explicit queued preferences stay with their input. Side inherits the source preference. Reload/restart/native forks preserve intent; cross-provider handoff recomputes capability and observation.

Claude supplies `settings: {fastMode}` in memory. A streaming follow-up awaits `applyFlagSettings` before delivering its input; control failure becomes a visible error rather than silently executing at another speed. Reported SDK `fast_mode_state` and disabled reason produce `SpeedObservation {requested,state,reason?}`, where state is `unknown|standard|fast|cooldown`. The selector is the only inline speed UI. Known historical state, cooldown and provider reasons remain inspectable in its tooltip; generic next-turn and unknown-availability messages are omitted. A report is never a latency guarantee.

Codex requires CLI **0.169.0** or newer for the verified `turn/start.serviceTierForTurn` contract. It sends `default|fast` on every turn rather than sticky thread settings. A successful Fast request still has `state: unknown`. Catalog `serviceTiers` metadata is authoritative when present: `priority` and legacy `fast` tier ids allow Fast; an explicit list excluding them blocks it. Missing metadata permits a request with unknown availability. Claude's supported-model catalog may advertise `supportsFastMode`; account/organization preference can still prevent Fast at execution. Neither provider's real user configuration is rewritten.

## Cost quality and budgets

Results persist optional `costAccuracy: reported|estimated|unavailable` and `requestedSpeed`. Claude retains SDK-reported USD differencing, including the persisted resume watermark, without a Fast multiplier. Codex uses explicit Standard/Fast token-price tables; the UI and budget wording label its costs **estimated**. Provider-native cumulative costs are intentionally excluded to avoid charging fork/resume history twice.

The tables were checked against the official pricing source on 2026-11-14 (source/date are in pricing code). GPT-5.5 Fast is 2.5× Standard; no blanket multiplier applies. There is no inferred Fast price for GPT-5.5-pro or GPT-5.4-nano. The GPT-5.6 Sol promotional row expires 2026-11-30 and needs rechecking then.

Unknown model/tier rates, missing or incomplete usage, cumulative-counter rollback, cache-write retention ambiguity, and observed individual requests above 272K input tokens make an estimate unavailable. Accumulated turn input can contain repeated short requests and must never select a context tier. Cold resume can have insufficient prior telemetry, so even a later priced turn cannot repair an incomplete cumulative total. Quality remains unavailable across restart/fork until a separately complete accounting boundary exists; this feature does not fabricate one.

With unavailable quality, compatibility `costUsd`/`cumCostUsd` numbers represent known spend only. Clients show unknown rather than a reliable-looking zero or full total. A budgeted Worker stops further turns at the boundary when accounting becomes unavailable; a Master emits a warning under its existing budget policy. Ordinary numeric ceilings are also checked at boundaries and can overshoot by one turn. Native nested Codex child token spend remains outside Worker cumulative cost and its budget guard.

No effective Fast, account entitlement, latency improvement or actual provider bill is implied by a requested preference or an estimate. See the [validation record](../superpowers/specs/2026-11-14-speed-and-images-validation.md) for measured acceptance and account restrictions.
