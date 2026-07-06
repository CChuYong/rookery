# Codex model/effort picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** replace the free-text Codex model input with a `model/list`-driven dropdown + per-model reasoning-effort selector across all 4 desktop surfaces, with a free-text fallback when the catalog can't be fetched. Spec: `docs/superpowers/specs/2026-07-06-codex-model-picker-design.md`.

**Architecture:** mirror the existing Claude `models.list` path — a daemon provider (`codex-models-provider.ts`, sibling of `models-provider.ts`) fetches the catalog via a short-lived `codex app-server` child, a new `codex.models.list`/`codex.models.result` protocol pair carries the richer per-model-effort shape, the desktop caches it in a `codexModels` store slot, and the 4 codex surfaces render selects driven by it.

## Global Constraints

- **Node 22 first** (`better-sqlite3` ABI 127); ESM NodeNext (`.js` imports, `import type`); English code comments; Korean-default user-facing strings (i18n ko+en, byte-identical key sets).
- **Dual gates** on shared-type/renderer changes: root `npm run typecheck && npm test` + `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- No SDK/daemon runtime imports in desktop main/renderer (`@daemon/*` = type-only).
- `codex.models.result.models` is `CodexModelInfo[] | null`; `null` = fetch failed → desktop free-text fallback (today's behavior). Never a static dropdown.
- `CodexModelInfo = { id: string; displayName: string; defaultEffort: string; supportedEfforts: string[]; isDefault: boolean }`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Sequencing: T1 (daemon+protocol) → T2 (store+lib+fetch) → T3 (spawn+session UI) → T4 (automation+settings UI) → T5 (docs+gates).

---

### Task 1 — daemon codex-models-provider + protocol + connection + server (TDD)

**Files:** Create `src/core/codex-models-provider.ts`; Modify `src/protocol/messages.ts` (new message pair + `CodexModelInfo`), `src/daemon/connection.ts` (handler + injected dep), `src/daemon/server.ts` (construct + inject). Test: `test/core/codex-models-provider.test.ts`, `test/protocol/messages.test.ts`, `test/daemon/connection.test.ts`.

**Interfaces:**
- Produces: `CodexModelInfo` (exported from `codex-models-provider.ts`, re-declared structurally in `messages.ts`); `makeCodexModelsProvider(opts: { spawn: CodexSpawn; timeoutMs?: number }): { list(): Promise<CodexModelInfo[] | null> }`.
- Consumes: `CodexSpawn` + `CodexClient` from `src/core/codex/`; the app-server handshake (`initialize` `{ clientInfo: { name, title, version }, capabilities: { experimentalApi:false, requestAttestation:false } }` → `initialized` → `model/list { includeHidden:false }`), verified live against 0.142.5.

**The provider** (`codex-models-provider.ts`): mirror `models-provider.ts`'s shape.
```ts
import { CodexClient } from "./codex/codex-client.js";
import type { CodexSpawn } from "./codex/codex-transport.js";

export interface CodexModelInfo { id: string; displayName: string; defaultEffort: string; supportedEfforts: string[]; isDefault: boolean; }
const CLIENT_INFO = { name: "rookery", title: "rookery", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 10_000;

// Maps one raw `model/list` data[] row (camelCase, ts-rs) → CodexModelInfo. Drops rows without an id.
function mapModel(m: unknown): CodexModelInfo | null {
  const o = m as { id?: unknown; displayName?: unknown; defaultReasoningEffort?: unknown; supportedReasoningEfforts?: unknown; isDefault?: unknown; hidden?: unknown };
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) return null;
  const supported = Array.isArray(o.supportedReasoningEfforts)
    ? o.supportedReasoningEfforts.map((e) => (typeof e === "object" && e && typeof (e as { reasoningEffort?: unknown }).reasoningEffort === "string" ? (e as { reasoningEffort: string }).reasoningEffort : "")).filter(Boolean)
    : [];
  return { id, displayName: typeof o.displayName === "string" ? o.displayName : id, defaultEffort: typeof o.defaultReasoningEffort === "string" ? o.defaultReasoningEffort : "", supportedEfforts: supported, isDefault: o.isDefault === true };
}

export function makeCodexModelsProvider(opts: { spawn: CodexSpawn; timeoutMs?: number }): { list(): Promise<CodexModelInfo[] | null> } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cache: CodexModelInfo[] | null = null; // caches the first SUCCESS only
  return {
    async list() {
      if (cache) return cache;
      const client = new CodexClient(opts.spawn({}));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("codex model/list timed out")), timeoutMs); });
      try {
        await Promise.race([client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }), timeout]);
        client.notify("initialized", {});
        const res = (await Promise.race([client.request("model/list", { includeHidden: false }), timeout])) as { data?: unknown };
        const rows = Array.isArray(res?.data) ? res.data : [];
        const models = rows.map(mapModel).filter((m): m is CodexModelInfo => m !== null);
        // hidden rows are excluded server-side by includeHidden:false (mapModel has no hidden pass-through, so no client filter needed).
        if (models.length === 0) return null; // empty catalog = treat as failure, don't cache → retry later
        cache = models;
        return cache;
      } catch {
        return null; // codex missing / not authed / timeout / malformed → null (NOT cached)
      } finally {
        if (timer) clearTimeout(timer);
        client.close();
      }
    },
  };
}
```

**Protocol** (`messages.ts`): add to the client-message union `z.object({ type: z.literal("codex.models.list"), reqId: z.string() })`; add the outbound `| { type: "codex.models.result"; reqId: string; models: CodexModelInfo[] | null }` (declare a structural `CodexModelInfo` interface in messages.ts — do NOT import from core, protocol is transport-agnostic); add `"codex.models.list": Extract<ServerMessage, { type: "codex.models.result" }>` to the reqId→response map (mirror `models.list`).

**Connection** (`connection.ts`): add optional injected `codexModels?: { list(): Promise<CodexModelInfo[] | null> }` (mirror `models` at ~:31, import `CodexModelInfo` type). Handler after the `models.list` case:
```ts
case "codex.models.list": {
  const models = (await this.codexModels?.list()) ?? null;
  this.reply({ type: "codex.models.result", reqId: msg.reqId, models });
  return;
}
```

**server.ts**: `const codexModelsProvider = makeCodexModelsProvider({ spawn: realCodexSpawn(() => settings.codexBin()) });` and pass it into the `Connection` ctor (add the arg mirroring `modelsProvider` at :432).

- [ ] Failing tests: provider maps a scripted `model/list` (fake CodexSpawn → emits initialize ok + a `data[]` with gpt-5.5[xhigh,low..] + a hidden row) → CodexModelInfo[] with efforts, hidden absent, isDefault; spawn-error/timeout/empty-data → null; success caches (2nd list() reuses, no 2nd spawn), null doesn't cache (2nd list() re-spawns). Protocol accepts both messages (models array + null). Connection returns provider result / null when dep absent. → implement → gates.
- [ ] Commit: `feat(codex): codex.models.list — app-server model/list catalog provider + protocol`.

**Testing note:** reuse `test/helpers/fake-codex.ts` (the fake CodexSpawn/transport). The provider needs a fake that answers `initialize` then `model/list`; extend the helper if it can't yet script a `model/list` response (mirror how it scripts `thread/start`).

---

### Task 2 — desktop store `codexModels` + lib helpers + connect fetch (TDD)

**Files:** Modify `apps/desktop/src/renderer/store/store.ts` (slot + setter), `apps/desktop/src/renderer/lib/models.ts` (helpers + `CodexModelOption` type re-exported from the daemon `CodexModelInfo`), `apps/desktop/src/renderer/App.tsx` (fetch on connect ~:453). Test: `apps/desktop/test/store-*.test.ts` (or a new `codex-models` test), `apps/desktop/test/lib-models` (or inline).

**Interfaces:**
- Consumes: `CodexModelInfo` from `@daemon/protocol/messages.js` (type-only).
- Produces: store `codexModels: CodexModelInfo[] | null` + `setCodexModels`; `codexEffortsFor(model, list): string[]`; `codexDefaultEffort(model, list): string | undefined`.

- store.ts: `codexModels: CodexModelInfo[] | null` (initial `null`) + `setCodexModels: (m: CodexModelInfo[] | null) => void` (mirror `models`/`setModels` at :50-52,155-156; type-only import of `CodexModelInfo`).
- lib/models.ts:
```ts
import type { CodexModelInfo } from "@daemon/protocol/messages.js";
export function codexEffortsFor(model: string, list: CodexModelInfo[] | null): string[] {
  return list?.find((m) => m.id === model)?.supportedEfforts ?? [];
}
export function codexDefaultEffort(model: string, list: CodexModelInfo[] | null): string | undefined {
  return list?.find((m) => m.id === model)?.defaultEffort || undefined;
}
```
- App.tsx (~:453, beside the `models.list` fetch): `void c.request({ type: "codex.models.list" }).then((r) => useStore.getState().setCodexModels(r.models ?? null)).catch(() => {});`

- [ ] Failing tests: `setCodexModels(list)` / `setCodexModels(null)` round-trip; `codexEffortsFor("gpt-5.5", list)` → its efforts, unknown model → `[]`; `codexDefaultEffort` known → default, unknown → undefined. → implement → gates.
- [ ] Commit: `feat(desktop): codexModels store slot + effort helpers + connect fetch`.

---

### Task 3 — WorkerSpawnModal + NewSessionPage codex model/effort selects (TDD)

**Files:** Modify `apps/desktop/src/renderer/components/WorkerSpawnModal.tsx`, `apps/desktop/src/renderer/components/NewSessionPage.tsx`, i18n if new labels. Test: `apps/desktop/test/worker-spawn-modal.test.tsx`, `apps/desktop/test/spawn-modal.test.tsx`, a NewSessionPage test.

Pattern for BOTH (guarded by `provider === "codex" && codexModels != null`):
- Read `const codexModels = useStore((s) => s.codexModels);`.
- **Model**: when codex + list present, render a `<Select>` of `codexModels` (`value=id`, label=`displayName`) bound to the existing codex-model state (`codexModel`/`setCodexModel`), replacing the free-text `<Input>`. Preserve an out-of-list current value as an extra `<option>` (mirror the Claude select's `{!models.some(...) && <option>}` idiom already in WorkerSpawnModal ~:156). When `codexModels == null`, keep today's free-text `<Input>`.
- **Effort**: when codex + list present, the effort `<Select>` options = `codexEffortsFor(codexModel, codexModels)`; when the model changes, set effort to `codexDefaultEffort(newModel, codexModels)` (a small onChange handler that updates both). When list null, keep the generic `EFFORTS` selector. Labels via `effortLabelKey`.
- WorkerSpawnModal: `effectiveModel` (~:90) already = codexModel for codex; the effort selector visibility uses `effortSupported(effectiveModel)` — for codex keep it visible and swap its option source.
- NewSessionPage: codex has its own effort `<Select>` rendered near the free-text field (per its :83-86 comment); swap the model field + effort options the same way.

- [ ] Failing tests: (each component) codex + codexModels set → model `<Select>` lists the models; selecting a model updates effort options to that model's efforts and pre-selects its default; codexModels null → free-text model input still renders; an out-of-list current model value appears as a selectable option; onSpawn/onStart payload carries the selected codex model + effort. → implement → gates.
- [ ] Commit: `feat(desktop): codex model+effort dropdowns in spawn modal & new-session`.

---

### Task 4 — AutomationForm + SettingsPage codex model selects (TDD)

**Files:** Modify `apps/desktop/src/renderer/components/AutomationForm.tsx`, `apps/desktop/src/renderer/components/SettingsPage.tsx`, i18n if new labels. Test: `apps/desktop/test/automation-form.test.tsx`, `apps/desktop/test/settings-page.test.tsx`.

- **AutomationForm** (model `<Select>` from `models` at :33, model :71/effort :72, provider :68): when `provider === "codex" && codexModels != null`, source the model `<Select>` from `codexModels` (instead of the Claude `models`) and drive the effort `<Select>` from `codexEffortsFor(model, codexModels)` + default on model-change. When claude or list null, unchanged (the current model select already tolerates free-text/unknown ids — keep that as the codex fallback). `resolvedEffort` (:104) currently gates on `effortSupported`; for codex use the model-driven efforts (still a string or null).
- **SettingsPage** (codexWorkerModel :385, codexMasterModel :388, free-text `<Input>` today): when `codexModels != null`, render each as a `<Select>` of `codexModels` (value=id) bound to `f.codexWorkerModel`/`f.codexMasterModel`, preserving an out-of-list saved value as an extra option and an empty "" option (= "use daemon default"). When `codexModels == null`, keep the free-text `<Input>`. (Settings has no per-model effort default here — leave the global effort settings unchanged; model-only.)

- [ ] Failing tests: AutomationForm codex + list → model select from codexModels + effort options model-driven; claude → unchanged; SettingsPage codex model defaults render as selects when list present (value round-trips into `f`), free-text when null, out-of-list saved value preserved. → implement → gates.
- [ ] Commit: `feat(desktop): codex model dropdowns in automation form & settings defaults`.

---

### Task 5 — docs + full gates

- [ ] `CLAUDE.md`: in the Codex worker/master notes, add that the desktop codex model/effort pickers are now driven by the app-server `model/list` catalog (`codex.models.list` protocol → `codex-models-provider.ts`, cached, free-text fallback when unfetchable) — replacing the free-text model fields.
- [ ] `docs/2026-07-05-codex-backend-parity.md`: note the model-picker parity landed.
- [ ] Spec status: add an "implemented" blockquote to `docs/superpowers/specs/2026-07-06-codex-model-picker-design.md`.
- [ ] Full gates: root typecheck/test/build + desktop typecheck/test.
- [ ] Commit: `docs: codex model picker status`.

## Self-Review Notes
- Mirrors the Claude `models.list` provider/protocol/store/picker path at every layer — trace each `models`/`modelsProvider`/`setModels` site and add the codex sibling.
- `null` (not a static list) is the honest fetch-failure signal → free-text fallback preserves today's behavior for codex-less/unauthed users.
- Per-model effort (from `supportedReasoningEfforts`/`defaultReasoningEffort`) is the one thing Claude's flat `EFFORTS` can't express — the lib helpers encapsulate it so all 4 surfaces share the logic.
- Daemon fetch is one cached short-lived app-server spawn per daemon lifetime; failure isn't cached so post-boot auth recovers.
