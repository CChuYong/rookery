// One look per interaction pattern, shared by every call site (audit #99 #101 #109 #111). Change a pattern here,
// not at the call site. The rules follow the IDE skill: selection is a neutral lift, the accent is only a line or a
// focus ring, menus are the one lifted surface with a shadow.

// ── Selection (lists, trees, popups) ────────────────────────────────────────────────────────────────────────────
/** The selected / current row: a neutral lift with full-strength text — never an accent tint. */
export const ROW_SELECTED = "bg-raised text-fg";
/** A row at rest: dim text, a half-strength lift on hover so hover never looks like selection. */
export const ROW_IDLE = "text-fg-dim hover:bg-raised/60 hover:text-fg";
/** Extra marker for "the item that is open" when it differs from the selected row (FileTree's open file): a 2px
 *  accent rule on the left — the only place a row carries the accent. */
export const ROW_CURRENT_MARK = "shadow-[inset_2px_0_0_var(--color-accent)]";
export const rowState = (selected: boolean): string => (selected ? ROW_SELECTED : ROW_IDLE);

/** Sidebar list row geometry shared by Sessions and the RepoTree worker rows. */
export const SIDEBAR_ROW = "relative flex w-full rounded-md py-1.5 pl-2.5 pr-2.5 text-left transition-colors";

// ── Tab strips ──────────────────────────────────────────────────────────────────────────────────────────────────
// A tab strip marks the active tab with full-strength text and one 1px neutral line (the dock tabs' --tab-line in
// dockview-theme.css, the Segment `underline` indicator). No fill, no accent wash. In-form choices use Segment `pill`.
/** Active hand-rolled tab: needs `relative` on the element (the line is an ::after). */
export const TAB_ACTIVE = "text-fg after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-fg-dim";
export const TAB_IDLE = "text-muted hover:text-fg-dim";
/** The line itself, for strips that draw one indicator element (Segment, TabBar). */
export const TAB_LINE = "h-px bg-fg-dim";

// ── Menus and popovers ──────────────────────────────────────────────────────────────────────────────────────────
/** Menu / popover panel: the lifted surface, one hairline, 6px radius, 4px inset, the popover shadow. */
export const MENU_SURFACE = "rounded-lg border border-line bg-surface p-1 shadow-pop";
/** A menu row at rest and its keyboard-active state (same lift as a selected list row). */
export const MENU_ITEM = "rounded-md hover:bg-raised";
export const MENU_ITEM_ACTIVE = "bg-raised text-fg";
