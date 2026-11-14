import { Bell, BellRing, BellOff, Blocks, Clock, RotateCcw, Settings } from "lucide-react";
import type { SlackStatus } from "@daemon/core/events.js";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import type { ResourceSnapshot } from "../types/rookery.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { UsagePanel } from "./UsagePanel.js";
import { ResourceMonitor } from "./ResourceMonitor.js";
import { Tooltip } from "./Tooltip.js";

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
}): JSX.Element {
  const t = useT();
  // Shared item shell — a 20px-high hover target with 12px gaps between items (DESIGN status-bar spec).
  const item = "no-drag flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-meta transition-colors hover:bg-raised";
  const iconBtn = (active: boolean) =>
    cn("no-drag flex h-5 w-5 shrink-0 items-center justify-center rounded-sm transition-colors", active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg-dim");

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 bg-sunk px-2 text-meta text-fg-dim">
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

      <UsagePanel usage={p.usage} loadFailed={p.usageLoadFailed} variant="statusbar" />

      <ResourceMonitor snapshot={p.resources} onRefresh={p.onResourceRefresh} onOpenChange={p.onResourceOpenChange} variant="statusbar" />

      <button
        onClick={p.onToggleNotify}
        aria-label={p.notifyOn ? t("app.notifyOnTitle") : t("app.notifyOffTitle")}
        title={p.notifyOn ? t("app.notifyOnTitle") : t("app.notifyOffTitle")}
        className={cn("no-drag flex h-5 w-5 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-raised", p.notifyOn ? "text-fg-dim" : "text-muted")}
      >
        {p.notifyOn ? <BellRing size={12} /> : <BellOff size={12} />}
      </button>

      {/* right-aligned cluster — always-reachable entry points (audit #22), moved out of the sidebar footer */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip label={t("app.capabilityCenter")} side="top">
          <button onClick={p.onToggleCapabilityCenter} aria-label={t("app.capabilityCenter")} className={iconBtn(p.capabilityActive)}>
            <Blocks size={12} />
          </button>
        </Tooltip>
        <Tooltip label={t("app.automation")} side="top">
          <button onClick={p.onToggleAutomation} aria-label={t("app.automation")} className={iconBtn(p.automationActive)}>
            <Clock size={12} />
          </button>
        </Tooltip>
        <Tooltip label={t("app.restartDaemon")} side="top">
          <button onClick={p.onRestart} disabled={p.restarting} aria-label={t("app.restartDaemon")} className={cn(iconBtn(false), "disabled:opacity-40")}>
            <RotateCcw size={12} className={cn(p.restarting && "animate-spin motion-reduce:animate-none")} />
          </button>
        </Tooltip>
        <Tooltip label={t("app.settings")} side="top">
          <button onClick={p.onToggleSettings} aria-label={t("app.settings")} className={iconBtn(p.settingsActive)}>
            <Settings size={12} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
