import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { IDockviewPanelHeaderProps } from "dockview";
import { MessageSquare, FileText, GitCompare, GitCommitHorizontal, SquareTerminal, Files, GitBranch, Bot, X, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { editorTooltip, type PanelParams } from "./panel-ids.js";
import { fixedPanelTitle } from "./panel-titles.js";
import { useWsStore, type Tab } from "../store/workspace.js";
import { TabCloseConfirm } from "../components/TabCloseConfirm.js";
import { ContextMenu, type MenuItem } from "../components/ContextMenu.js";

const EMPTY_TABS: Tab[] = [];

// Custom dockview tab matching the app's TabBar aesthetic (per-kind icon, coral
// for the conversation, hover-reveal close on editor tabs only). Active/inactive
// background + the coral underline are painted in dockview-theme.css via the
// .dv-active-tab / .dv-inactive-tab hooks.
function iconFor(params: PanelParams): LucideIcon {
  switch (params.kind) {
    case "conversation": return MessageSquare;
    case "terminal": return SquareTerminal;
    case "files": return Files;
    case "git": return GitBranch;
    case "nested": return Bot;
    case "editor":
      return params.tabId.startsWith("diff:") ? GitCompare : params.tabId.startsWith("commit:") ? GitCommitHorizontal : FileText;
  }
}

export function RookeryTab(props: IDockviewPanelHeaderProps): JSX.Element {
  const t = useT();
  const api = props.api;
  const params = props.params as PanelParams;
  const [title, setTitle] = useState<string>(api.title ?? "");
  useEffect(() => {
    setTitle(api.title ?? "");
    const d = api.onDidTitleChange(() => setTitle(api.title ?? ""));
    return () => d.dispose();
  }, [api]);
  // Fixed panels (conversation/terminal/files/git/nested) render their label LIVE
  // from the current locale via the SAME keys WorkspaceDock.titleFor uses, instead
  // of trusting the persisted api.title — otherwise a locale switch (or a layout
  // restored from a session saved under a different locale) leaves stale-language
  // chrome behind (audit #29). Editor tabs (file/diff/commit) keep api.title, since
  // that's the real, live filename/subject.
  const label = params.kind === "editor" ? title : fixedPanelTitle(params.kind, t, params.kind === "conversation" ? params.agentKind : undefined);
  const tooltip = params.kind === "editor" ? editorTooltip(params.tabId) : undefined;
  const Icon = iconFor(params);
  // Every panel except the pinned conversation can be closed (audit #48): closing
  // a fixed panel (Files/Git/Terminal/Nested) HIDES it — WorkspaceDock mirrors the
  // removal into dockPanelsStore, and the header's restored terminal/right-panel
  // toggles (WorkspaceHeaders.tsx) re-add it the same way a fresh page seeds it.
  // The conversation panel stays non-closable — it's the primary view, and
  // WorkspaceDock's onDidRemovePanel guard re-adds it if it's ever removed anyway.
  const closable = params.kind !== "conversation";
  // Dirty-tab close guard (audit #44) — same TabCloseConfirm the legacy TabBar's X routes
  // through, so a dockview-closed editor tab is guarded identically. Only file tabs carry
  // a dirty flag (diff/commit tabs are read-only and close without confirmation).
  const pageTabs = useWsStore((s) => s.byPage[params.pageKey]?.tabs ?? EMPTY_TABS);
  const closeTabs = useWsStore((s) => s.closeTabs_);
  const currentTab = params.kind === "editor" ? pageTabs.find((tb) => tb.id === params.tabId) : undefined;
  const dirty = currentTab?.kind === "file" && currentTab.dirty;
  const [confirming, setConfirming] = useState<{ ids: string[]; title: string; dirtyCount: number; bulk: boolean; closeApi?: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Exclude<Tab, { kind: "agent" }> } | null>(null);
  const requestCloseIds = (ids: string[], tabTitle: string): void => {
    const wanted = new Set(ids);
    const dirtyCount = pageTabs.filter((tb) => wanted.has(tb.id) && tb.kind === "file" && tb.dirty).length;
    if (dirtyCount > 0) setConfirming({ ids, title: tabTitle, dirtyCount, bulk: ids.length > 1 });
    else closeTabs(params.pageKey, ids);
  };
  const menuItems = (tab: Exclude<Tab, { kind: "agent" }>): MenuItem[] => {
    const closable = pageTabs.filter((tb): tb is Exclude<Tab, { kind: "agent" }> => tb.kind !== "agent");
    const others = closable.filter((tb) => tb.id !== tab.id);
    return [
      { label: t("tabBar.close"), onClick: () => requestCloseIds([tab.id], tab.title) },
      { label: t("tabBar.closeOthers"), onClick: () => requestCloseIds(others.map((tb) => tb.id), tab.title) },
      { label: t("tabBar.closeAll"), danger: true, onClick: () => requestCloseIds(closable.map((tb) => tb.id), tab.title) },
    ];
  };
  const onContextMenu = (e: ReactMouseEvent): void => {
    if (params.kind !== "editor" || !currentTab || currentTab.kind === "agent") return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, tab: currentTab });
  };
  return (
    <>
      <div onContextMenu={onContextMenu} className="rk-tab group flex h-full items-center gap-1.5 px-2 text-[11.5px] font-medium select-none">
        <Icon size={12} className={cn("shrink-0", params.kind === "conversation" ? "text-accent" : "text-muted")} />
        <span title={tooltip} className="max-w-[168px] truncate">{label}</span>
        {closable && (
          <button
            onMouseDown={(e) => e.stopPropagation()} /* don't start a tab drag when clicking close */
            onClick={(e) => { e.stopPropagation(); if (dirty) setConfirming({ ids: params.kind === "editor" ? [params.tabId] : [], title: label, dirtyCount: 1, bulk: false, closeApi: true }); else api.close(); }}
            aria-label={t("tabBar.closeTab")}
            className="ml-0.5 rounded p-0.5 text-muted opacity-0 transition-opacity duration-150 hover:text-fail group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          >
            <X size={11} />
          </button>
        )}
      </div>
      {confirming && (
        <TabCloseConfirm
          tabTitle={confirming.title}
          dirtyCount={confirming.dirtyCount}
          bulk={confirming.bulk}
          onDiscard={() => confirming.closeApi ? api.close() : closeTabs(params.pageKey, confirming.ids)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.tab)} onClose={() => setMenu(null)} />}
    </>
  );
}
