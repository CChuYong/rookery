import type { FixedKind } from "./panel-ids.js";

// Declarative seed for a fresh page's dockview layout. WorkspaceDock consumes
// this imperatively (addPanel referencing the anchor panel) rather than hand-
// authoring dockview grid JSON, which keeps the seed unit-testable.
export interface SeedPanel {
  kind: FixedKind;
  // referencePanel kind. Undefined with no direction = the root panel (added first, no position); undefined WITH a
  // direction = an edge of the whole dock (dockview's absolute position).
  anchor?: FixedKind;
  // placement against the anchor (or the dock edge). "within" stacks as a tab in the anchor's group.
  direction?: "right" | "below" | "within";
}

export function defaultPanels(agentKind: "master" | "worker"): SeedPanel[] {
  // conversation (root/center) · files as a full-height column on the dock's right edge · git stacked with files ·
  // terminal below the conversation only · (worker only) nested stacked with files/git. The side column is anchored
  // to the dock edge, not to the conversation: next to a conversation that already has a terminal below it,
  // "right of the conversation" splits the conversation's column in half (audit #5 #6).
  const seeds: SeedPanel[] = [
    { kind: "conversation" },
    { kind: "files", direction: "right" },
    { kind: "git", anchor: "files", direction: "within" },
    { kind: "terminal", anchor: "conversation", direction: "below" },
  ];
  if (agentKind === "worker") seeds.push({ kind: "nested", anchor: "files", direction: "within" });
  return seeds;
}

// Terminal group heights (px). Collapsed = the dockview group header (32px, see
// dockview-theme.css) + TerminalPanel's single 30px "New terminal" row — a page
// with no open terminals shouldn't permanently occupy ~220px (audit #30).
export const TERMINAL_COLLAPSED_HEIGHT = 62;
export const TERMINAL_EXPANDED_HEIGHT = 240;

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
