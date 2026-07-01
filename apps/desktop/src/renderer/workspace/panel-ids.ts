// Pure mapping between dockview panel ids and their serializable identity.
// Callbacks NEVER live in panel params (dockview serializes params into the
// saved layout) — panels pull live callbacks from WorkspaceActions instead.

export type FixedKind = "conversation" | "terminal" | "files" | "git" | "nested";

export type PanelParams = { pageKey: string } & (
  | { kind: "conversation"; agentKind: "master" | "worker" }
  | { kind: "editor"; tabId: string }
  | { kind: "terminal" }
  | { kind: "files" }
  | { kind: "git" }
  | { kind: "nested" }
);

// One editor panel per workspace tab id (e.g. "file:/a/b.ts", "diff:/x", "commit:<hash>").
export function editorPanelId(tabId: string): string {
  return `panel:editor:${tabId}`;
}

// Singleton panels per page — a stable id per kind so seed/restore never duplicates them.
export function fixedPanelId(kind: FixedKind): string {
  return `panel:${kind}`;
}
