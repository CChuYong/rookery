import type { TFunc } from "../i18n/provider.js";
import type { FixedKind } from "./panel-ids.js";

// Live-localized label for a fixed dock panel. Shared by WorkspaceDock (which
// calls it once, at addPanel time, to seed api.title / the persisted layout
// JSON) and RookeryTab (which re-derives it on every render from the CURRENT
// locale instead of trusting the persisted title) — so a runtime language
// switch, or a layout restored from a session saved under a different locale,
// never leaves stale-language dock chrome behind (audit #29).
// `agentKind` only matters for "conversation" (master vs worker); other kinds
// ignore it.
export function fixedPanelTitle(kind: FixedKind, t: TFunc, agentKind: "master" | "worker" = "master"): string {
  switch (kind) {
    case "conversation": return agentKind === "worker" ? t("app.worker") : t("app.master");
    case "files": return t("rightSidebar.segmentFiles");
    case "git": return "Git"; // not localized — a proper noun, same treatment as RightSidebar's segment label
    // A dedicated short key, NOT workspaceHeaders.terminalTitle ("Terminal (bottom
    // panel)") — that verbose copy was written for the fixed pre-dock header toggle
    // tooltip, and a dockview tab can be dragged anywhere, so "(bottom panel)" lies
    // about its position and stands out next to one-word siblings like "Files"/"Git"
    // (audit #49a). terminalTitle is kept as-is for the header toggle tooltip.
    case "terminal": return t("workspaceHeaders.terminalTab");
    case "nested": return t("rightSidebar.segmentWorker");
  }
}
