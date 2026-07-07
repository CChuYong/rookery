# Settings: unify Claude/Codex under a "Models" tab with a pill sub-toggle

**Date:** 2026-07-07
**Component:** `apps/desktop/src/renderer/components/SettingsPage.tsx` (+ i18n, + affected tests)
**Scope:** desktop renderer only — no daemon/protocol/settings-key changes (fields are relocated, not renamed).

## Problem

Settings has grown to five top-level tabs: `General · Slack · Claude · Codex · Integration`. Claude and Codex are two instances of the same concept (the agent backend/provider), so they belong under one umbrella. There's also an asymmetry: the Codex tab holds its model defaults, but the Claude worker model/effort defaults live in the General tab.

## Design

### Top-level structure
`General · Slack · Claude · Codex · Integration` → **`General · Slack · Models · Integration`** (5 → 4). The `Models` tab hosts a **pill `Segment` sub-toggle** `[ Claude | Codex ]`; each sub-tab shows that provider's complete config. The top-level tabs keep `variant="underline"` (nav-tier); the sub-toggle uses `variant="pill"` (in-form selection) — the existing `ui/segment.tsx` already provides both variants, and this matches its own documented grammar, so no new component is needed and the parent/child hierarchy is visually unambiguous.

### Sub-tab content (each provider = complete)
- **Claude** = current Claude tab (auth-status card + Anthropic API key) **＋ Worker model + Effort** (moved out of General's `workerModelEffort` section). These are Claude-specific (they drive the Claude model list).
- **Codex** = current Codex tab, unchanged: `codexBin` + codex worker/master model + `codexTurnIdleTimeoutMs` + `codexHandshakeTimeoutMs` + Codex API key.

### General tab
- The Claude worker model + effort fields move to the Claude sub-tab.
- **`workerCostBudgetUsd` stays in General** — it is provider-agnostic (applies to Claude *and* Codex workers), so it must not be buried under the Claude sub-tab. It gets its own slim section (heading `settings.workerBudget`) so it stays discoverable.
- Bot name, default folder, usage, language sections are unchanged.

### State
- `Tab` type: `"general" | "slack" | "claude" | "codex" | "integration"` → `"general" | "slack" | "models" | "integration"`.
- New sub-toggle state: `const [modelsProvider, setModelsProvider] = useState<"claude" | "codex">("claude")`.
- Ephemeral (not persisted): opening Settings resets the top tab to `general` today (top-level `tab` is a fresh `useState`), and the sub-toggle likewise defaults to `claude` each time. Consistent with the existing non-persisted tab behavior.

### i18n
- Add `settings.tabModels` (ko: "모델", en: "Models") to both catalogs.
- Add `settings.workerBudget` (ko/en) for the relocated cost-budget section heading.
- The sub-toggle labels reuse the literal `"Claude"` and `t("settings.tabCodex")`.
- Keep ko/en key sets identical (the `catalog.test.ts` parity invariant). Do not delete existing keys still referenced.

## Components / boundaries
- `SettingsPage.tsx` is the only source file changed (single file, already the settings composition point). No new components — `Segment` (pill) and `Field` are reused.
- The `onSave` / setting-key contract is untouched: `workerModel`, `workerEffort`, `workerCostBudgetUsd`, and all `codex*` keys keep their names; only their on-screen placement moves.

## Testing
- **New:** a test asserting the Models tab exists, the pill sub-toggle switches Claude↔Codex, the Claude sub-tab now exposes the worker-model field, and General no longer does.
- **Update:** `settings-page.test.tsx`, `settings-claude.test.tsx` and any test that navigates by clicking the "Claude"/"Codex" tab — they must first open the `Models` tab, then toggle the sub-provider.
- **i18n:** `catalog.test.ts` (ko/en parity) and `used-keys.test.ts` (every `t()` key exists) must stay green with the new keys.
- Gate: `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.

## Out of scope (YAGNI)
- No new settings (e.g. a Claude master-model field, or separate codex effort default) — only relocate what exists.
- No persistence of the tab/sub-tab selection.
- No daemon, protocol, or settings-schema changes.
