// Pure mapping between dockview panel ids and their serializable identity.
// Callbacks NEVER live in panel params (dockview serializes params into the
// saved layout) — panels pull live callbacks from WorkspaceActions instead.

import { DIFF_TITLE_SUFFIX } from "../store/workspace.js";

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

// A layout restored via dockview's fromJSON may carry a conversation panel
// whose serialized params lack (or disagree with) `agentKind` — persisted
// before this field existed, or by pre-task code (task 18 review: a worker
// page's layout saved before audit #29 restores with the "Master" tab label,
// because RookeryTab's live label falls back to fixedPanelTitle's default
// when agentKind is missing). The page's own known agentKind (a WorkspaceDock
// prop) is always the source of truth for its conversation panel, so
// WorkspaceDock re-asserts it onto the restored panel via the dockview API
// (`panel.api.updateParameters`) right after restore. This is the pure half
// of that reassert: the params patch to apply, or `undefined` when the
// restored params already match (so the caller can skip a no-op update).
export function conversationAgentKindPatch(
  restoredParams: { agentKind?: "master" | "worker" } | undefined,
  knownAgentKind: "master" | "worker",
): { agentKind: "master" | "worker" } | undefined {
  return restoredParams?.agentKind === knownAgentKind ? undefined : { agentKind: knownAgentKind };
}

// Full-path + kind tooltip for an editor tab's label span. The visible label is
// truncated (long paths) and a diff tab shares its basename with the matching
// file tab, so hovering must disambiguate which is which (audit #28). `tabId`
// already carries the full, untruncated path (`file:<path>` / `diff:<path>`),
// so no store lookup is needed. Commit tabs have no path — undefined (no tooltip).
export function editorTooltip(tabId: string): string | undefined {
  if (tabId.startsWith("file:")) return tabId.slice("file:".length);
  if (tabId.startsWith("diff:")) return `${tabId.slice("diff:".length)}${DIFF_TITLE_SUFFIX}`;
  return undefined;
}
