// Declarative seed for a fresh page's dockview layout. WorkspaceDock consumes
// this imperatively (addPanel with a relative position) rather than hand-
// authoring dockview grid JSON, which keeps the seed unit-testable.

export interface SeedPanel {
  kind: "conversation" | "files" | "git" | "terminal";
  // Position relative to the previously added panel (the conversation anchors the center).
  position: "center" | "right" | "bottom";
}

export function defaultPanels(_agentKind: "master" | "worker"): SeedPanel[] {
  // conversation center · files+git stacked right · terminal bottom.
  // nested is added on demand (worker spawns a Task subagent), not seeded.
  return [
    { kind: "conversation", position: "center" },
    { kind: "files", position: "right" },
    { kind: "git", position: "right" },
    { kind: "terminal", position: "bottom" },
  ];
}
