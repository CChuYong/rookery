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
