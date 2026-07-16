import { SquareTerminal, PanelRight, Ticket, RotateCcw } from "lucide-react";
import { cn } from "../lib/cn.js";
import { StatusBadge, ProviderBadge } from "./StatusBadge.js";
import { CheckpointMenu } from "./CheckpointMenu.js";
import type { Checkpoint } from "./CheckpointMenu.js";
import { SessionMetrics } from "./SessionMetrics.js";
import { MetricsView } from "./MetricsView.js";
import { OpenInAppMenu } from "./OpenInAppMenu.js";
import type { FleetRow, LogItem } from "../store/reduce.js";
import { useStore } from "../store/store.js";
import { useT } from "../i18n/provider.js";
import { useDockPanelsStore, isHidden, isGroupOpen, rightGroupKindsFor, type HideableKind } from "../store/dock-panels.js";
import { useLayoutStore } from "../store/layout.js";

const EMPTY_HIDDEN: HideableKind[] = []; // stable ref for the "nothing hidden yet" case

// Latest stats for the worker header — subscribes to workerLogs and renders via MetricsView.
const EMPTY: LogItem[] = [];

function WorkerMetrics({ workerId }: { workerId: string }): JSX.Element | null {
  const items = useStore((st) => st.workerLogs[workerId] ?? EMPTY);
  return <MetricsView items={items} />;
}

// Keep the primary Worker status badge authoritative while adding a compact explanation for its background state.
// This child subscribes directly so workflow heartbeats do not pull the whole App through a render.
function WorkerActivityReason({ worker }: { worker: FleetRow }): JSX.Element | null {
  const t = useT();
  const activeWorkflows = useStore((state) => Object.values(state.workflows[worker.id] ?? {}).filter((run) => run.status === "running").length);
  if (activeWorkflows > 0) {
    return <span className="shrink-0 rounded border border-run/25 bg-run/10 px-1.5 py-0.5 font-mono text-[10px] text-run">{t("workspaceHeaders.workflowTasks", { count: activeWorkflows })}</span>;
  }
  if (worker.status === "background" && worker.bg?.count) {
    return <span className="shrink-0 rounded border border-line bg-ink/40 px-1.5 py-0.5 font-mono text-[10px] text-muted">{t("workspaceHeaders.backgroundTasks", { count: worker.bg.count })}</span>;
  }
  return null;
}

// Shared right-side toggles for the worker/session header (open in other app + terminal bottom panel + right panel). The right toggle only shows when a page exists.
function HeaderControls({ termPageKey, termPageOpen, rightOpen, onToggleTerm, onToggleRight, subId, cwd, dock, agentKind = "master" }: {
  termPageKey: string | null; termPageOpen: boolean; rightOpen: boolean; onToggleTerm: () => void; onToggleRight: () => void;
  subId?: string | null; cwd?: string; dock?: boolean; agentKind?: "master" | "worker";
}): JSX.Element {
  const t = useT();
  const btn = (active: boolean): string => cn("no-drag flex h-6 w-6 items-center justify-center rounded-md transition-colors", active ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised hover:text-fg-dim");
  // In dockable mode the terminal/right panel are dockview panels, not the legacy
  // open/rightOpen booleans — restore the toggle affordance dock mode used to hide
  // entirely (audit #48) by reading/driving dockPanelsStore instead, so a hidden
  // fixed panel has a way back. "Right panel" toggles Files·Git·(worker) Nested as
  // one group, matching the pre-dock single right-sidebar toggle.
  const hidden = useDockPanelsStore((s) => (termPageKey ? s.hiddenByPage[termPageKey] ?? EMPTY_HIDDEN : EMPTY_HIDDEN));
  const rightGroupKinds = rightGroupKindsFor(agentKind);
  const dockTerminalOpen = !isHidden(hidden, "terminal");
  const dockRightOpen = isGroupOpen(hidden, rightGroupKinds);
  return (
    <>
      <OpenInAppMenu subId={subId} cwd={cwd} />
      {!dock && <button onClick={onToggleTerm} aria-label={t("workspaceHeaders.terminalAria")} title={t("workspaceHeaders.terminalTitle")} className={btn(termPageOpen)}><SquareTerminal size={14} /></button>}
      {!dock && termPageKey && <button onClick={onToggleRight} aria-label={t("workspaceHeaders.rightPanelAria")} title={t("workspaceHeaders.rightPanelTitle")} className={btn(rightOpen)}><PanelRight size={14} /></button>}
      {dock && termPageKey && (
        // dock mode: the panel can be dragged anywhere, so "(bottom panel)" would lie here — use the plain tab
        // label instead (same reasoning as #49a's tab rename). The legacy (!dock) toggle above keeps terminalTitle.
        <button onClick={() => useDockPanelsStore.getState().toggle_(termPageKey, "terminal")} aria-label={t("workspaceHeaders.terminalAria")} title={t("workspaceHeaders.terminalTab")} className={btn(dockTerminalOpen)}>
          <SquareTerminal size={14} />
        </button>
      )}
      {dock && termPageKey && (
        <button onClick={() => useDockPanelsStore.getState().toggleGroup_(termPageKey, rightGroupKinds)} aria-label={t("workspaceHeaders.rightPanelAria")} title={t("workspaceHeaders.rightPanelTitle")} className={btn(dockRightOpen)}>
          <PanelRight size={14} />
        </button>
      )}
      {dock && termPageKey && (
        // Reset layout (audit #57) — doesn't touch the dockview API directly, mirrors the toggles above: it
        // just clears this page's saved layout, and WorkspaceDock reconciles by wiping+reseeding the live dock
        // (its own store subscription — the actual dockview manipulation is covered by a live check).
        <button onClick={() => useLayoutStore.getState().clear_(termPageKey)} aria-label={t("workspaceHeaders.resetLayout")} title={t("workspaceHeaders.resetLayout")} className={btn(false)}>
          <RotateCcw size={13} />
        </button>
      )}
    </>
  );
}

// Worker (sub) view header: status badge + label + branch + (checkpoints/toggles).
export function WorkerHeader({ worker, termPageKey, termPageOpen, rightOpen, onToggleTerm, onToggleRight, onFetchCheckpoints, onRestore, dock }: {
  worker: FleetRow; termPageKey: string | null; termPageOpen: boolean; rightOpen: boolean;
  onToggleTerm: () => void; onToggleRight: () => void;
  onFetchCheckpoints: () => Promise<Checkpoint[]>; onRestore: (seq: number) => Promise<void>; dock?: boolean;
}): JSX.Element {
  const t = useT();
  return (
    <div className="workspace-header drag flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-5 text-[13px]">
      <StatusBadge status={worker.status} />
      <WorkerActivityReason worker={worker} />
      <span className="workspace-header-provider shrink-0"><ProviderBadge provider={worker.provider} /></span>
      <span className="workspace-header-eyebrow eyebrow shrink-0 select-none font-mono text-[9px] uppercase tracking-[0.16em] text-muted/60">{t("workspaceHeaders.workerEyebrow")}</span>
      <span className="workspace-header-title min-w-0 truncate font-semibold tracking-[-0.01em]" title={worker.label}>{worker.label}</span>
      <span className="workspace-header-branch min-w-0 truncate font-mono text-[11px] text-muted/80">{worker.branch ?? `rookery/${worker.id.slice(0, 8)}`}</span>
      {worker.ticketKey && worker.ticketUrl && (
        <button
          title={t("workspaceHeaders.openTicket")}
          onClick={() => window.rookery.openExternal(worker.ticketUrl!)}
          className="workspace-header-ticket no-drag inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted transition-colors hover:bg-raised hover:text-fg-dim"
        >
          <Ticket size={10} /> {worker.ticketKey}
        </button>
      )}
      {/* One group at the far right, order: metrics → restore → terminal → sidebar. View-diff/stop/discard moved to the RepoTree right-click menu. */}
      <div className="workspace-header-controls no-drag ml-auto flex shrink-0 items-center gap-1">
        <div className="workspace-header-metrics"><WorkerMetrics workerId={worker.id} /></div>
        <div className="workspace-header-checkpoint"><CheckpointMenu fetchCheckpoints={onFetchCheckpoints} onRestore={onRestore} /></div>
        <HeaderControls termPageKey={termPageKey} termPageOpen={termPageOpen} rightOpen={rightOpen} onToggleTerm={onToggleTerm} onToggleRight={onToggleRight} subId={worker.id} dock={dock} agentKind="worker" />
      </div>
    </div>
  );
}

// Master (session) view header: session name + slack badge + #id + running chip + (toggles/stats).
export function SessionHeader({ name, sessionId, cwd, provider, readOnly, running, termPageKey, termPageOpen, rightOpen, onToggleTerm, onToggleRight, dock }: {
  name: string; sessionId: string | null; cwd?: string; provider?: string; readOnly: boolean; running: boolean;
  termPageKey: string | null; termPageOpen: boolean; rightOpen: boolean; onToggleTerm: () => void; onToggleRight: () => void; dock?: boolean;
}): JSX.Element {
  const t = useT();
  return (
    <div className="workspace-header drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-5 text-[13px]">
      <span className="workspace-header-eyebrow eyebrow shrink-0 select-none font-mono text-[9px] uppercase tracking-[0.16em] text-muted/60">{t("workspaceHeaders.sessionEyebrow")}</span>
      <span className="workspace-header-title min-w-0 truncate font-semibold tracking-[-0.01em]" title={name}>{name}</span>
      {readOnly && <span className="shrink-0 rounded border border-nochg/30 bg-nochg/12 px-1.5 py-0.5 font-mono text-[10px] uppercase text-nochg">{t("workspaceHeaders.slackReadOnly")}</span>}
      {sessionId && <span className="workspace-header-session-id shrink-0 font-mono text-[11px] text-muted/80">#{sessionId.slice(-6)}</span>}
      <span className="workspace-header-provider shrink-0"><ProviderBadge provider={provider} /></span>
      {/* Master turn in progress = a "working" pulse chip (same signature as the worker StatusBadge running state) */}
      {running && (
        <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-run/25 bg-run/12 px-2 py-0.5 text-[10px] font-medium text-run">
          <span className="h-1.5 w-1.5 rounded-full bg-run led-live" /> {t("workspaceHeaders.working")}
        </span>
      )}
      <div className="workspace-header-controls ml-auto flex shrink-0 items-center gap-2.5">
        <HeaderControls termPageKey={termPageKey} termPageOpen={termPageOpen} rightOpen={rightOpen} onToggleTerm={onToggleTerm} onToggleRight={onToggleRight} cwd={cwd} dock={dock} agentKind="master" />
        {sessionId && <div className="workspace-header-metrics"><SessionMetrics sessionId={sessionId} /></div>}
      </div>
    </div>
  );
}
