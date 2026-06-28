# Add an i18n String (localized text)

> **Source of truth:** `src/core/i18n.ts`, `apps/desktop/src/renderer/i18n/` (`core.ts`/`catalog.ts`/`types.ts`/`resolve.ts`, `locales/{ko,en}/*.ts`), `apps/desktop/src/main/i18n.ts`, `apps/desktop/test/i18n/catalog.test.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

There are **three independent i18n catalogs**, each ko + en, **Korean is the default**. Pick the one that owns your surface:

| String surface | Catalog | API |
|---|---|---|
| Slack / CLI / daemon `notice.*` / interaction summaries | daemon `src/core/i18n.ts` | `t(locale, key, params)` |
| Desktop renderer UI (JSX, placeholder, title, aria-label, toasts) | `apps/desktop/src/renderer/i18n/locales/{ko,en}/<ns>.ts` | `useT()` → `t("ns.key", params)` |
| Desktop **main** process (terminal/workspace errors) | `apps/desktop/src/main/i18n.ts` | `mt(key, params)` |

All three interpolate `{name}` placeholders the same way (`/\{(\w+)\}/g`). Code comments are written in English everywhere.

## Recipe A — daemon string (Slack / CLI / notice)

Edit `src/core/i18n.ts`. Keys are grouped by surface prefix: `notice.*` `slack.*` `cli.*` `interaction.*`.

1. Add the key to the `KO` object (`src/core/i18n.ts:6`) with the Korean text.
2. Add the **same key** to `EN` (`src/core/i18n.ts:45`). `EN` is typed `Record<keyof typeof KO, string>`, so a missing key is a **compile error** — typecheck enforces ko/en parity here.
3. Use it: `t(locale, "slack.myKey", { count })`. Resolve the locale with `resolveLocale(s)` (`src/core/i18n.ts:84`); `DEFAULT_LOCALE` is `"ko"`. Slack's output language is the `slackLocale` setting.

## Recipe B — desktop renderer UI string

Strings live in per-**namespace** files (namespace = camelCase component name), auto-collected by `catalog.ts` via `import.meta.glob` (`apps/desktop/src/renderer/i18n/catalog.ts:13`) — **no central index to edit**, just add/extend a file.

1. In `apps/desktop/src/renderer/i18n/locales/ko/<ns>.ts`, add `"<ns>.key": "한국어"` (file shape: `export default { … } satisfies Catalog`).
2. Add the **identical key** to `apps/desktop/src/renderer/i18n/locales/en/<ns>.ts` with the English value. For a brand-new namespace, create both `ko/<ns>.ts` and `en/<ns>.ts`.
3. In the component: `const t = useT();` (a hook — call it at the top, not inside a conditional) then `t("<ns>.key")` or `t("<ns>.key", { count })`. In non-component modules, accept `t: TFunc` as a parameter and let the caller pass it. Reuse shared terms from `common.*` (Save/Cancel/Close/…).

`useT` **falls back to ko** when no `I18nProvider` is present — this protects Korean-asserting component tests.

## Recipe C — desktop main-process string

Edit `apps/desktop/src/main/i18n.ts` (self-contained, separate build target — it cannot import the renderer catalog). Add to both `ko` and `en` (the `en` map is `Record<keyof typeof ko, string>`, so parity is compile-enforced). Use `mt("key", params)`. The renderer pushes the active locale to main via `system.setLocale`.

## The cross-catalog invariant (notices) — read carefully

Daemon `master.notice` events carry a structured `code` + `params` (not just rendered text): `recordEvent({ type: "master.notice", code: "notice.turnCap", params, text: t(...) })` (`src/core/master-agent.ts:359`). The daemon renders `text` in its own locale, but the **desktop re-localizes** the chip at render time using its `notice.*` namespace and the `code`/`params`.

Therefore the `notice.*` keys **and their param names** must be **byte-identical** between:
- daemon `src/core/i18n.ts` (the `notice.*` entries in `KO`/`EN`), and
- renderer `apps/desktop/src/renderer/i18n/locales/{ko,en}/notice.ts`.

This is an **intentional cross-build duplicate** — nothing automatically syncs them. If you add or change a `notice.*` key/param in one, change it identically in the other. A mismatch means the desktop falls through to the daemon-rendered `text` (wrong language) or shows the raw key. When emitting a new notice, add the key to **both** the daemon catalog and the renderer `notice.ts`, using the same `{param}` names you pass in `params`.

## Gotchas

- **ko/en parity.** Daemon and main catalogs enforce it via `Record<keyof typeof ko, string>` (compile error). The renderer enforces it at **test** time: `apps/desktop/test/i18n/catalog.test.ts` asserts identical key sets across ko/en and no namespace collisions; `used-keys.test.ts` asserts every literal `t("ns.key")` in renderer source exists in the ko catalog.
- **Korean is the source value.** The ko entry is the displayed original; en is the natural translation.
- **Notices need the cross-catalog mirror** (above) — the single biggest footgun.
- **Three catalogs, no sharing.** Don't try to import one from another; the main and renderer builds are isolated, and the daemon is a different package.
- ESM NodeNext: `.js` import extensions, `import type` for `Catalog`/`Locale`.

## Test & gate

```bash
npm run typecheck                     # daemon + main ko/en parity (compile-enforced)
npm test                              # daemon i18n tests
npm -w apps/desktop test              # catalog.test.ts (parity) + used-keys.test.ts
npm -w apps/desktop run typecheck
```

Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

See also [testing.md](testing.md) for the desktop jsdom + `useT` ko-fallback setup.
