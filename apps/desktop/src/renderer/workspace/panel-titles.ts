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
    case "terminal": return t("workspaceHeaders.terminalTitle");
    case "nested": return t("rightSidebar.segmentWorker");
  }
}
