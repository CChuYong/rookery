import type { FixedKind } from "./panel-ids.js";

// Declarative seed for a fresh page's dockview layout. WorkspaceDock consumes
// this imperatively (addPanel referencing the anchor panel) rather than hand-
// authoring dockview grid JSON, which keeps the seed unit-testable.
export interface SeedPanel {
  kind: FixedKind;
  // referencePanel kind; undefined = the root panel (added first, no position).
  anchor?: FixedKind;
  // relative placement against the anchor. "within" stacks as a tab in the anchor's group.
  direction?: "right" | "below" | "within";
}

export function defaultPanels(agentKind: "master" | "worker"): SeedPanel[] {
  // conversation (root/center) · files right of it · git stacked with files ·
  // terminal below conversation · (worker only) nested stacked with files/git.
  const seeds: SeedPanel[] = [
    { kind: "conversation" },
    { kind: "files", anchor: "conversation", direction: "right" },
    { kind: "git", anchor: "files", direction: "within" },
    { kind: "terminal", anchor: "conversation", direction: "below" },
  ];
  if (agentKind === "worker") seeds.push({ kind: "nested", anchor: "files", direction: "within" });
  return seeds;
}

// Terminal group heights (px). Collapsed = tab-strip only (dockview's own tab
// strip is 34px, see dockview-theme.css) — a page with no open terminals
// shouldn't permanently occupy ~220px of vertical space (audit #30).
export const TERMINAL_COLLAPSED_HEIGHT = 40;
export const TERMINAL_EXPANDED_HEIGHT = 220;

// Seed height for a page's terminal group: collapsed when it has no open
// terminals yet, full height otherwise (e.g. a page whose terminals were
// already open in a previous run — the group should come back expanded, not
// collapsed-then-jarringly-grown).
export function terminalSeedHeight(openTerminalCount: number): number {
  return openTerminalCount > 0 ? TERMINAL_EXPANDED_HEIGHT : TERMINAL_COLLAPSED_HEIGHT;
}

// Whether a live group height still looks like the collapsed seed rather than
// a size the user chose deliberately. Used to decide if opening the page's
// first terminal should auto-grow the group — with a small tolerance above
// the exact collapsed height for layout rounding, but never mistaking a
// noticeably bigger group (a user's own resize) for "still collapsed".
export function isTerminalGroupCollapsed(currentHeight: number): boolean {
  return currentHeight <= TERMINAL_COLLAPSED_HEIGHT + 8;
}
