import { MessageSquare, FileText, GitCompare, GitCommitHorizontal, X } from "lucide-react";
import { useWsStore } from "../store/workspace.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { useSegmentIndicator } from "../lib/useSegmentIndicator.js";

export function TabBar({ pageKey, agentLabel }: { pageKey: string; agentLabel: string }): JSX.Element {
  const t = useT();
  const pageRec = useWsStore((s) => s.byPage[pageKey]);
  const setActive = useWsStore((s) => s.setActive_);
  const closeTab = useWsStore((s) => s.closeTab_);
  const tabs = pageRec?.tabs ?? [{ id: "agent", kind: "agent" as const }];
  const active = pageRec?.activeTabId ?? "agent";
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
          <div key={tab.id} data-seg={tab.id} className={cn("group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition-colors duration-150", tab.id === active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60")}>
            <button onClick={() => setActive(pageKey, tab.id)} className="flex items-center gap-1.5">
              <Icon size={12} className={tab.kind === "agent" ? "text-accent" : undefined} />
              <span className="max-w-[140px] truncate">{title}</span>
              {dirty && <span className="dot-pop h-1.5 w-1.5 rounded-full bg-fg-dim" />}
            </button>
            {tab.kind !== "agent" && (
              <button onClick={() => closeTab(pageKey, tab.id)} aria-label={t("tabBar.closeTab")} className="text-muted opacity-0 transition-opacity duration-150 hover:text-fail group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"><X size={11} /></button>
            )}
          </div>
        );
      })}
    </div>
  );
}
