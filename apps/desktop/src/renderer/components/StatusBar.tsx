import { useEffect, useRef, useState } from "react";
import { Blocks, Clock, Power, Settings } from "lucide-react";
import type { SlackStatus } from "@daemon/core/events.js";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import type { ResourceSnapshot } from "../types/rookery.js";
import type { AttentionNav } from "../lib/attention-queue.js";
import { cn } from "../lib/cn.js";
import { MENU_SURFACE } from "../lib/ui-tokens.js";
import { useT } from "../i18n/provider.js";
import { UsagePanel, type UsageTab } from "./UsagePanel.js";
import { ResourceMonitor } from "./ResourceMonitor.js";
import { AttentionBell } from "./AttentionBell.js";
import { Tooltip } from "./Tooltip.js";
import { APP_SHORTCUT, withShortcut } from "../lib/shortcuts.js";

// Usage strip + its detail popover (audit #25): the strip is a button, the popover is the full UsagePanel (titles,
// reset times, provider tabs, hints). It opens upward and closes on Escape, an outside click or a route change.
function UsageItem({ usage, loadFailed, empty, routeKey }: { usage: UsageSnapshot | null; loadFailed?: boolean; empty?: boolean; routeKey?: string }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<UsageTab>("claude"); // shared by the strip and the popover (review m3)
  const panelRef = useRef<HTMLDivElement>(null);
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
  // Move focus into the popover on open, like the Resources popover (review m3).
  useEffect(() => { if (open) panelRef.current?.focus(); }, [open]);
  return (
    <span className="relative flex min-w-0 shrink items-center">
      {/* the strip is the one item that gives way in a narrow window, so the right-hand entry points never clip */}
      <span className="flex min-w-0 shrink items-center overflow-hidden">
        <UsagePanel usage={usage} loadFailed={loadFailed} empty={empty} variant="statusbar" onOpenDetails={() => setOpen((v) => !v)} detailsOpen={open} tab={tab} onTabChange={setTab} />
      </span>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div ref={panelRef} role="dialog" aria-label={t("usagePanel.details")} tabIndex={-1} className={cn("absolute bottom-full left-0 z-50 mb-1 w-[300px] whitespace-normal focus:outline-none", MENU_SURFACE)}>
            <UsagePanel usage={usage} loadFailed={loadFailed} empty={empty} tab={tab} onTabChange={setTab} />
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
  usageEmpty?: boolean;
  resources: ResourceSnapshot | null;
  resourcesFailed?: boolean;
  onResourceRefresh: () => void | Promise<void>; // the read's promise, so the monitor's Retry can follow it
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
        <span className={item} title={`${t("resourceMonitor.daemon")} · ${p.daemonStatusText}`}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200", p.daemon === "starting" ? "bg-run led-live" : "bg-fail")} />
          <span>{t("resourceMonitor.daemon")}</span>
          <span className="truncate text-muted">{p.daemonStatusText}</span>
        </span>
      )}
      <span className={item} title={`Slack · ${p.slackStatusText}`}>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200", p.slack === "up" ? "bg-pr" : p.slack === "connecting" ? "bg-run led-live" : p.slack === "error" ? "bg-fail" : "bg-stop", p.slackJustUp && "status-flash")} />
        <span>Slack</span>
        {p.slack !== "up" && <span className="truncate text-muted">{p.slackStatusText}</span>}
      </span>

      <UsageItem usage={p.usage} loadFailed={p.usageLoadFailed} empty={p.usageEmpty} routeKey={p.routeKey} />

      <ResourceMonitor snapshot={p.resources} failed={p.resourcesFailed} onRefresh={p.onResourceRefresh} onOpenChange={p.onResourceOpenChange} variant="statusbar" closeKey={p.routeKey} />

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
        <Tooltip label={withShortcut(t("app.settings"), APP_SHORTCUT.settings.label())} side="top" align="end">
          <button onClick={p.onToggleSettings} aria-label={t("app.settings")} aria-keyshortcuts={APP_SHORTCUT.settings.aria()} className={iconBtn(p.settingsActive)}>
            <Settings size={12} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
