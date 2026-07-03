import { SquareTerminal, PanelRight, Ticket } from "lucide-react";
import { cn } from "../lib/cn.js";
import { StatusBadge } from "./StatusBadge.js";
import { CheckpointMenu } from "./CheckpointMenu.js";
import type { Checkpoint } from "./CheckpointMenu.js";
import { SessionMetrics } from "./SessionMetrics.js";
import { MetricsView } from "./MetricsView.js";
import { OpenInAppMenu } from "./OpenInAppMenu.js";
import type { FleetRow, LogItem } from "../store/reduce.js";
import { useStore } from "../store/store.js";
import { useT } from "../i18n/provider.js";

// Latest stats for the worker header — subscribes to workerLogs and renders via MetricsView.
const EMPTY: LogItem[] = [];

function WorkerMetrics({ workerId }: { workerId: string }): JSX.Element | null {
  const items = useStore((st) => st.workerLogs[workerId] ?? EMPTY);
  return <MetricsView items={items} />;
}

// Shared right-side toggles for the worker/session header (open in other app + terminal bottom panel + right panel). The right toggle only shows when a page exists.
function HeaderControls({ termPageKey, termPageOpen, rightOpen, onToggleTerm, onToggleRight, subId, cwd, dock }: {
  termPageKey: string | null; termPageOpen: boolean; rightOpen: boolean; onToggleTerm: () => void; onToggleRight: () => void;
  subId?: string | null; cwd?: string; dock?: boolean;
}): JSX.Element {
  const t = useT();
  const btn = (active: boolean): string => cn("no-drag flex h-6 w-6 items-center justify-center rounded-md transition-colors", active ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised hover:text-fg-dim");
  return (
    <>
      <OpenInAppMenu subId={subId} cwd={cwd} />
      {/* In dockable mode the terminal + right panel are dockview panels, so their toggles are hidden here (their visibility is managed by the dock). */}
      {!dock && <button onClick={onToggleTerm} aria-label={t("workspaceHeaders.terminalAria")} title={t("workspaceHeaders.terminalTitle")} className={btn(termPageOpen)}><SquareTerminal size={14} /></button>}
      {!dock && termPageKey && <button onClick={onToggleRight} aria-label={t("workspaceHeaders.rightPanelAria")} title={t("workspaceHeaders.rightPanelTitle")} className={btn(rightOpen)}><PanelRight size={14} /></button>}
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
    <div className="drag flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-5 text-[13px]">
      <StatusBadge status={worker.status} />
      <span className="eyebrow shrink-0 select-none font-mono text-[9px] uppercase tracking-[0.16em] text-muted/60">{t("workspaceHeaders.workerEyebrow")}</span>
      <span className="min-w-0 truncate font-semibold tracking-[-0.01em]" title={worker.label}>{worker.label}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted/80">{worker.branch ?? `rookery/${worker.id.slice(0, 8)}`}</span>
      {worker.ticketKey && worker.ticketUrl && (
        <button
          title={t("workspaceHeaders.openTicket")}
          onClick={() => window.rookery.openExternal(worker.ticketUrl!)}
          className="no-drag inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted transition-colors hover:bg-raised hover:text-fg-dim"
        >
          <Ticket size={10} /> {worker.ticketKey}
        </button>
      )}
      {/* One group at the far right, order: metrics → restore → terminal → sidebar. View-diff/stop/discard moved to the RepoTree right-click menu. */}
      <div className="no-drag ml-auto flex shrink-0 items-center gap-1">
        <WorkerMetrics workerId={worker.id} />
        <CheckpointMenu fetchCheckpoints={onFetchCheckpoints} onRestore={onRestore} />
        <HeaderControls termPageKey={termPageKey} termPageOpen={termPageOpen} rightOpen={rightOpen} onToggleTerm={onToggleTerm} onToggleRight={onToggleRight} subId={worker.id} dock={dock} />
      </div>
    </div>
  );
}

// Master (session) view header: session name + slack badge + #id + running chip + (toggles/stats).
export function SessionHeader({ name, sessionId, cwd, readOnly, running, termPageKey, termPageOpen, rightOpen, onToggleTerm, onToggleRight, dock }: {
  name: string; sessionId: string | null; cwd?: string; readOnly: boolean; running: boolean;
  termPageKey: string | null; termPageOpen: boolean; rightOpen: boolean; onToggleTerm: () => void; onToggleRight: () => void; dock?: boolean;
}): JSX.Element {
  const t = useT();
  return (
    <div className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-5 text-[13px]">
      <span className="eyebrow shrink-0 select-none font-mono text-[9px] uppercase tracking-[0.16em] text-muted/60">{t("workspaceHeaders.sessionEyebrow")}</span>
      <span className="min-w-0 truncate font-semibold tracking-[-0.01em]" title={name}>{name}</span>
      {readOnly && <span className="shrink-0 rounded border border-nochg/30 bg-nochg/12 px-1.5 py-0.5 font-mono text-[10px] uppercase text-nochg">{t("workspaceHeaders.slackReadOnly")}</span>}
      {sessionId && <span className="shrink-0 font-mono text-[11px] text-muted/80">#{sessionId.slice(-6)}</span>}
      {/* Master turn in progress = a "working" pulse chip (same signature as the worker StatusBadge running state) */}
      {running && (
        <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-run/25 bg-run/12 px-2 py-0.5 text-[10px] font-medium text-run">
          <span className="h-1.5 w-1.5 rounded-full bg-run led-live" /> {t("workspaceHeaders.working")}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        <HeaderControls termPageKey={termPageKey} termPageOpen={termPageOpen} rightOpen={rightOpen} onToggleTerm={onToggleTerm} onToggleRight={onToggleRight} cwd={cwd} dock={dock} />
        {sessionId && <SessionMetrics sessionId={sessionId} />}
      </div>
    </div>
  );
}
