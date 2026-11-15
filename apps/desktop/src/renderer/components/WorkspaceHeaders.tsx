import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SquareTerminal, PanelRight, Ticket, LayoutTemplate, ChevronDown, MoreHorizontal } from "lucide-react";
import { cn } from "../lib/cn.js";
import { baseName } from "../lib/path.js";
import { StatusBadge, ProviderBadge } from "./StatusBadge.js";
import { CheckpointMenu } from "./CheckpointMenu.js";
import type { Checkpoint } from "./CheckpointMenu.js";
import { SessionMetrics } from "./SessionMetrics.js";
import { MetricsView } from "./MetricsView.js";
import { OpenInAppMenu } from "./OpenInAppMenu.js";
import { ContextMenu, type AnchorRect, type MenuItem } from "./ContextMenu.js";
import type { FleetRow, LogItem } from "../store/reduce.js";
import { useStore } from "../store/store.js";
import { useT } from "../i18n/provider.js";
import { shortBranch } from "../lib/branch.js";
import { useDockPanelsStore, isHidden, panelToggleState, rightGroupKindsFor, type HideableKind } from "../store/dock-panels.js";
import { useLayoutStore } from "../store/layout.js";

const EMPTY_HIDDEN: HideableKind[] = []; // stable ref for the "nothing hidden yet" case

// Latest stats for the worker header — subscribes to workerLogs and renders via MetricsView.
const EMPTY: LogItem[] = [];

function WorkerMetrics({ workerId }: { workerId: string }): JSX.Element | null {
  const items = useStore((st) => st.workerLogs[workerId] ?? EMPTY);
  const provider = useStore((s) => s.fleet[workerId]?.provider);
  return <MetricsView items={items} provider={provider} />;
}

// Menu text for one listed task: the description cut to 80 characters (whole code points, never half a surrogate
// pair) with an ellipsis, or the task type when the provider sent no description.
const TASK_LABEL_MAX = 80;
function taskMenuLabel(task: { type: string; description: string }): string {
  const chars = Array.from(task.description.trim());
  if (chars.length === 0) return task.type;
  return chars.length > TASK_LABEL_MAX ? `${chars.slice(0, TASK_LABEL_MAX).join("")}…` : chars.join("");
}

// Keep the primary Worker status badge authoritative while adding a compact explanation for its background state.
// This child subscribes directly so workflow heartbeats do not pull the whole App through a render.
function WorkerActivityReason({ worker, onStopTask }: { worker: FleetRow; onStopTask?: (taskId: string) => void }): JSX.Element | null {
  const t = useT();
  const activeWorkflows = useStore((state) => Object.values(state.workflows[worker.id] ?? {}).filter((run) => run.status === "running").length);
  const [menu, setMenu] = useState<{ x: number; y: number; rect: AnchorRect } | null>(null);
  // Listed background tasks (Claude only — codex workers never carry tasks) arrive in any status, running included.
  // Ambient/subagent/workflow bg tasks are deliberately NOT listed, so `bg.count` never drives this indicator.
  const tasks = worker.tasks ?? [];
  const showTasks = activeWorkflows === 0 && tasks.length > 0;
  // Drop a stale open menu when the button goes away, so it can't reopen by itself when tasks reappear.
  useEffect(() => { if (!showTasks) setMenu(null); }, [showTasks]);
  // Text-only badge (a dot for state, no bordered chip) — the status badge already carries the colored chrome.
  if (activeWorkflows > 0) {
    return <span className="workspace-header-activity flex shrink-0 items-center gap-1 font-mono text-meta text-run"><span className="h-1 w-1 shrink-0 rounded-full bg-run led-live" />{t("workspaceHeaders.workflowTasks", { count: activeWorkflows })}</span>;
  }
  // Ghost button whenever the listed set is non-empty; opens a per-task Stop menu.
  if (showTasks) {
    return (
      <>
        <button
          aria-label={t("workspaceHeaders.tasksMenu")}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          // While open, keep this mousedown from reaching the menu's outside-click close so the click below toggles it shut.
          onMouseDown={(e) => { if (menu) e.stopPropagation(); }}
          onClick={(e) => {
            if (menu) { setMenu(null); return; }
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 2, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } });
          }}
          className="workspace-header-activity no-drag inline-flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-meta text-muted transition-colors hover:text-fg-dim"
        >
          {t("workspaceHeaders.backgroundTasks", { count: tasks.length })}
          <ChevronDown size={12} />
        </button>
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            anchorRect={menu.rect}
            onClose={() => setMenu(null)}
            items={tasks.map((task) => ({
              label: t("workspaceHeaders.stopTask", { description: taskMenuLabel(task) }),
              onClick: () => onStopTask?.(task.id),
              hint: task.type,
            }))}
          />
        )}
      </>
    );
  }
  return null;
}

// "…" overflow (audit #21): the narrow header (≤720px, globals.css) drops metrics, checkpoint, ticket, the task menu
// and Reset layout — this menu, shown only at that width, keeps every one of them reachable. The metrics ride along
// as a read-only header block.
// The button only renders when there's something to show (review m1): items, or a header the caller says is non-empty.
function HeaderOverflow({ items, header }: { items: MenuItem[]; header?: ReactNode }): JSX.Element | null {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; rect: AnchorRect } | null>(null);
  if (items.length === 0 && !header) return null;
  return (
    <>
      <button
        aria-label={t("common.moreActions")}
        title={t("common.moreActions")}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onMouseDown={(e) => { if (menu) e.stopPropagation(); }}
        onClick={(e) => {
          if (menu) { setMenu(null); return; }
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } });
        }}
        className={cn("workspace-header-overflow no-drag h-6 w-6 items-center justify-center rounded-md transition-colors", menu ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg-dim")}
      >
        <MoreHorizontal size={14} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} anchorRect={menu.rect} onClose={() => setMenu(null)} header={header} items={items} />}
    </>
  );
}

// Whether a transcript has a metrics row yet (scans from the end, where they land) — decides if the overflow's metrics
// block would have anything in it.
function hasMetricsItem(items: LogItem[] | undefined): boolean {
  if (!items) return false;
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === "metrics") return true;
  return false;
}

// Read-only metrics block at the top of the overflow menu (hidden when there are no metrics yet).
function OverflowMetrics({ children }: { children: ReactNode }): JSX.Element {
  return <div className="border-b border-line-soft px-2.5 pb-1.5 pt-1 empty:hidden">{children}</div>;
}

// Shared right-side toggles for the worker/session header (open in other app + terminal bottom panel + right panel). The right toggle only shows when a page exists.
// Order (audit #22, both headers): Open in → overflow → Reset layout → terminal → right panel, so the panel toggles
// always sit at the far right.
function HeaderControls({ termPageKey, termPageOpen, rightOpen, onToggleTerm, onToggleRight, subId, cwd, dock, agentKind = "master", overflowItems = [], overflowHeader }: {
  termPageKey: string | null; termPageOpen: boolean; rightOpen: boolean; onToggleTerm: () => void; onToggleRight: () => void;
  subId?: string | null; cwd?: string; dock?: boolean; agentKind?: "master" | "worker";
  overflowItems?: MenuItem[]; overflowHeader?: ReactNode;
}): JSX.Element {
  const t = useT();
  // Active = a neutral lift (bg-raised + fg), never the accent fill — the accent is reserved for lines/focus/current-item.
  const btn = (active: boolean): string => cn("no-drag flex h-6 w-6 items-center justify-center rounded-md transition-colors", active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg-dim");
  // In dockable mode the terminal/right panel are dockview panels, not the legacy
  // open/rightOpen booleans — restore the toggle affordance dock mode used to hide
  // entirely (audit #48) by reading/driving dockPanelsStore instead, so a hidden
  // fixed panel has a way back. "Right panel" toggles Files·Git·(worker) Nested as
  // one group, matching the pre-dock single right-sidebar toggle.
  const hidden = useDockPanelsStore((s) => (termPageKey ? s.hiddenByPage[termPageKey] ?? EMPTY_HIDDEN : EMPTY_HIDDEN));
  const autoHidden = useDockPanelsStore((s) => (termPageKey ? s.autoHiddenByPage[termPageKey] ?? EMPTY_HIDDEN : EMPTY_HIDDEN));
  const rightGroupKinds = rightGroupKindsFor(agentKind);
  const dockTerminalOpen = !isHidden(hidden, "terminal");
  // "auto" = hidden only because the window is narrow (audit #4): it must not look like the user closed it.
  const rightState = panelToggleState(hidden, autoHidden, rightGroupKinds);
  const rightTitle = rightState === "open" ? t("workspaceHeaders.rightPanelHide") : rightState === "auto" ? t("workspaceHeaders.rightPanelAutoHidden") : t("workspaceHeaders.rightPanelShow");
  const resetLayout = (): void => { if (termPageKey) useLayoutStore.getState().reset_(termPageKey); };
  const overflow = dock && termPageKey ? [...overflowItems, { label: t("workspaceHeaders.resetLayout"), onClick: resetLayout }] : overflowItems;
  return (
    <>
      <OpenInAppMenu subId={subId} cwd={cwd} />
      <HeaderOverflow items={overflow} header={overflowHeader} />
      {dock && termPageKey && (
        // Reset layout (audit #57) — doesn't touch the dockview API directly, mirrors the toggles below: it clears
        // this page's saved layout and bumps its reset counter, and WorkspaceDock reseeds the live dock (keeping an
        // open terminal) and offers Undo (audit #79). Scope: this page's panels only; the sidebar width is global
        // and has its own double-click reset. LayoutTemplate, not RotateCcw — that glyph also meant "restart daemon"
        // and "git revert" (audit #20). In the overflow menu at narrow widths.
        <button onClick={resetLayout} aria-label={t("workspaceHeaders.resetLayout")} title={t("workspaceHeaders.resetLayoutTitle")} className={cn("workspace-header-reset", btn(false))}>
          <LayoutTemplate size={14} />
        </button>
      )}
      {!dock && <button onClick={onToggleTerm} aria-label={t("workspaceHeaders.terminalAria")} aria-pressed={termPageOpen} title={t("workspaceHeaders.terminalTitle")} className={btn(termPageOpen)}><SquareTerminal size={14} /></button>}
      {!dock && termPageKey && <button onClick={onToggleRight} aria-label={t("workspaceHeaders.rightPanelAria")} aria-pressed={rightOpen} title={t("workspaceHeaders.rightPanelTitle")} className={btn(rightOpen)}><PanelRight size={14} /></button>}
      {dock && termPageKey && (
        // dock mode: the panel can be dragged anywhere, so "(bottom panel)" would lie here (#49a) — the tooltip says
        // "Show/Hide terminal" instead. aria-label stays the panel name; aria-pressed carries the state (audit #11).
        // The legacy (!dock) toggle above keeps terminalTitle.
        <button onClick={() => useDockPanelsStore.getState().toggle_(termPageKey, "terminal")} aria-label={t("workspaceHeaders.terminalAria")} aria-pressed={dockTerminalOpen} title={dockTerminalOpen ? t("workspaceHeaders.terminalHide") : t("workspaceHeaders.terminalShow")} className={btn(dockTerminalOpen)}>
          <SquareTerminal size={14} />
        </button>
      )}
      {dock && termPageKey && (
        <button
          onClick={() => useDockPanelsStore.getState().toggleGroup_(termPageKey, rightGroupKinds)}
          aria-label={t("workspaceHeaders.rightPanelAria")}
          aria-pressed={rightState === "open"}
          data-state={rightState}
          title={rightTitle}
          // auto-hidden: a dashed outline instead of the plain "off" look, so a panel the window squeezed out reads
          // differently from one the user closed (audit #4).
          className={cn(btn(rightState === "open"), rightState === "auto" && "border border-dashed border-thumb-hi")}
        >
          <PanelRight size={14} />
        </button>
      )}
    </>
  );
}

// Worker (sub) view header: status badge + label + branch + (checkpoints/toggles).
export function WorkerHeader({ worker, termPageKey, termPageOpen, rightOpen, onToggleTerm, onToggleRight, onFetchCheckpoints, onRestore, onStopTask, dock }: {
  worker: FleetRow; termPageKey: string | null; termPageOpen: boolean; rightOpen: boolean;
  onToggleTerm: () => void; onToggleRight: () => void;
  onFetchCheckpoints: () => Promise<Checkpoint[]>; onRestore: (seq: number) => Promise<void>;
  onStopTask?: (taskId: string) => void; dock?: boolean;
}): JSX.Element {
  const t = useT();
  const repoName = baseName(worker.repoPath);
  // The overflow's "Restore checkpoint…" opens the CheckpointMenu (whose own button is hidden at that width) anchored
  // at the overflow button.
  const headerRef = useRef<HTMLDivElement>(null);
  const [cpRequest, setCpRequest] = useState<{ seq: number; rect: { bottom: number; right: number } } | undefined>(undefined);
  const overflowItems: MenuItem[] = [
    {
      label: t("workspaceHeaders.restoreCheckpoint"),
      onClick: () => {
        const r = headerRef.current?.querySelector(".workspace-header-overflow")?.getBoundingClientRect();
        setCpRequest((cur) => ({ seq: (cur?.seq ?? 0) + 1, rect: r ? { bottom: r.bottom, right: r.right } : { bottom: 44, right: window.innerWidth - 8 } }));
      },
    },
    ...(worker.tasks ?? []).map((task) => ({ label: t("workspaceHeaders.stopTask", { description: taskMenuLabel(task) }), hint: task.type, onClick: () => onStopTask?.(task.id) })),
    ...(worker.ticketKey && worker.ticketUrl ? [{ label: t("workspaceHeaders.openTicketKey", { key: worker.ticketKey }), onClick: () => void window.rookery.openExternal(worker.ticketUrl!) }] : []),
  ];
  return (
    <div ref={headerRef} className="workspace-header drag flex h-10 shrink-0 items-center gap-2 px-4 text-body">
      {/* breadcrumb: repo (muted) / worker title (fg, medium) — T3's "repo / title" pattern. */}
      <span className="workspace-header-repo shrink-0 truncate text-muted" title={worker.repoPath}>{repoName}</span>
      <span className="workspace-header-repo shrink-0 text-faint" aria-hidden>/</span>
      <span className="workspace-header-title min-w-[8ch] truncate text-body font-medium text-fg" title={worker.label}>{worker.label}</span>
      {/* status + activity chip carry responsive-hide hooks (globals.css) so they drop before the ml-auto panel
          controls do — background adds both the widest status label AND the activity chip, which used to push the
          controls past the header's overflow:hidden edge and make them unclickable. */}
      <span className="workspace-header-status shrink-0"><StatusBadge status={worker.status} /></span>
      <WorkerActivityReason worker={worker} onStopTask={onStopTask} />
      <span className="workspace-header-provider shrink-0"><ProviderBadge provider={worker.provider} /></span>
      {/* the "WORKER" eyebrow is a semantic label, not a visual one — kept for screen readers (sr-only) so the
          container-query hook (workspace-header-eyebrow) still has a node when narrow widths drop it entirely. */}
      <span className="workspace-header-eyebrow sr-only">{t("workspaceHeaders.workerEyebrow")}</span>
      <span className="workspace-header-branch min-w-0 truncate font-mono text-meta text-faint" title={worker.branch ?? `rookery/${worker.id}`}>{shortBranch(worker.branch ?? `rookery/${worker.id}`)}</span>
      {worker.ticketKey && worker.ticketUrl && (
        <button
          title={t("workspaceHeaders.openTicket")}
          onClick={() => window.rookery.openExternal(worker.ticketUrl!)}
          className="workspace-header-ticket no-drag inline-flex shrink-0 items-center gap-1 rounded px-1 font-mono text-meta text-muted transition-colors hover:bg-raised hover:text-fg-dim"
        >
          <Ticket size={12} /> {worker.ticketKey}
        </button>
      )}
      {/* One group at the far right, order: metrics → restore → Open in → overflow → reset → terminal → sidebar (same
          as the session header). Branch diff/stop/delete live in the RepoTree worker menu (⋯ / right-click). */}
      <div className="workspace-header-controls no-drag ml-auto flex shrink-0 items-center gap-1">
        <div className="workspace-header-metrics mr-1"><WorkerMetrics workerId={worker.id} /></div>
        <div className="workspace-header-checkpoint"><CheckpointMenu fetchCheckpoints={onFetchCheckpoints} onRestore={onRestore} openRequest={cpRequest} /></div>
        <HeaderControls termPageKey={termPageKey} termPageOpen={termPageOpen} rightOpen={rightOpen} onToggleTerm={onToggleTerm} onToggleRight={onToggleRight} subId={worker.id} dock={dock} agentKind="worker" overflowItems={overflowItems} overflowHeader={<OverflowMetrics><WorkerMetrics workerId={worker.id} /></OverflowMetrics>} />
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
  const repoName = cwd ? baseName(cwd) : null;
  const hasMetrics = useStore((st) => (sessionId ? hasMetricsItem(st.logsBySession[sessionId]) : false));
  return (
    <div className="workspace-header drag flex h-10 shrink-0 items-center gap-2 px-4 text-body">
      <span className="workspace-header-eyebrow sr-only">{t("workspaceHeaders.sessionEyebrow")}</span>
      {/* breadcrumb: cwd basename (muted) / session title (fg, medium) — matches the worker header's pattern. */}
      {repoName && (
        <>
          <span className="workspace-header-repo shrink-0 truncate text-muted" title={cwd}>{repoName}</span>
          <span className="workspace-header-repo shrink-0 text-faint" aria-hidden>/</span>
        </>
      )}
      <span className="workspace-header-title min-w-[8ch] truncate text-body font-medium text-fg" title={name}>{name}</span>
      {readOnly && (
        <span className="flex shrink-0 items-center gap-1 text-meta text-nochg">
          <span className="h-1 w-1 shrink-0 rounded-full bg-nochg" />{t("workspaceHeaders.slackReadOnly")}
        </span>
      )}
      {sessionId && <span className="workspace-header-session-id shrink-0 font-mono text-meta text-faint">#{sessionId.slice(-6)}</span>}
      <span className="workspace-header-provider shrink-0"><ProviderBadge provider={provider} /></span>
      {/* Master turn in progress — a flat dot + word, not a filled pill (accent stays reserved for lines/focus). */}
      {running && (
        <span className="flex shrink-0 items-center gap-1.5 text-meta text-run">
          <span className="h-1.5 w-1.5 rounded-full bg-run led-live" /> {t("workspaceHeaders.working")}
        </span>
      )}
      {/* Same order and gap as the worker header (audit #22): metrics → Open in → overflow → reset → terminal → panel. */}
      <div className="workspace-header-controls no-drag ml-auto flex shrink-0 items-center gap-1">
        {sessionId && <div className="workspace-header-metrics mr-1"><SessionMetrics sessionId={sessionId} /></div>}
        <HeaderControls termPageKey={termPageKey} termPageOpen={termPageOpen} rightOpen={rightOpen} onToggleTerm={onToggleTerm} onToggleRight={onToggleRight} cwd={cwd} dock={dock} agentKind="master" overflowHeader={sessionId && hasMetrics ? <OverflowMetrics><SessionMetrics sessionId={sessionId} /></OverflowMetrics> : undefined} />
      </div>
    </div>
  );
}
