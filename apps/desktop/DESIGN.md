# Rookery desktop — design system (IDE chrome)

Locked 2026-11-14. The renderer should feel like a professional IDE / agent workbench (T3 Code, Orca, VS Code, Zed):
convention over character, density over air, neutral over warm. When in doubt, do what VS Code / Zed / T3 Code do.

Toy tells to keep out: filled pill segments for navigation, the accent used as a fill, 14px+ chrome text and roomy
padding, tinted greys, hero headings inside the tool, dashboard furniture in the sidebar (it lives in the status bar),
always-open empty panels, bordered chips on every tag.

Shell: a 40px title row (breadcrumb `repo / title`), a tree sidebar with two-line rows, quiet tabs that hide when a
conversation stands alone, a floating inspector card (Files / Git / Activity), the terminal closed by default
(Ctrl+` toggles it), and a 24px status bar for daemon/slack state, usage, resources and the settings entry points.

Tokens live in `src/renderer/globals.css` `@theme`. **Token names are the project's own:** `ink` is the canvas,
`sunk` the sidebar/tab strip/status bar, `surface` the composer/popovers, `raised` hover/selection, `line`/`line-soft`
hairlines, `fg`/`fg-dim`/`muted`/`faint` text. All greys are chroma 0. Never add a literal colour or `font-family`.

Type scale — five utilities, no arbitrary `text-[Npx]` in components: `text-meta` 11 (status bar, timestamps,
counts, hints, badges) · `text-ui` 12 (tabs, controls, descriptions, inspector/tool rows) · `text-body` 13 (nav, list
titles, breadcrumb, inputs, menus, setting labels) · `text-prose` 14 (messages, composer) · `text-title` 14 medium
(dialog/page/section titles). `lib/cn.ts` registers these with tailwind-merge — without it `cn("text-meta text-muted")`
silently drops the size. Bars: every header 40px (`h-10`), every dock tab strip 32px, status bar 24px; chrome icon
buttons 24px with 14px icons (12px in the status bar).

Quick rules: system UI font; rows 24–28px; radii 4px (rows/controls), 5–6px (popovers/composer), 8px (dialogs); lucide icons 14px,
strokeWidth 1.5; the orange accent only as 1–2px lines, focus rings, the current-item marker and links — never a fill
(no orange buttons except a destructive/primary dialog confirm, no orange-tinted toggles); selection is a neutral
`bg-raised`; mono only for measurements and code; no `uppercase`/`tracking-*` labels; no `·`-joined meta strings
(unless a test pins the literal); motion = 80–120ms colour/opacity only.

State colours: `run` (sky blue) means live/running only — a dot or a small word; `warn` (amber) is every caution
(warning notes, notices, trust/bypass cautions, near-limit thresholds ≥80%); `fail` red; `pr` green; unread is a
neutral `fg-dim` dot, never the running blue.

Shared patterns (use them, don't restyle per call site):
- `lib/ui-tokens.ts` — `ROW_SELECTED`/`ROW_IDLE`/`rowState()` (neutral selection, hover at half strength),
  `ROW_CURRENT_MARK` (2px accent rule for the open item when it differs from the selection), `SIDEBAR_ROW`,
  `TAB_ACTIVE`/`TAB_IDLE`/`TAB_LINE` (tab strips: full-strength text + one 1px `fg-dim` line, no fill or wash; the dock
  tabs use the same line via `--tab-line`), `MENU_SURFACE`/`MENU_ITEM`/`MENU_ITEM_ACTIVE` (menus and popovers).
  In-form choices use `Segment` `pill`; tab strips use `Segment` `underline` or the tokens above.
- `ui/dialog.tsx` — `dialogPanelClass({ size: "sm" | "md" })` (360 / 480px, 8px radius, `p-5`, `shadow-pop`) and
  `dialogOverlayClass()`; every modal panel uses them.
- `components/ComposerChrome.tsx` — the three prompt surfaces (conversation, New session, New worker) share
  `COMPOSER_BOX` (6px radius), `ComposerFooter` (context left, actions pinned right — send never wraps alone),
  `SendButton` (26px neutral circle, arrow-up, tooltip names the action or why it is disabled) and `ChromeMenu` +
  `MenuField` (the model menu: backend, model, effort, permission mode, speed; the trigger reads `Opus 4.8 · High`
  plus only non-default choices). Enter submits on all three; Shift+Enter is a newline.
- `lib/focus.ts` — keyboard/focus contract for every overlay and list: `useFocusReturn` (focus back to the trigger,
  captured at first render), `useReturnFocusOnClose` (toggled popovers), `useRovingTabIndex` (a list is one tab stop,
  Arrow/Home/End move, `aria-current` marks the open row), `useScrollActiveIntoView` (popup highlight stays visible),
  `isImeComposing` (every Enter that commits text checks it), `usePageEscape` (full pages close on Esc when nothing
  else owns it). `useFocusTrap` builds on it. `lib/shortcuts.ts` holds the row keys (F2, Delete/⌘⌫, Shift+F10) and
  the app keys (⌘B, ⌘N, ⌘,) with their labels — show a shortcut next to its control (`withShortcut` title,
  `aria-keyshortcuts`, or a menu item's `shortcut`), and never fire one inside a text field, Monaco or xterm.
- A failed send is reported once, inline in the composer next to the kept draft; App send paths don't toast it too.
- Confirm rule — anything irreversible (delete, revert, discard, secret removal, token rotation) goes through
  `ui/confirm-dialog.tsx` (`secondary` adds a middle action); a light, undoable action runs at once and offers Undo in
  `toast.info(text, { label, onClick })`. No same-button double-click confirms.

## Rules for editing components

Change markup and classes only. Keep every handler, prop, `key`, `id`, `data-testid`, `aria-*`, role, i18n key and
test-visible class (tests pin a few: `rise-in`, `dot-settle`, `transition`, `text-fail`, `fixed`, `w-full`,
`opacity-0`/`group-hover:opacity-100`, button `disabled:*`). Never edit a test to make a change pass.
