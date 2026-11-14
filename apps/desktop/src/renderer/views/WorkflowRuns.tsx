import { useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WorkflowAgentSummary, WorkflowPhaseSummary, WorkflowRunSnapshot } from "@daemon/core/workflow-activity.js";
import { MessageList } from "../components/MessageList.js";
import { cn } from "../lib/cn.js";
import { absoluteDate, relativeTime } from "../lib/relative-time.js";
import { workflowAgentKey } from "../store/reduce.js";
import { useStore } from "../store/store.js";
import { useLocale, useT } from "../i18n/provider.js";

export interface WorkflowRunsProps {
  workerId: string;
  loadAgentHistory(workerId: string, taskId: string, agentId: string): void;
}

const EMPTY_RUNS: Record<string, WorkflowRunSnapshot> = {};

function timeLabel(ts: number, now: number, locale: string, t: ReturnType<typeof useT>): string {
  const rel = relativeTime(ts, now);
  if (!rel) return absoluteDate(ts, now, locale);
  if (rel.unit === "now") return t("relativeTime.justNow");
  if (rel.unit === "m") return t("relativeTime.minutesAgo", { n: rel.value });
  if (rel.unit === "h") return t("relativeTime.hoursAgo", { n: rel.value });
  return t("relativeTime.daysAgo", { n: rel.value });
}

// State tag colour: a dot + the text in the same tone, no boxed/uppercase chrome.
function statusTone(status: WorkflowRunSnapshot["status"]): { dot: string; text: string } {
  if (status === "running") return { dot: "bg-run led-live", text: "text-run" };
  if (status === "failed") return { dot: "bg-fail", text: "text-fail" };
  if (status === "completed") return { dot: "bg-pr", text: "text-pr" };
  return { dot: "bg-muted", text: "text-muted" };
}

function AgentRoster({
  taskId,
  agents,
  selectedKey,
  onSelect,
}: {
  taskId: string;
  agents: WorkflowAgentSummary[];
  selectedKey: string | null;
  onSelect(agent: WorkflowAgentSummary): void;
}): JSX.Element | null {
  const t = useT();
  const locale = useLocale();
  const bodyRef = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({
    count: agents.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => 26,
    overscan: 8,
    initialRect: { width: 280, height: 208 },
  });
  if (agents.length === 0) return null;
  // Before ResizeObserver supplies the first real measurement (notably in jsdom), keep a bounded initial
  // window visible. The virtualizer replaces it on measurement; never fall back to rendering the full roster.
  const measuredRows = rows.getVirtualItems();
  const visibleRows = measuredRows.length > 0
    ? measuredRows
    : agents.slice(0, 20).map((_, index) => ({ index, key: index, start: index * 26, size: 26 }));
  return (
    <div ref={bodyRef} className="overflow-y-auto" style={{ height: Math.min(agents.length * 26, 208) }}>
      <div className="relative w-full" style={{ height: rows.getTotalSize() }}>
        {visibleRows.map((row) => {
          const agent = agents[row.index]!;
          const key = `${taskId}/${agent.agentId}`;
          const latest = agent.lastToolName ?? t(`workflowActivity.${agent.activity}`);
          const identity = agent.label ?? agent.agentType;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(agent)}
              className={cn(
                "absolute left-0 top-0 flex w-full items-center gap-2 rounded px-2 text-left text-body transition-colors hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-hi",
                selectedKey?.endsWith(`/${key}`) && "bg-accent/10",
              )}
              style={{ height: row.size, transform: `translateY(${row.start}px)` }}
            >
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", agent.status === "running" ? "bg-run led-live" : agent.status === "completed" ? "bg-pr" : "bg-muted")} />
              <span className="min-w-0 flex-1 truncate text-ui text-fg-dim" title={`${identity} · ${agent.agentId}${agent.model ? ` · ${agent.model}` : ""}`}>{identity}{" · "}<span className="font-mono text-meta text-muted">{agent.agentId.slice(0, 8)}</span></span>
              <span className="max-w-[72px] truncate font-mono text-meta text-muted" title={latest}>{latest}</span>
              <span className="shrink-0 font-mono text-meta text-muted/75">{timeLabel(agent.lastActivityAt, Date.now(), locale, t)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface PhaseGroup {
  key: string;
  phase?: WorkflowPhaseSummary;
  title?: string;
  agents: WorkflowAgentSummary[];
}

function workflowPhaseGroups(run: WorkflowRunSnapshot): PhaseGroup[] {
  const groups = new Map<string, PhaseGroup>();
  for (const phase of run.phases ?? []) groups.set(`index:${phase.index}`, { key: `index:${phase.index}`, phase, title: phase.title, agents: [] });
  for (const agent of run.agents) {
    let key = agent.phaseIndex ? `index:${agent.phaseIndex}` : agent.phaseTitle ? `title:${agent.phaseTitle}` : "unassigned";
    let group = groups.get(key);
    if (!group && agent.phaseTitle) {
      const byTitle = [...groups.values()].find((candidate) => candidate.title === agent.phaseTitle);
      if (byTitle) { group = byTitle; key = byTitle.key; }
    }
    if (!group) {
      group = {
        key,
        ...(agent.phaseIndex ? { phase: { index: agent.phaseIndex, title: agent.phaseTitle ?? "" } } : {}),
        ...(agent.phaseTitle ? { title: agent.phaseTitle } : {}),
        agents: [],
      };
      groups.set(key, group);
    }
    group.agents.push(agent);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === "unassigned") return 1;
    if (b.key === "unassigned") return -1;
    return (a.phase?.index ?? Number.MAX_SAFE_INTEGER) - (b.phase?.index ?? Number.MAX_SAFE_INTEGER);
  });
}

function PhaseSection({
  taskId,
  group,
  selectedKey,
  expanded,
  toggle,
  onSelect,
}: {
  taskId: string;
  group: PhaseGroup;
  selectedKey: string | null;
  expanded: Set<string>;
  toggle(key: string): void;
  onSelect(agent: WorkflowAgentSummary): void;
}): JSX.Element {
  const t = useT();
  const active = group.agents.filter((agent) => agent.status === "running").sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const completed = group.agents.filter((agent) => agent.status === "completed").sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt));
  const stopped = group.agents.filter((agent) => agent.status === "stopped").sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt));
  const completedKey = `${group.key}:completed`;
  const stoppedKey = `${group.key}:stopped`;
  const phaseName = group.key === "unassigned"
    ? t("workflowActivity.unassignedPhase")
    : group.phase?.index
      ? group.title
        ? t("workflowActivity.phaseTitle", { index: group.phase.index, title: group.title })
        : t("workflowActivity.phaseNumber", { index: group.phase.index })
      : group.title ?? t("workflowActivity.unassignedPhase");
  return (
    <section className="overflow-hidden rounded-md border border-line/80 bg-raised/15">
      <div className="space-y-1 border-b border-line/70 px-2.5 py-2">
        <div className="flex items-center gap-2">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", active.length > 0 ? "bg-run led-live" : completed.length > 0 ? "bg-pr" : "bg-muted/60")} />
          <span className="min-w-0 flex-1 truncate text-meta font-medium text-fg-dim" title={phaseName}>{phaseName}</span>
          {group.phase?.model && <span className="max-w-[80px] truncate font-mono text-meta text-muted" title={group.phase.model}>{group.phase.model}</span>}
        </div>
        <div className="font-mono text-meta text-muted">
          {t("workflowActivity.activeCount", { count: active.length })}
          {" · "}{t("workflowActivity.completedCount", { count: completed.length })}
          {" · "}{t("workflowActivity.startedCount", { count: group.agents.length })}
          {stopped.length > 0 && <>{" · "}{t("workflowActivity.stoppedCount", { count: stopped.length })}</>}
        </div>
        {group.phase?.detail && <div className="text-meta leading-relaxed text-muted" title={group.phase.detail}>{group.phase.detail}</div>}
      </div>
      {group.agents.length > 0 && (
        <div className="space-y-1 p-1.5">
          {active.length > 0 && <AgentRoster taskId={taskId} agents={active} selectedKey={selectedKey} onSelect={onSelect} />}
          {completed.length > 0 && (
            <>
              <button type="button" onClick={() => toggle(completedKey)} className="flex w-full items-center gap-1 px-1 py-1 text-left text-meta font-medium text-muted hover:text-fg-dim">
                <ChevronRight size={12} className={cn("transition-transform motion-reduce:transition-none", expanded.has(completedKey) && "rotate-90")} /> {t("workflowActivity.completedAgents", { count: completed.length })}
              </button>
              {expanded.has(completedKey) && <AgentRoster taskId={taskId} agents={completed} selectedKey={selectedKey} onSelect={onSelect} />}
            </>
          )}
          {stopped.length > 0 && (
            <>
              <button type="button" onClick={() => toggle(stoppedKey)} className="flex w-full items-center gap-1 px-1 py-1 text-left text-meta font-medium text-muted hover:text-fg-dim">
                <ChevronRight size={12} className={cn("transition-transform motion-reduce:transition-none", expanded.has(stoppedKey) && "rotate-90")} /> {t("workflowActivity.stoppedAgents", { count: stopped.length })}
              </button>
              {expanded.has(stoppedKey) && <AgentRoster taskId={taskId} agents={stopped} selectedKey={selectedKey} onSelect={onSelect} />}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function WorkflowRun({
  workerId,
  run,
  selectedKey,
  setSelectedKey,
  loadAgentHistory,
}: {
  workerId: string;
  run: WorkflowRunSnapshot;
  selectedKey: string | null;
  setSelectedKey(key: string): void;
  loadAgentHistory: WorkflowRunsProps["loadAgentHistory"];
}): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const active = useMemo(() => run.agents.filter((agent) => agent.status === "running").sort((a, b) => b.lastActivityAt - a.lastActivityAt), [run.agents]);
  const completed = useMemo(() => run.agents.filter((agent) => agent.status === "completed").sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt)), [run.agents]);
  const stopped = useMemo(() => run.agents.filter((agent) => agent.status === "stopped").sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt)), [run.agents]);
  const phaseGroups = useMemo(() => workflowPhaseGroups(run), [run.agents, run.phases]);
  const hasPhaseMetadata = (run.phases?.length ?? 0) > 0 || run.agents.some((agent) => agent.phaseIndex !== undefined || agent.phaseTitle !== undefined);
  const completedOpen = expanded.has("completed");
  const stoppedOpen = expanded.has("stopped");
  const selectedBelongs = selectedKey?.startsWith(`${workerId}/${run.taskId}/`) ?? false;
  const selectedLog = useStore((state) => selectedBelongs && selectedKey ? state.workflowAgentLogs[selectedKey] : undefined);
  const loading = useStore((state) => selectedBelongs && selectedKey ? state.workflowAgentHistoryLoading[selectedKey] ?? false : false);
  const failed = useStore((state) => selectedBelongs && selectedKey ? state.workflowAgentHistoryFailed[selectedKey] ?? false : false);
  const toggle = (group: string): void => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });
  const select = (agent: WorkflowAgentSummary): void => {
    const key = workflowAgentKey(workerId, run.taskId, agent.agentId);
    setSelectedKey(key);
    const state = useStore.getState();
    if (!Object.prototype.hasOwnProperty.call(state.workflowAgentLogs, key) && !state.workflowAgentHistoryLoading[key]) {
      loadAgentHistory(workerId, run.taskId, agent.agentId);
    }
  };
  const warning = run.warning === "limited-visibility"
    ? t("workflowActivity.limitedVisibility")
    : run.warning === "partial-data"
      ? t("workflowActivity.partialData")
      : null;
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-ink/40">
      <div className="space-y-1.5 border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg" title={run.workflowName}>{run.workflowName || t("workflowActivity.taskFallbackName")}</span>
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-meta", statusTone(run.status).text)}>
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusTone(run.status).dot)} aria-hidden />
            {t(`workflowActivity.${run.status}`)}
          </span>
          <span className="shrink-0 text-meta text-muted">{timeLabel(run.lastActivityAt, Date.now(), locale, t)}</span>
        </div>
        <div className="font-mono text-meta tabular-nums text-muted">
          {t("workflowActivity.activeCount", { count: run.counts.active })}
          {" · "}{t("workflowActivity.completedCount", { count: run.counts.completed })}
          {" · "}{t("workflowActivity.startedCount", { count: run.counts.started })}
          {run.counts.stopped > 0 && <>{" · "}{t("workflowActivity.stoppedCount", { count: run.counts.stopped })}</>}
        </div>
        {(run.summary || run.lastToolName) && <div className="truncate text-meta text-fg-dim" title={run.summary || run.lastToolName}>{run.summary || `${t("workflowActivity.latest")}: ${run.lastToolName}`}</div>}
        {warning && <div className="flex items-center gap-1.5 text-meta text-nochg"><AlertTriangle size={12} /> {warning}</div>}
      </div>
      {run.visibility === "live" && (run.agents.length > 0 || hasPhaseMetadata) && (
        <div className="space-y-1 p-2">
          {hasPhaseMetadata ? phaseGroups.map((group) => (
            <PhaseSection key={group.key} taskId={run.taskId} group={group} selectedKey={selectedKey} expanded={expanded} toggle={toggle} onSelect={select} />
          )) : <>
          {active.length > 0 && (
            <>
              <div className="px-1 py-1 text-meta font-medium text-muted">{t("workflowActivity.activeAgents", { count: active.length })}</div>
              <AgentRoster taskId={run.taskId} agents={active} selectedKey={selectedKey} onSelect={select} />
            </>
          )}
          {completed.length > 0 && (
            <>
              <button type="button" onClick={() => toggle("completed")} className="flex w-full items-center gap-1 px-1 py-1 text-left text-meta font-medium text-muted hover:text-fg-dim">
                <ChevronRight size={12} className={cn("transition-transform motion-reduce:transition-none", completedOpen && "rotate-90")} /> {t("workflowActivity.completedAgents", { count: completed.length })}
              </button>
              {completedOpen && <AgentRoster taskId={run.taskId} agents={completed} selectedKey={selectedKey} onSelect={select} />}
            </>
          )}
          {stopped.length > 0 && (
            <>
              <button type="button" onClick={() => toggle("stopped")} className="flex w-full items-center gap-1 px-1 py-1 text-left text-meta font-medium text-muted hover:text-fg-dim">
                <ChevronRight size={12} className={cn("transition-transform motion-reduce:transition-none", stoppedOpen && "rotate-90")} /> {t("workflowActivity.stoppedAgents", { count: stopped.length })}
              </button>
              {stoppedOpen && <AgentRoster taskId={run.taskId} agents={stopped} selectedKey={selectedKey} onSelect={select} />}
            </>
          )}
          </>}
        </div>
      )}
      {selectedBelongs && (
        <div className="border-t border-line">
          <div className="px-3 py-1.5 text-meta font-medium text-muted">{t("workflowActivity.selectedAgent")}</div>
          {loading && <div className="px-3 pb-3 text-meta text-muted">{t("workflowActivity.historyLoading")}</div>}
          {failed && <div className="px-3 pb-3 text-meta text-fail">{t("workflowActivity.historyFailed")}</div>}
          {selectedLog && !loading && !failed && <div className="flex h-72 min-h-0 flex-col"><MessageList kind="worker" items={selectedLog} /></div>}
        </div>
      )}
    </section>
  );
}

export function WorkflowRuns({ workerId, loadAgentHistory }: WorkflowRunsProps): JSX.Element | null {
  const t = useT();
  const runsById = useStore((state) => state.workflows[workerId] ?? EMPTY_RUNS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const runs = useMemo(() => {
    const rank: Record<WorkflowRunSnapshot["status"], number> = { running: 0, failed: 1, stopped: 2, completed: 3 };
    return Object.values(runsById).sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivityAt - a.lastActivityAt);
  }, [runsById]);
  if (runs.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-1.5 px-1 pt-1 text-ui font-medium text-fg-dim">
        <span>{t("workflowActivity.workflows")}</span>
        <span className="font-mono text-faint">{runs.length}</span>
      </div>
      {runs.map((run) => (
        <WorkflowRun key={run.taskId} workerId={workerId} run={run} selectedKey={selectedKey} setSelectedKey={setSelectedKey} loadAgentHistory={loadAgentHistory} />
      ))}
    </div>
  );
}
