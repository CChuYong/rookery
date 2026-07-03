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

// tab id ("agent" | "file:..." | "diff:..." | "commit:...") → the dock panel id that renders it.
export function panelIdForTab(tabId: string): string {
  return tabId === "agent" ? fixedPanelId("conversation") : editorPanelId(tabId);
}

// dock panel id → the workspace tab id it represents, or null for fixed panels that aren't tabs (files/git/terminal/nested).
export function tabIdForPanel(panelId: string): string | null {
  if (panelId === fixedPanelId("conversation")) return "agent";
  const p = "panel:editor:";
  return panelId.startsWith(p) ? panelId.slice(p.length) : null;
}
