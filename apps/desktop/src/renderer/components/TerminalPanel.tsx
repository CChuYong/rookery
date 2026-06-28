import { useCallback } from "react";
import { Plus, X } from "lucide-react";
import { useTermStore } from "../store/terminals.js";
import { TerminalView } from "./TerminalView.js";
import { useResizableHeight } from "../lib/useResizableHeight.js";
import { toast } from "../store/toasts.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { baseName } from "../lib/path.js";

const EMPTY = { tabs: [], activeTabId: null, open: false }; // stable ref — avoids creating a new object every render when the page is empty

// Bottom terminal drawer. Tab bar for one agent page (sessionId = page key) + the active tab's xterm + a top-edge resize handle.
export function TerminalPanel({ sessionId, subId, cwd }: { sessionId: string; subId: string | null; cwd?: string }): JSX.Element {
  const t = useT();
  // Subscribe via narrow selectors to only this page's slice + stable actions → don't re-render on other pages' changes, avoiding xterm recreation (thrash).
  const group = useTermStore((t) => t.byPage[sessionId]) ?? EMPTY;
  const height0 = useTermStore((t) => t.height);
  const open_ = useTermStore((t) => t.open_);
  const close_ = useTermStore((t) => t.close_);
  const setActive_ = useTermStore((t) => t.setActive_);
  const markExit_ = useTermStore((t) => t.markExit_);
  const setHeight_ = useTermStore((t) => t.setHeight_);
  // Commit to the store at drag end → persisted via persist(rookery.term), restored on the next run.
  const { height, startDrag, resizing } = useResizableHeight(height0, { min: 120, max: 800, onCommit: setHeight_ });

  const newTab = async (): Promise<void> => {
    const r = await window.rookery.term.create({ sessionId, subId: subId ?? undefined, cwd, cols: 80, rows: 24 });
    if (r.error || !r.id) { toast.error(t("terminalPanel.openFailed"), r.error || undefined); return; }
    open_(sessionId, { id: r.id, title: cwd ? baseName(cwd) || "zsh" : "zsh", exited: false });
  };
  const close = (id: string): void => { window.rookery.term.kill(id); close_(sessionId, id); };
  // Stable onExit — it goes into TerminalView's effect deps, so keep one per page (a new closure every render would recreate the xterm).
  const onExit = useCallback((id: string) => markExit_(sessionId, id), [markExit_, sessionId]);

  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-ink" style={{ height }}>
      <div onPointerDown={startDrag} className={cn("h-1.5 shrink-0 cursor-row-resize hover:bg-accent/30", resizing && "bg-accent/40")} />
      <div role="tablist" className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        {group.tabs.map((tab) => (
          <div key={tab.id} className={cn("group flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px]", tab.id === group.activeTabId ? "bg-raised text-fg" : "text-muted hover:bg-raised/60")}>
            <button role="tab" aria-selected={tab.id === group.activeTabId} onClick={() => setActive_(sessionId, tab.id)} className={cn("max-w-[120px] truncate", tab.exited && "text-stop line-through")}>{tab.title}</button>
            <button onClick={() => close(tab.id)} aria-label={t("terminalPanel.closeTerminal")} className="text-muted opacity-0 hover:text-fail group-hover:opacity-100"><X size={11} /></button>
          </div>
        ))}
        <button onClick={() => void newTab()} aria-label={t("terminalPanel.newTerminal")} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-raised hover:text-accent"><Plus size={13} /></button>
      </div>
      <div className="relative min-h-0 flex-1">
        {group.activeTabId
          ? <div className="absolute inset-0 p-1.5"><TerminalView id={group.activeTabId} onExit={onExit} /></div>
          : <div className="flex h-full items-center justify-center text-[12px] text-muted">{t("terminalPanel.emptyHint")}</div>}
      </div>
    </div>
  );
}
