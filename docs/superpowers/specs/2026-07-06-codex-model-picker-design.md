# 2026-07-06 — Codex model/effort picker (design)

Replace the free-text Codex model input with a proper dropdown driven by the codex app-server's `model/list` catalog, with a per-model reasoning-effort selector — bringing Codex to parity with the existing Claude model picker (Claude-Code-style). Live-verified: the installed codex **0.142.5** `app-server` implements `model/list`.

## Motivation

Codex model is currently **free-text** across 4 desktop surfaces (WorkerSpawnModal, NewSessionPage, AutomationForm, SettingsPage defaults). Users must know exact slugs (`gpt-5.5`), and the effort selector uses the generic Claude vocabulary rather than what the chosen codex model actually supports. The codex app-server exposes an authoritative catalog we can drive the UI from.

## Ground truth (probed live against codex 0.142.5)

`model/list` (v2 JSON-RPC, after `initialize`/`initialized`) → `{ data: Model[], nextCursor }`, camelCase. Each `Model`:
`{ id, model, displayName, description, hidden, isDefault, defaultReasoningEffort, supportedReasoningEfforts: [{ reasoningEffort, description }], … }`.

Observed models: `gpt-5.5` (default, defEffort **xhigh**), `gpt-5.4` (medium), `gpt-5.4-mini` (medium), `codex-auto-review` (**hidden**). Efforts across all: `low/medium/high/xhigh` (no `max`). rookery's effort vocab (`src/core/effort.ts`, desktop `EFFORTS`) already includes `low|medium|high|xhigh|max`, so **no new effort tokens are needed**.

## Design (mirror the existing Claude `models.list` pattern)

### ① Daemon — `src/core/codex-models-provider.ts` (new; mirrors `models-provider.ts`)
`makeCodexModelsProvider({ spawn, timeoutMs? })` → `{ list(): Promise<CodexModelInfo[] | null> }`.
- `list()` spawns a short-lived `codex app-server` child (the injected `CodexSpawn`, = `realCodexSpawn(() => settings.codexBin())`), wraps it in a `CodexClient`, `initialize` → `initialized` → `model/list { includeHidden: false }` → `close()`, under a timeout guard (~10s; a hung child must not wedge). Maps `data[]` → `CodexModelInfo = { id, displayName, defaultEffort, supportedEfforts: string[], isDefault }`, dropping `hidden` (defense-in-depth even with `includeHidden:false`).
- **Caches the first successful non-empty result** (closure var, daemon lifetime). A failure returns `null` and is **not cached** → a later call retries (so installing/authing codex after boot recovers without a restart).
- Any error (codex missing / not authed / timeout / malformed) → `null`.
- `CodexModelInfo` interface exported (protocol + desktop reuse the shape).

### ② Protocol — `codex.models.list` → `codex.models.result`
- Inbound: `{ type: "codex.models.list", reqId }`.
- Outbound: `{ type: "codex.models.result", reqId, models: CodexModelInfo[] | null }` (`null` = couldn't fetch → desktop free-text fallback). A distinct message from `models.list` because the per-model effort shape is richer than Claude's `{id, displayName}`.

### ③ Connection + server wiring
- `Connection` gains an optional injected `codexModels?: { list(): Promise<CodexModelInfo[] | null> }` (mirrors `models`). Handler: `codex.models.list` → `reply({ type: "codex.models.result", models: (await this.codexModels?.list()) ?? null })`.
- `server.ts`: `const codexModelsProvider = makeCodexModelsProvider({ spawn: realCodexSpawn(() => settings.codexBin()) })` → passed to the `Connection` ctor.

### ④ Desktop store — `codexModels`
- `store.ts`: `codexModels: CodexModelInfo[] | null` + `setCodexModels`. Initial `null`.
- On connect (`App.connect`), fire `codex.models.list` alongside `models.list`; the result sets `codexModels` (cheap — daemon-cached). `null` stays `null`.
- **Runtime fallback when `codexModels` is null = free-text** (exactly today's behavior) — NOT a static dropdown. There is intentionally no static `CODEX_MODELS` dropdown fallback: a null list means "couldn't fetch the authoritative catalog," and guessing a stale static list would be worse than the honest free-text input. (If a static list is wanted later as test scaffolding it can live in the test, not the runtime path.)

### ⑤ Desktop lib helpers — `lib/models.ts`
- `codexEffortsFor(model, codexModels): string[]` → the chosen model's `supportedEfforts`, or `[]` if unknown.
- `codexDefaultEffort(model, codexModels): string | undefined` → the model's `defaultEffort`.
- Used by all 4 surfaces to populate + default the effort selector when provider === "codex".

### ⑥ Desktop UI — 4 surfaces
When `provider === "codex"` **and** `codexModels` is non-null:
- **Model** → `<Select>` of `codexModels` (value = `id`, label = `displayName`). If the current value isn't in the list (a saved override / settings default), it's kept as an extra `<option>` (mirrors the Claude select's out-of-list tolerance). `hidden` models never appear (filtered daemon-side).
- **Effort** → `<Select>` of `codexEffortsFor(selectedModel)`; changing the model pre-selects `codexDefaultEffort(model)` (user can override). Labels via the existing `effortLabelKey`/`common.effort*`.
- When `codexModels` is **null** (couldn't fetch) → the surface keeps today's **free-text** model input + generic effort selector. No breakage for codex-less/unauthed users.
- Surfaces: `WorkerSpawnModal`, `NewSessionPage` (master), `AutomationForm` (per-automation), `SettingsPage` (`codexWorkerModel`/`codexMasterModel` defaults). Claude surfaces are unchanged (already selects).

## Non-goals (YAGNI)
Manual refresh button (models rarely change; re-fetched on reconnect). Changing the Claude picker. Per-model price/context-window display. A shared Claude+Codex picker refactor (the 4 surfaces have different state wiring; a small lib helper is enough).

## Error handling
- Daemon `list()` never throws → `null` on any failure; the connection forwards `null`; the desktop degrades to free-text. A hung app-server child is bounded by the timeout guard.
- Malformed / partial `model/list` rows are dropped (missing `id`); an empty `data` → treated as a failed fetch (`null`, retry later) rather than an empty dropdown.

## Testing
- **Daemon provider**: fake `CodexSpawn` scripted to emit a `model/list` response → mapping + `hidden` filter + `defaultEffort`/`supportedEfforts` extraction; failure (spawn error / timeout / malformed) → `null`; success caches (2nd call doesn't re-spawn), failure doesn't cache (retry re-spawns).
- **Protocol**: `codex.models.list`/`codex.models.result` schema (models array + `null`).
- **Connection**: handler returns provider result / `null` when absent.
- **Desktop store**: `codex.models.result` sets `codexModels` (list and null).
- **Desktop lib**: `codexEffortsFor`/`codexDefaultEffort` (known model, unknown model).
- **Desktop components** (each of the 4): model→effort coupling (change model → effort options + default update), `null` → free-text fallback, out-of-list current value preserved as an option.
- i18n ko+en for any new labels.
- Dual gates (protocol + SettingsValues-adjacent shared types → desktop).

## Risks
- `model/list` is a **v2** app-server method; verified present in the pinned 0.142.5 binary, but a future codex bump could change the shape → the provider maps defensively (drops unknown/partial rows, `null` on failure) and rookery already pins/regenerates codex types on bumps.
- Fetch cost: one extra short-lived app-server spawn per daemon lifetime (cached). Negligible.
