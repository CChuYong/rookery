import { useCallback, useEffect, useRef } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import { useTermStore } from "../store/terminals.js";
import { TerminalView } from "./TerminalView.js";
import { useResizableHeight } from "../lib/useResizableHeight.js";
import { toast } from "../store/toasts.js";
import { cn } from "../lib/cn.js";
import { TAB_IDLE, TAB_LINE } from "../lib/ui-tokens.js";
import { useT } from "../i18n/provider.js";
import { baseName } from "../lib/path.js";

const EMPTY = { tabs: [], activeTabId: null, open: false }; // stable ref — avoids creating a new object every render when the page is empty
// Last shell request answered per page (module-level so a remount doesn't answer the same request twice).
const answeredShellRequest = new Map<string, number>();

// Bottom terminal drawer. Tab bar for one agent page (sessionId = page key) + the active tab's xterm + a top-edge resize handle.
export function TerminalPanel({ sessionId, subId, cwd, dock }: { sessionId: string; subId: string | null; cwd?: string; dock?: boolean }): JSX.Element {
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

  // In-flight guard: a double click (or a click racing a dock request) must not spawn two shells (audit #80).
  const creating = useRef(false);
  const newTab = async (): Promise<void> => {
    if (creating.current) return;
    creating.current = true;
    try {
      const r = await window.rookery.term.create({ sessionId, subId: subId ?? undefined, cwd, cols: 80, rows: 24 });
      if (r.error || !r.id) { toast.error(t("terminalPanel.openFailed"), r.error || undefined); return; }
      open_(sessionId, { id: r.id, title: cwd ? baseName(cwd) || "zsh" : "zsh", exited: false });
    } finally {
      creating.current = false;
    }
  };
  // Answer the dock's "open a shell" request (terminal toggle / Ctrl+` on a page with no shell yet, audit #80).
  const shellRequest = useTermStore((st) => st.shellRequests[sessionId] ?? 0);
  useEffect(() => {
    if (!dock || shellRequest <= (answeredShellRequest.get(sessionId) ?? 0)) return;
    answeredShellRequest.set(sessionId, shellRequest);
    void newTab();
    // newTab closes over this page's props; the effect only reacts to a new request number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock, sessionId, shellRequest]);
  const close = (id: string): void => { window.rookery.term.kill(id); close_(sessionId, id); };
  // Stable onExit — it goes into TerminalView's effect deps, so keep one per page (a new closure every render would recreate the xterm).
  const onExit = useCallback((id: string) => markExit_(sessionId, id), [markExit_, sessionId]);

  // In dockable mode the dockview group owns the panel's height + sashes, so fill
  // it (no fixed height / top resize handle / drawer border); otherwise it's the
  // classic bottom drawer sized by the store with a top-edge resize handle.
  return (
    <div className={cn("flex flex-col bg-ink", dock ? "h-full" : "shrink-0 border-t border-line")} style={dock ? undefined : { height }}>
      {!dock && <div onPointerDown={startDrag} className={cn("h-1.5 shrink-0 cursor-row-resize hover:bg-accent/30", resizing && "bg-accent/40")} />}
      {group.tabs.length === 0 ? (
        // Empty page: one quiet 30px row (a "New terminal" action + the hint) instead of an empty tab strip over a
        // placeholder, so the collapsed group (dockview header + this row) is ~60px and reads like an IDE panel.
        <div className="flex h-[30px] shrink-0 items-center gap-3 px-2">
          <button
            onClick={() => void newTab()}
            aria-label={t("terminalPanel.newTerminal")}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-ui text-fg-dim transition-colors hover:bg-raised hover:text-fg"
          >
            <Plus size={14} /> {t("terminalPanel.newTerminal")}
          </button>
          <div className="min-w-0 truncate text-meta text-faint">{subId ? t("terminalPanel.emptyHintWorker") : t("terminalPanel.emptyHint")}</div>
        </div>
      ) : (
        <>
          {/* Terminal tabs: a slim strip on the canvas colour (the dockview group header above already carries the
              panel's chrome), flat tabs, the active one marked by the shared tab-strip line (audit #99). */}
          <div role="tablist" className="flex h-7 shrink-0 items-center px-1">
            {group.tabs.map((tab) => {
              const active = tab.id === group.activeTabId;
              return (
                <div key={tab.id} className={cn("group relative flex h-full shrink-0 items-center gap-1.5 px-2.5 text-ui", active ? "text-fg" : TAB_IDLE)}>
                  <SquareTerminal size={12} className="shrink-0 text-faint" aria-hidden />
                  <button role="tab" aria-selected={active} onClick={() => setActive_(sessionId, tab.id)} className={cn("max-w-[140px] truncate", tab.exited && "text-stop line-through")}>{tab.title}</button>
                  <button onClick={() => close(tab.id)} aria-label={t("terminalPanel.closeTerminal")} className="rounded-sm text-muted opacity-0 hover:text-fail group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"><X size={12} /></button>
                  {active && <span className={cn("pointer-events-none absolute inset-x-2 bottom-0", TAB_LINE)} aria-hidden />}
                </div>
              );
            })}
            <button onClick={() => void newTab()} aria-label={t("terminalPanel.newTerminal")} title={t("terminalPanel.newTerminal")} className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-sm text-muted hover:bg-raised hover:text-fg"><Plus size={14} /></button>
          </div>
          <div className="relative min-h-0 flex-1">
            {group.activeTabId && <div className="absolute inset-0 py-1.5 pl-3 pr-1"><TerminalView id={group.activeTabId} onExit={onExit} /></div>}
          </div>
        </>
      )}
    </div>
  );
}
