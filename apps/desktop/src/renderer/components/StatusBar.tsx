import { useEffect, useRef, useState } from "react";
import { Blocks, Clock, Power, Settings } from "lucide-react";
import type { SlackStatus } from "@daemon/core/events.js";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import type { ResourceSnapshot } from "../types/rookery.js";
import type { AttentionNav } from "../lib/attention-queue.js";
import { cn } from "../lib/cn.js";
import { MENU_SURFACE } from "../lib/ui-tokens.js";
import { useT } from "../i18n/provider.js";
import { UsagePanel } from "./UsagePanel.js";
import { ResourceMonitor } from "./ResourceMonitor.js";
import { AttentionBell } from "./AttentionBell.js";
import { Tooltip } from "./Tooltip.js";

// Usage strip + its detail popover (audit #25): the strip is a button, the popover is the full UsagePanel (titles,
// reset times, provider tabs, hints). It opens upward and closes on Escape, an outside click or a route change.
function UsageItem({ usage, loadFailed, routeKey }: { usage: UsageSnapshot | null; loadFailed?: boolean; routeKey?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const lastRoute = useRef(routeKey);
  useEffect(() => {
    if (lastRoute.current === routeKey) return;
    lastRoute.current = routeKey;
    setOpen(false);
  }, [routeKey]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    const resize = (): void => setOpen(false);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("keydown", esc); window.removeEventListener("resize", resize); };
  }, [open]);
  return (
    <span className="relative flex min-w-0 shrink items-center">
      {/* the strip is the one item that gives way in a narrow window, so the right-hand entry points never clip */}
      <span className="flex min-w-0 shrink items-center overflow-hidden">
        <UsagePanel usage={usage} loadFailed={loadFailed} variant="statusbar" onOpenDetails={() => setOpen((v) => !v)} detailsOpen={open} />
      </span>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="dialog" className={cn("absolute bottom-full left-0 z-50 mb-1 w-[300px] whitespace-normal", MENU_SURFACE)}>
            <UsagePanel usage={usage} loadFailed={loadFailed} />
          </div>
        </>
      )}
    </span>
  );
}

// Orca/VS Code-style bottom status bar: daemon/slack state, usage meters, resource memory, notifications, and the
// always-reachable automation/capability/settings entry points — everything that used to crowd the sidebar footer
// (DESIGN toy-tell #6: "dashboard furniture in the sidebar"). Every item is a 20px-high hover target.
export function StatusBar(p: {
  daemon: "up" | "down" | "starting";
  daemonStatusText: string;
  daemonJustUp: boolean;
  slack: SlackStatus;
  slackStatusText: string;
  slackJustUp: boolean;
  usage: UsageSnapshot | null;
  usageLoadFailed?: boolean;
  resources: ResourceSnapshot | null;
  onResourceRefresh: () => void;
  onResourceOpenChange: (open: boolean) => void;
  notifyOn: boolean;
  onToggleNotify: () => void;
  capabilityActive: boolean;
  onToggleCapabilityCenter: () => void;
  automationActive: boolean;
  onToggleAutomation: () => void;
  settingsActive: boolean;
  onToggleSettings: () => void;
  restarting: boolean;
  onRestart: () => void;
  onAttentionNav: (nav: AttentionNav) => void;
  routeKey?: string; // the current page — popovers close when it changes (audit #27)
}): JSX.Element {
  const t = useT();
  // Shared item shell — 20px high with 12px gaps between items (DESIGN status-bar spec). Plain state readouts get no
  // hover lift: only things that do something on click look clickable (audit #25).
  const item = "no-drag flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-meta";
  const iconBtn = (active: boolean) =>
    cn("no-drag flex h-5 w-5 shrink-0 items-center justify-center rounded-sm transition-colors", active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg-dim");

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 whitespace-nowrap bg-sunk px-2 text-meta text-fg-dim">
      {/* Daemon state appears only when it needs attention (starting / down); a healthy daemon stays out of the way. */}
      {p.daemon !== "up" && (
        <span className={item} title={`daemon · ${p.daemonStatusText}`}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200", p.daemon === "starting" ? "bg-run led-live" : "bg-fail")} />
          <span>Daemon</span>
          <span className="truncate text-muted">{p.daemonStatusText}</span>
        </span>
      )}
      <span className={item} title={`slack · ${p.slackStatusText}`}>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200", p.slack === "up" ? "bg-pr" : p.slack === "connecting" ? "bg-run led-live" : p.slack === "error" ? "bg-fail" : "bg-stop", p.slackJustUp && "status-flash")} />
        <span>Slack</span>
        {p.slack !== "up" && <span className="truncate text-muted">{p.slackStatusText}</span>}
      </span>

      <UsageItem usage={p.usage} loadFailed={p.usageLoadFailed} routeKey={p.routeKey} />

      <ResourceMonitor snapshot={p.resources} onRefresh={p.onResourceRefresh} onOpenChange={p.onResourceOpenChange} variant="statusbar" closeKey={p.routeKey} />

      {/* The one bell (audit #19 #20): the attention queue, which also holds the OS-notification toggle. */}
      <AttentionBell onNavigate={p.onAttentionNav} notifyOn={p.notifyOn} onToggleNotify={p.onToggleNotify} variant="statusbar" />

      {/* right-aligned cluster — always-reachable entry points (audit #22), moved out of the sidebar footer */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip label={t("app.capabilityCenter")} side="top" align="end">
          <button onClick={p.onToggleCapabilityCenter} aria-label={t("app.capabilityCenter")} className={iconBtn(p.capabilityActive)}>
            <Blocks size={12} />
          </button>
        </Tooltip>
        <Tooltip label={t("app.automation")} side="top" align="end">
          <button onClick={p.onToggleAutomation} aria-label={t("app.automation")} className={iconBtn(p.automationActive)}>
            <Clock size={12} />
          </button>
        </Tooltip>
        <Tooltip label={t("app.restartDaemon")} side="top" align="end">
          <button onClick={p.onRestart} disabled={p.restarting} aria-label={t("app.restartDaemon")} className={cn(iconBtn(false), "disabled:opacity-40")}>
            {/* Power, not RotateCcw — that glyph is "undo"-shaped and was shared with Reset layout and git Revert (audit #20) */}
            <Power size={12} className={cn(p.restarting && "animate-pulse motion-reduce:animate-none")} />
          </button>
        </Tooltip>
        <Tooltip label={t("app.settings")} side="top" align="end">
          <button onClick={p.onToggleSettings} aria-label={t("app.settings")} className={iconBtn(p.settingsActive)}>
            <Settings size={12} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
