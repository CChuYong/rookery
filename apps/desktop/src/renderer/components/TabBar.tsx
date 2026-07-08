import { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { MessageSquare, FileText, GitCompare, GitCommitHorizontal, X } from "lucide-react";
import { useWsStore, type Tab } from "../store/workspace.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { useSegmentIndicator } from "../lib/useSegmentIndicator.js";
import { editorTooltip } from "../workspace/panel-ids.js";
import { TabCloseConfirm } from "./TabCloseConfirm.js";
import { ContextMenu, type MenuItem } from "./ContextMenu.js";

export function TabBar({ pageKey, agentLabel }: { pageKey: string; agentLabel: string }): JSX.Element {
  const t = useT();
  const pageRec = useWsStore((s) => s.byPage[pageKey]);
  const setActive = useWsStore((s) => s.setActive_);
  const closeTabs = useWsStore((s) => s.closeTabs_);
  const tabs = pageRec?.tabs ?? [{ id: "agent", kind: "agent" as const }];
  const active = pageRec?.activeTabId ?? "agent";
  // Dirty tabs (audit #44) route through the shared TabCloseConfirm instead of closing immediately;
  // clean tabs keep the old no-dialog close. `confirming` is a snapshot so the dialog's exit
  // animation survives the tab already having been removed from `tabs` on Discard.
  const [confirming, setConfirming] = useState<{ ids: string[]; title: string; dirtyCount: number; bulk: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Exclude<Tab, { kind: "agent" }> } | null>(null);
  const requestCloseIds = (ids: string[], title: string): void => {
    const wanted = new Set(ids);
    const dirtyCount = tabs.filter((tb) => wanted.has(tb.id) && tb.kind === "file" && tb.dirty).length;
    if (dirtyCount > 0) setConfirming({ ids, title, dirtyCount, bulk: ids.length > 1 });
    else closeTabs(pageKey, ids);
  };
  const requestClose = (tab: Tab): void => {
    if (tab.kind === "agent") return;
    requestCloseIds([tab.id], tab.title);
  };
  const menuItems = (tab: Exclude<Tab, { kind: "agent" }>): MenuItem[] => {
    const closable = tabs.filter((tb) => tb.kind !== "agent");
    const others = closable.filter((tb) => tb.id !== tab.id);
    return [
      { label: t("tabBar.close"), onClick: () => requestCloseIds([tab.id], tab.title) },
      { label: t("tabBar.closeOthers"), onClick: () => requestCloseIds(others.map((tb) => tb.id), tab.title) },
      { label: t("tabBar.closeAll"), danger: true, onClick: () => requestCloseIds(closable.map((tb) => tb.id), tab.title) },
    ];
  };
  const onContextMenu = (e: ReactMouseEvent, tab: Tab): void => {
    if (tab.kind === "agent") return;
    e.preventDefault();
    setActive(pageKey, tab.id);
    setMenu({ x: e.clientX, y: e.clientY, tab });
  };
  // Coral underline that slides beneath the active tab.
  const { containerRef, rect } = useSegmentIndicator(active, [tabs.length]);
  return (
    <div ref={containerRef} className="relative flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-surface px-1.5">
      {rect && (
        <div
          className="pointer-events-none absolute bottom-0 h-[2px] rounded-full bg-accent transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
          style={{ left: rect.left, width: rect.width }}
        />
      )}
      {tabs.map((tab) => {
        const Icon = tab.kind === "agent" ? MessageSquare : tab.kind === "diff" ? GitCompare : tab.kind === "commit" ? GitCommitHorizontal : FileText;
        const title = tab.kind === "agent" ? agentLabel : tab.title;
        const dirty = tab.kind === "file" && tab.dirty;
        return (
          <div key={tab.id} data-seg={tab.id} onContextMenu={(e) => onContextMenu(e, tab)} className={cn("group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition-colors duration-150", tab.id === active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60")}>
            <button onClick={() => setActive(pageKey, tab.id)} className="flex items-center gap-1.5">
              <Icon size={12} className={tab.kind === "agent" ? "text-accent" : undefined} />
              <span title={editorTooltip(tab.id)} className="max-w-[140px] truncate">{title}</span>
              {dirty && <span className="dot-pop h-1.5 w-1.5 rounded-full bg-fg-dim" />}
            </button>
            {tab.kind !== "agent" && (
              <button onClick={() => requestClose(tab)} aria-label={t("tabBar.closeTab")} className="text-muted opacity-0 transition-opacity duration-150 hover:text-fail group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"><X size={11} /></button>
            )}
          </div>
        );
      })}
      {confirming && (
        <TabCloseConfirm
          tabTitle={confirming.title}
          dirtyCount={confirming.dirtyCount}
          bulk={confirming.bulk}
          onDiscard={() => closeTabs(pageKey, confirming.ids)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.tab)} onClose={() => setMenu(null)} />}
    </div>
  );
}
