# Dockable Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop app's static edge-fixed panel layout with a dockview-based VSCode-like dockable/splittable workspace, PoC-first behind a feature flag.

**Architecture:** A new `WorkspaceDock` owns one `DockviewReact` instance rendered in `<main>` (right of the fixed left rail). Existing panels (conversation, editors, terminal, files, git, nested) become dockview panel components. Panel `params` carry only serializable identity (`pageKey`/`kind`/`path`); live callbacks come from a stable `WorkspaceActionsContext`. Layout is serialized per `pageKey` in a new zustand store. Everything is gated behind a localStorage feature flag so the current layout stays default until validated.

**Tech Stack:** React 18.3, zustand 5, dockview (React), electron-vite, vitest + jsdom.

> **dockview v7.0.2 API note (verified against installed types):** v7 splits packages — install **both** `dockview-react` (React bindings) and `dockview` (meta, re-exports `dockview-core` types); `dockview-core` comes transitively. Import `DockviewReact` and `IDockviewPanelProps` from **`dockview-react`**; import `DockviewReadyEvent` / `SerializedDockview` / `DockviewApi` from **`dockview`**. `DockviewApi` has `addPanel({id,component,params,position:{referencePanel,direction}})`, `toJSON()`, `fromJSON()`, `clear()`, `getPanel(id)`, `removePanel()`, `onDidLayoutChange`. Theming is CSS-class based (no JS theme object): the CSS at `dockview-react/dist/styles/dockview.css` defines full `.dockview-theme-dark` (etc.) var sets; a custom theme must **layer on a base** — put `className="dockview-theme-dark dockview-theme-rookery"` on an ancestor `<div>` (DockviewReact itself is wrapped, not given the class), and `.dockview-theme-rookery` overrides only accent/bg `--dv-*` vars. Wherever the tasks below import `DockviewReact`/`IDockviewPanelProps` from `"dockview"`, read it as `"dockview-react"`.

## Status (2026-07-01)

- ✅ **Task 1** — dockview deps + `rookery.dockable` flag (committed).
- ✅ **Tasks 3–5** — panel-ids, per-page layout store, default-template (TDD, committed).
- ✅ **Tasks 2/6/7/8/9 (PoC)** — `WorkspaceRender` context, panel adapters, `WorkspaceDock`, worker **and** master pages wired behind the flag; old TabBar/RightSidebar/Terminal gated off when on. typecheck + `electron-vite build` + 594 tests green (committed). The throwaway `Spike.tsx` was skipped — the PoC wires the real panels directly.
- ✅ **Task 11** — layout prune/clear on page death (committed).
- ✅ **Phase 2** — dock-mode header/checkpoint parity (WorkerHeader/SessionHeader kept above the dock, term/right toggles hidden), initial panel sizing, primary-panel (conversation) re-add guard, disposable cleanup, base theming (committed).
- ✅ **Phase 3a — flag default flipped ON** (committed): the dockview workspace is now the default; the legacy layout is retained as a `rookery.dockable="0"` fallback. All code compiles, builds, and 594 tests pass.
- ⏳ **GATE — manual R1 + visual check:** run the app (dockable is now default), drag/split panels, confirm Monaco (unsaved edits) + xterm (scrollback) survive moves and the theme/sizing look right. Escape hatch if anything is off: `localStorage.setItem("rookery.dockable","0")` + reload.
- ⬜ **Phase 3b — code deletion (after visual confirmation):** remove the legacy `TabBar`/`RightSidebar`/right+bottom `ResizeHandle` paths + the `right`/tab persistence in `store/workspace.ts`; drop the `!dockable` fallback branches. **Held until the visual check passes** — deleting the fallback before confirming the replacement renders would be irreversible-in-spirit.
- ⬜ **Phase 4 — floating groups (stretch):** wire `api.addFloatingGroup` to a group header action; needs visual iteration.

## Global Constraints

- ESM NodeNext: relative imports MUST use `.js` extension; type-only uses MUST use `import type` (`verbatimModuleSyntax`).
- Renderer must NOT runtime-import `better-sqlite3` or daemon code (`@daemon/*` is type-only).
- dockview goes in `apps/desktop/package.json` **dependencies** (pure JS/CSS, bundled by the renderer — NOT externalized, same as monaco-editor).
- All new user-facing strings go through i18n (`useT()` / `t("ns.key")`); code comments in English.
- Feature flag OFF by default → the existing layout is unchanged for all users until Phase 3.
- Each phase gates on `npm -w apps/desktop run typecheck` + `npm -w apps/desktop test`. UI/interaction behavior gates on a manual `npm run dev` checkpoint (jsdom cannot exercise dockview drag/dock).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**New (renderer):**
- `src/renderer/lib/flags.ts` — feature flag read (`isDockableEnabled()`).
- `src/renderer/store/layout.ts` — per-`pageKey` serialized dockview layout (zustand persist) + prune.
- `src/renderer/workspace/panel-ids.ts` — pure id<->identity mapping (`Tab` ↔ dockview panel id/params).
- `src/renderer/workspace/default-template.ts` — builds the initial `SerializedDockview` for a page.
- `src/renderer/workspace/WorkspaceActions.tsx` — `WorkspaceActionsContext` (stable callbacks) + provider + hook.
- `src/renderer/workspace/panels/ConversationPanel.tsx` — dockview adapter → `ConversationPane`.
- `src/renderer/workspace/panels/EditorPanel.tsx` — dockview adapter → `WorkspaceTab` content (Monaco/diff/commit/image).
- `src/renderer/workspace/panels/TerminalDockPanel.tsx` — dockview adapter → `TerminalPanel`.
- `src/renderer/workspace/panels/FilesPanel.tsx` / `GitPanel.tsx` / `NestedPanel.tsx` — adapters → `FileTree` / `GitChanges` / `NestedAgents`.
- `src/renderer/workspace/WorkspaceDock.tsx` — owns `DockviewReact`, registers components, seeds template, syncs tabs, persists layout.
- `src/renderer/workspace/dockview-theme.css` — maps dockview CSS vars → rookery `@theme` tokens.

**Modified:**
- `apps/desktop/package.json` — add `dockview` dep.
- `src/renderer/App.tsx` — render `<WorkspaceDock>` behind the flag instead of the static workspace JSX; keep left rail + overlays.
- `src/renderer/store/workspace.ts` — keep `expandedByPage`; editor-tab persistence yields to the layout store when flag on.

**Tests (mirror under `apps/desktop/test/`):**
- `test/renderer/flags.test.ts`, `test/renderer/store/layout.test.ts`, `test/renderer/workspace/panel-ids.test.ts`, `test/renderer/workspace/default-template.test.ts`.

---

## Phase 0 — Dependency, flag, spike (validation gate)

### Task 1: Add dockview + feature flag

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src/renderer/lib/flags.ts`
- Test: `apps/desktop/test/renderer/flags.test.ts`

**Interfaces:**
- Produces: `isDockableEnabled(): boolean` — true iff `localStorage["rookery.dockable"] === "1"`.

- [ ] **Step 1: Install dockview**

Run: `npm -w apps/desktop i dockview`
Expected: `dockview` appears in `apps/desktop/package.json` dependencies; `npm -w apps/desktop run typecheck` still passes.

- [ ] **Step 2: Write the failing test**

```ts
// apps/desktop/test/renderer/flags.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { isDockableEnabled } from "../../src/renderer/lib/flags.js";

describe("isDockableEnabled", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to false", () => { expect(isDockableEnabled()).toBe(false); });
  it("true when flag set to 1", () => { localStorage.setItem("rookery.dockable", "1"); expect(isDockableEnabled()).toBe(true); });
  it("false for any other value", () => { localStorage.setItem("rookery.dockable", "yes"); expect(isDockableEnabled()).toBe(false); });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm -w apps/desktop test -- flags`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// apps/desktop/src/renderer/lib/flags.ts
// Feature flag for the dockable-panes workspace. OFF by default; opt in via
// localStorage.setItem("rookery.dockable","1") (dev). Read once per render tree.
export function isDockableEnabled(): boolean {
  try { return localStorage.getItem("rookery.dockable") === "1"; } catch { return false; }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w apps/desktop test -- flags`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/src/renderer/lib/flags.ts apps/desktop/test/renderer/flags.test.ts
git commit -m "feat(desktop): add dockview dep + rookery.dockable feature flag"
```

### Task 2: Spike — 3 real panels in a dockview (instance-preservation gate)

**Goal:** Prove Monaco (unsaved edits) + xterm (scrollback) + conversation survive drag-split and drag-between-groups without remount. This validates R1 before any migration.

**Files:**
- Create: `apps/desktop/src/renderer/workspace/dockview-theme.css`
- Create: `apps/desktop/src/renderer/workspace/Spike.tsx` (throwaway — removed at end of Phase 1)
- Modify: `apps/desktop/src/renderer/App.tsx` (mount `<Spike/>` when `?spike` or flag+query; behind flag only)

- [ ] **Step 1: Theme stub** — create `dockview-theme.css` importing dockview's theme and overriding core vars to rookery tokens:

```css
/* apps/desktop/src/renderer/workspace/dockview-theme.css */
@import "dockview/dist/styles/dockview.css";
.dockview-theme-rookery {
  --dv-background-color: var(--color-ink);
  --dv-group-view-background-color: var(--color-ink);
  --dv-tabs-and-actions-container-background-color: var(--color-surface);
  --dv-activegroup-visiblepanel-tab-background-color: var(--color-raised);
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--color-surface);
  --dv-tab-divider-color: var(--color-line);
  --dv-separator-border: var(--color-line);
  --dv-paneview-active-outline-color: var(--color-accent);
}
```

- [ ] **Step 2: Spike component** — a `DockviewReact` with three panels rendering the REAL `MonacoEditor`, `TerminalView` (via a minimal host), and a plain conversation stand-in, each wrapped so it reads a fixed page/path. Add an on-screen note: "edit Monaco, scroll xterm, then drag to split — content must persist."

```tsx
// apps/desktop/src/renderer/workspace/Spike.tsx  (throwaway validation harness)
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview";
import { MonacoEditor } from "../components/MonacoEditor.js";
import "./dockview-theme.css";

const components = {
  editor: (p: IDockviewPanelProps<{ pageKey: string; path: string }>) => (
    <MonacoEditor pageKey={p.params.pageKey} path={p.params.path} />
  ),
  note: () => (
    <div className="p-4 text-[13px] text-fg-dim">
      Edit the Monaco file (don&apos;t save), then drag this or the editor tab to split.
      The editor buffer must survive the move (no remount).
    </div>
  ),
};

export function Spike({ pageKey, path }: { pageKey: string; path: string }): JSX.Element {
  const onReady = (e: DockviewReadyEvent): void => {
    const ed = e.api.addPanel({ id: "editor", component: "editor", params: { pageKey, path }, title: "editor" });
    e.api.addPanel({ id: "note", component: "note", position: { referencePanel: ed.id, direction: "right" }, title: "note" });
  };
  return <div className="dockview-theme-rookery h-full w-full"><DockviewReact components={components} onReady={onReady} /></div>;
}
```

- [ ] **Step 3: Mount behind flag** — in `App.tsx`, when `isDockableEnabled() && new URLSearchParams(location.search).has("spike")`, render `<Spike pageKey="spike" path={<a real repo file>} />` full-bleed instead of the normal tree. (Temporary; keep it a 3-line guard at the top of the return.)

- [ ] **Step 4: Build gate**

Run: `npm -w apps/desktop run typecheck && npm -w apps/desktop run build`
Expected: both succeed (proves dockview bundles cleanly in the renderer).

- [ ] **Step 5: MANUAL validation checkpoint**

Run `./scripts/dev.sh`, set `localStorage.rookery.dockable="1"`, open with `?spike`. Type in Monaco (no save), drag the editor tab to split right, then drag it into the note group. Confirm the typed text persists across both moves. Repeat mentally for xterm scrollback once the terminal panel exists (Task 9).
Expected: buffer persists → R1 holds. If it remounts, STOP and revisit library (rc-dock) before Phase 1.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/workspace/dockview-theme.css apps/desktop/src/renderer/workspace/Spike.tsx apps/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): dockview spike harness to validate instance preservation (R1)"
```

---

## Phase 1 — PoC foundations (pure, TDD) + worker workspace

### Task 3: Panel id ↔ identity mapping

**Files:**
- Create: `apps/desktop/src/renderer/workspace/panel-ids.ts`
- Test: `apps/desktop/test/renderer/workspace/panel-ids.test.ts`

**Interfaces:**
- Produces:
  - `type PanelParams = { pageKey: string } & ({ kind: "conversation"; agentKind: "master" | "worker" } | { kind: "editor"; tabId: string } | { kind: "terminal" } | { kind: "files" } | { kind: "git" } | { kind: "nested" })`
  - `editorPanelId(tabId: string): string` → `"panel:editor:" + tabId`
  - `fixedPanelId(kind: "conversation" | "terminal" | "files" | "git" | "nested"): string` → `"panel:" + kind`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/renderer/workspace/panel-ids.test.ts
import { describe, it, expect } from "vitest";
import { editorPanelId, fixedPanelId } from "../../../src/renderer/workspace/panel-ids.js";

describe("panel ids", () => {
  it("editor id is derived from the tab id", () => {
    expect(editorPanelId("file:/a/b.ts")).toBe("panel:editor:file:/a/b.ts");
  });
  it("fixed panel ids are stable per kind", () => {
    expect(fixedPanelId("conversation")).toBe("panel:conversation");
    expect(fixedPanelId("terminal")).toBe("panel:terminal");
    expect(fixedPanelId("files")).toBe("panel:files");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm -w apps/desktop test -- panel-ids` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/renderer/workspace/panel-ids.ts
// Pure mapping between dockview panel ids and their serializable identity.
// Callbacks NEVER live here (dockview serializes params) — see WorkspaceActions.
export type PanelParams = { pageKey: string } & (
  | { kind: "conversation"; agentKind: "master" | "worker" }
  | { kind: "editor"; tabId: string }
  | { kind: "terminal" }
  | { kind: "files" }
  | { kind: "git" }
  | { kind: "nested" }
);
export function editorPanelId(tabId: string): string { return `panel:editor:${tabId}`; }
export function fixedPanelId(kind: "conversation" | "terminal" | "files" | "git" | "nested"): string { return `panel:${kind}`; }
```

- [ ] **Step 4: Run to verify pass** — `npm -w apps/desktop test -- panel-ids` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/workspace/panel-ids.ts apps/desktop/test/renderer/workspace/panel-ids.test.ts
git commit -m "feat(desktop): panel id<->identity mapping for dockview"
```

### Task 4: Per-page layout store (persist + prune)

**Files:**
- Create: `apps/desktop/src/renderer/store/layout.ts`
- Test: `apps/desktop/test/renderer/store/layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface LayoutState { byPage: Record<string, unknown> }` (the `unknown` is dockview's `SerializedDockview`).
  - pure `saveLayout(s, key, json)`, `pruneLayouts(s, known: Set<string>)`.
  - `useLayoutStore` (zustand persist `rookery.layout`) with `save_(key, json)`, `clear_(key)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/renderer/store/layout.test.ts
import { describe, it, expect } from "vitest";
import { saveLayout, pruneLayouts, emptyLayoutState } from "../../../src/renderer/store/layout.js";

describe("layout store reducers", () => {
  it("saves a layout json under a page key", () => {
    const s = saveLayout(emptyLayoutState(), "w1", { grid: 1 });
    expect(s.byPage.w1).toEqual({ grid: 1 });
  });
  it("prunes unknown page keys", () => {
    let s = saveLayout(emptyLayoutState(), "w1", { a: 1 });
    s = saveLayout(s, "w2", { b: 2 });
    const pruned = pruneLayouts(s, new Set(["w2"]));
    expect(pruned.byPage.w1).toBeUndefined();
    expect(pruned.byPage.w2).toEqual({ b: 2 });
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm -w apps/desktop test -- layout` → FAIL.

- [ ] **Step 3: Implement** (pure reducers + zustand persist, mirroring `store/terminals.ts` conventions)

```ts
// apps/desktop/src/renderer/store/layout.ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface LayoutState { byPage: Record<string, unknown> }
export function emptyLayoutState(): LayoutState { return { byPage: {} }; }
export function saveLayout(s: LayoutState, key: string, json: unknown): LayoutState {
  return { ...s, byPage: { ...s.byPage, [key]: json } };
}
export function clearLayout(s: LayoutState, key: string): LayoutState {
  const byPage = { ...s.byPage }; delete byPage[key]; return { ...s, byPage };
}
export function pruneLayouts(s: LayoutState, known: Set<string>): LayoutState {
  const byPage: LayoutState["byPage"] = {};
  for (const [k, v] of Object.entries(s.byPage)) if (known.has(k)) byPage[k] = v;
  return { ...s, byPage };
}
interface LayoutStore extends LayoutState { save_: (key: string, json: unknown) => void; clear_: (key: string) => void }
export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({ ...emptyLayoutState(),
      save_: (key, json) => set((s) => saveLayout(s, key, json)),
      clear_: (key) => set((s) => clearLayout(s, key)),
    }),
    { name: "rookery.layout", version: 1, storage: createJSONStorage(() => localStorage),
      migrate: (p) => ({ byPage: (p as Partial<LayoutState> | undefined)?.byPage ?? {} }),
      partialize: (s) => ({ byPage: s.byPage }) },
  ),
);
```

- [ ] **Step 4: Run to verify pass** — `npm -w apps/desktop test -- layout` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/store/layout.ts apps/desktop/test/renderer/store/layout.test.ts
git commit -m "feat(desktop): per-page dockview layout store (persist+prune)"
```

### Task 5: Default layout template

**Files:**
- Create: `apps/desktop/src/renderer/workspace/default-template.ts`
- Test: `apps/desktop/test/renderer/workspace/default-template.test.ts`

**Interfaces:**
- Consumes: `PanelParams`, `fixedPanelId` (Task 3).
- Produces: `buildDefaultLayout(pageKey: string, agentKind: "master" | "worker"): SerializedDockview` — a dockview layout with a conversation panel (left), an empty editor group placeholder (center), terminal (bottom), files+git stacked (right). Rather than hand-author dockview grid JSON, this returns a small **descriptor** consumed imperatively by `WorkspaceDock` (see Task 8): `{ conversation, files, git, terminal }` booleans + order. Keep it a plain object so it is unit-testable.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/renderer/workspace/default-template.test.ts
import { describe, it, expect } from "vitest";
import { defaultPanels } from "../../../src/renderer/workspace/default-template.js";

describe("default template", () => {
  it("includes the core panels for a worker page", () => {
    const p = defaultPanels("worker");
    expect(p.map((x) => x.kind)).toEqual(["conversation", "files", "git", "terminal"]);
  });
  it("worker gets a nested panel, master does not", () => {
    expect(defaultPanels("worker").some((x) => x.kind === "nested")).toBe(false); // nested added on demand
    expect(defaultPanels("master").some((x) => x.kind === "conversation")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/renderer/workspace/default-template.ts
// Declarative seed for a fresh page's dockview layout. WorkspaceDock consumes this
// imperatively (addPanel with positions) rather than hand-authoring grid JSON.
export interface SeedPanel { kind: "conversation" | "files" | "git" | "terminal"; position: "center" | "right" | "bottom" }
export function defaultPanels(_agentKind: "master" | "worker"): SeedPanel[] {
  return [
    { kind: "conversation", position: "center" },
    { kind: "files", position: "right" },
    { kind: "git", position: "right" },
    { kind: "terminal", position: "bottom" },
  ];
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/workspace/default-template.ts apps/desktop/test/renderer/workspace/default-template.test.ts
git commit -m "feat(desktop): default dockview layout seed descriptor"
```

### Task 6: WorkspaceActions context (stable callbacks)

**Files:**
- Create: `apps/desktop/src/renderer/workspace/WorkspaceActions.tsx`

**Interfaces:**
- Produces:
  - `interface WorkspaceActions { onSend(pageKey: string, text: string): void; onStop(pageKey: string): void; onOpenFile(pageKey: string, path: string): void; onSelectWorker(id: string): void; onRespond(requestId: string, res: unknown): void; ... }` (the exact callbacks App already computes).
  - `WorkspaceActionsProvider` and `useWorkspaceActions(): WorkspaceActions`.
- Rationale: dockview serializes panel `params`, so panels take only serializable identity in params and pull live callbacks from this context (stable across layout moves).

- [ ] **Step 1: Implement the context + provider + hook.** (No unit test — it's plumbing; covered by the panel wiring + manual checkpoint.)

```tsx
// apps/desktop/src/renderer/workspace/WorkspaceActions.tsx
import { createContext, useContext, type ReactNode } from "react";
export interface WorkspaceActions {
  onSend: (pageKey: string, text: string) => void;
  onStop: (pageKey: string) => void;
  onOpenFile: (pageKey: string, path: string) => void;
  onSelectWorker: (id: string) => void;
  onRespond: (requestId: string, res: { decision?: "allow" | "deny"; answers?: Record<string, string | string[]> }) => void;
}
const Ctx = createContext<WorkspaceActions | null>(null);
export function WorkspaceActionsProvider({ value, children }: { value: WorkspaceActions; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useWorkspaceActions(): WorkspaceActions {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspaceActions outside provider");
  return v;
}
```

- [ ] **Step 2: Typecheck** — `npm -w apps/desktop run typecheck` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(desktop): WorkspaceActions context for dock panel callbacks"`.

### Task 7: Panel adapter components

**Files:**
- Create: `apps/desktop/src/renderer/workspace/panels/ConversationPanel.tsx`, `EditorPanel.tsx`, `TerminalDockPanel.tsx`, `FilesPanel.tsx`, `GitPanel.tsx`, `NestedPanel.tsx`

**Interfaces:**
- Consumes: `IDockviewPanelProps<PanelParams>` (dockview), `useWorkspaceActions` (Task 6), existing components (`ConversationPane`, `WorkspaceTab`, `TerminalPanel`, `FileTree`, `GitChanges`, `NestedAgents`).
- Produces: a `components` map `{ conversation, editor, terminal, files, git, nested }` for `DockviewReact` (exported from `WorkspaceDock`, Task 8).

- [ ] **Step 1: Implement each adapter.** Each reads identity from `props.params`, actions from context, subscribes to its own store slice (unchanged from today), and renders the existing component. Example (conversation):

```tsx
// apps/desktop/src/renderer/workspace/panels/ConversationPanel.tsx
import type { IDockviewPanelProps } from "dockview";
import type { PanelParams } from "../panel-ids.js";
import { ConversationPane } from "../../components/ConversationPane.js";
import { useWorkspaceActions } from "../WorkspaceActions.js";

export function ConversationPanel({ params }: IDockviewPanelProps<PanelParams & { kind: "conversation" }>): JSX.Element {
  const a = useWorkspaceActions();
  return (
    <ConversationPane
      kind={params.agentKind}
      id={params.pageKey}
      onSend={(t) => a.onSend(params.pageKey, t)}
      onStop={() => a.onStop(params.pageKey)}
      onOpenFile={(p) => a.onOpenFile(params.pageKey, p)}
      {...(params.agentKind === "master" ? { onSelectWorker: a.onSelectWorker, onRespond: a.onRespond } : {})}
    />
  );
}
```

(EditorPanel renders `<WorkspaceTab activeTab={tabFromId} pageKey root/>`; TerminalDockPanel renders `<TerminalPanel sessionId subId cwd/>`; Files/Git/Nested render their components with `pageKey`/`subId`/`cwd`/`root` pulled from a small `usePageContext(pageKey)` selector.) Fill each with the real prop set the current `App.tsx` passes (lines 863–975) — copy those prop expressions verbatim, replacing App closures with context calls.

- [ ] **Step 2: Typecheck** → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(desktop): dockview panel adapters for conversation/editor/terminal/files/git/nested"`.

### Task 8: WorkspaceDock (owns dockview, seeds, persists)

**Files:**
- Create: `apps/desktop/src/renderer/workspace/WorkspaceDock.tsx`

**Interfaces:**
- Consumes: `useLayoutStore` (Task 4), `defaultPanels` (Task 5), panel components (Task 7), `fixedPanelId`/`editorPanelId` (Task 3).
- Produces: `WorkspaceDock({ pageKey, agentKind, subId, cwd, root })` — a self-contained workspace for one page.

- [ ] **Step 1: Implement.** On `onReady`: if a saved layout exists for `pageKey` (`useLayoutStore.getState().byPage[pageKey]`), `api.fromJSON(saved)`; else seed via `defaultPanels(agentKind)` (addPanel with `position`). Subscribe `api.onDidLayoutChange` → debounce → `useLayoutStore.getState().save_(pageKey, api.toJSON())`. Sync open editor tabs: watch `useWsStore` `byPage[pageKey].tabs` and add/remove editor panels to match (add on new file tab, remove on close). Register components map from Task 7. Wrap in `.dockview-theme-rookery`.

- [ ] **Step 2: Build gate** — `npm -w apps/desktop run typecheck && npm -w apps/desktop run build` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(desktop): WorkspaceDock — dockview host with per-page seed+persist"`.

### Task 9: Wire the worker page behind the flag

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx`

- [ ] **Step 1:** In the worker branch of the render (App.tsx:863–917), when `isDockableEnabled()`, render `<WorkspaceActionsProvider value={actions}><WorkspaceDock pageKey={activeSub.id} agentKind="worker" subId={activeSub.id} cwd={undefined} root={wsRoot} /></WorkspaceActionsProvider>` instead of the header+TabBar+ConversationPane tree. Build `actions` with `useMemo` from the existing closures (`subSend`, `subInterrupt`, `openFileInPage`, `selectSub`, `respondInteraction`). Keep the non-flag path exactly as-is.

- [ ] **Step 2: Build + MANUAL checkpoint** — `npm -w apps/desktop run build`; then `./scripts/dev.sh`, flag on, open a worker: verify conversation/files/git/terminal panels render, dragging/splitting works, editor opens on file click, layout persists across reload, and a page switch rebinds content. Confirm xterm scrollback + Monaco edits survive a drag (R1 in the real workspace).
- [ ] **Step 3:** Remove the throwaway `Spike.tsx` + its App guard (superseded).
- [ ] **Step 4: Commit** — `git commit -m "feat(desktop): worker workspace via dockview behind rookery.dockable flag; drop spike"`.

---

## Phase 2 — Generalize + persist (session pages, theming, prune)

- **Task 10:** Wire the session (master) page behind the flag (App.tsx:926–962), `agentKind="master"`, cwd = session cwd. Manual checkpoint.
- **Task 11:** Hook `pruneLayouts` into the existing restore effect (App.tsx:298–321) alongside `pruneWsPages`/`pruneLayout`; clear a page's layout on `deleteSub`/`deleteSession`. Test: extend `layout.test.ts` for prune-on-known-keys already covered; add an integration assertion that delete clears the entry.
- **Task 12:** Polish `dockview-theme.css` to match the design tokens (tabs, sashes, active outline, close buttons); i18n any visible strings (empty-group hint). Manual visual checkpoint.
- **Task 13:** Page-switch content rebinding + default-template refinements (empty editor group hidden until first file; terminal panel starts collapsed to match today). Manual checkpoint.

## Phase 3 — Migrate (remove old layout, drop flag)

- **Task 14:** Make dockable the default (flag defaults ON / removed); delete the static workspace JSX in App.tsx (the header+TabBar+ConversationPane+TerminalPanel+RightSidebar branches), keeping left rail + overlays.
- **Task 15:** Remove now-dead code: `components/TabBar.tsx`, `components/WorkspaceTab.tsx` wrapper if subsumed, `components/RightSidebar.tsx`, right/bottom usage of `ResizeHandle`/`useResizableWidth`/`useResizableHeight`, and the `right`/tab persistence in `store/workspace.ts` (keep `expandedByPage`). Update `apps/desktop/CLAUDE.md` Workspace section.
- **Task 16:** Full `npm -w apps/desktop run typecheck && npm -w apps/desktop test && npm -w apps/desktop run build`; update i18n catalogs; remove `rookery.ws` tab fields via a persist `migrate` bump.

## Phase 4 — Stretch (floating groups)

- **Task 17:** Enable dockview floating groups (`api.addFloatingGroup`), add a "float" affordance to group actions, ensure floats persist in `toJSON`. Manual checkpoint. OS popout remains out of scope.

---

## Self-Review

**Spec coverage:** drag/split/dock/resize → dockview (Tasks 2,8,9); show/hide panels → add/remove in WorkspaceDock (Task 8) + Phase 3 toggles; persist/restore per page → layout store (Task 4) + WorkspaceDock (Task 8); left rail fixed + overlays full-replace → App wiring keeps them (Tasks 9,10); Monaco/xterm preservation (R1) → Task 2 gate + Task 9 real check; popout excluded → not planned; theming (R3) → Tasks 2,12; byPage.tabs migration (R2) → Tasks 8,15,16. All spec sections map to tasks.

**Placeholder scan:** Phase 0–1 tasks carry real code + commands. Phase 2–4 are intentionally coarser because they are gated behind the Phase 0 R1 validation and the Phase 1 PoC — re-planned in detail after the PoC manual checkpoint (noted so the executor doesn't treat them as final).

**Type consistency:** `PanelParams`/`fixedPanelId`/`editorPanelId` (Task 3) are consumed unchanged in Tasks 7–8; `useLayoutStore.save_/clear_` (Task 4) used in Task 8/11; `WorkspaceActions` shape (Task 6) consumed in Task 7; `defaultPanels`/`SeedPanel` (Task 5) consumed in Task 8.
