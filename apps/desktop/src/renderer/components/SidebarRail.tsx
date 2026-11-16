import { PanelLeft, ChevronLeft, ChevronRight, MessageSquare, FolderGit2, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { Tooltip } from "./Tooltip.js";
import { APP_SHORTCUT, withShortcut } from "../lib/shortcuts.js";

// Collapsed sidebar = a navigation rail (audit #19), the VS Code activity-bar idea: expand, history, the two views
// and the new-item entry for the current view. Everything else (resources, bell, restart, capabilities, automation,
// settings) lives in the always-visible status bar, so the rail doesn't repeat it.
export function SidebarRail(p: {
  onExpand: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canFwd: boolean;
  view: "sessions" | "repos" | null; // null while a full page (settings, automation…) is open
  sessionsUnread: boolean;
  reposUnread: boolean;
  onSessions: () => void;
  onRepos: () => void;
  onNew: () => void;
  newLabel: string;
  newActive: boolean;
}): JSX.Element {
  const t = useT();
  const plain = "no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted enabled:hover:bg-raised enabled:hover:text-fg-dim disabled:opacity-25";
  const navBtn = (label: string, Icon: LucideIcon, active: boolean, unread: boolean, onClick: () => void): JSX.Element => (
    <Tooltip label={label} side="right">
      <button
        onClick={onClick}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn("no-drag relative flex h-7 w-7 items-center justify-center rounded-md transition-colors", active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg-dim")}
      >
        <Icon size={14} />
        {unread && <span data-unread className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-fg-dim" />}
      </button>
    </Tooltip>
  );
  return (
    <>
      <button onClick={p.onExpand} aria-label={t("app.expandSidebar")} aria-keyshortcuts={APP_SHORTCUT.toggleSidebar.aria()} title={withShortcut(t("app.expandSidebar"), APP_SHORTCUT.toggleSidebar.label())} className={plain}>
        <PanelLeft size={14} />
      </button>
      <button onClick={p.onBack} disabled={!p.canBack} aria-label={t("app.back")} title={t("app.back")} className={plain}>
        <ChevronLeft size={14} />
      </button>
      <button onClick={p.onForward} disabled={!p.canFwd} aria-label={t("app.forward")} title={t("app.forward")} className={plain}>
        <ChevronRight size={14} />
      </button>
      <span className="my-1 h-px w-6 bg-line" aria-hidden />
      {navBtn(t("app.navSessions"), MessageSquare, p.view === "sessions", p.sessionsUnread, p.onSessions)}
      {navBtn(t("app.navRepos"), FolderGit2, p.view === "repos", p.reposUnread, p.onRepos)}
      {navBtn(p.newLabel, Plus, p.newActive, false, p.onNew)}
    </>
  );
}
