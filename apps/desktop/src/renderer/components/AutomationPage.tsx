import { useEffect, useRef, useState } from "react";
import { Clock, X, Play, Pencil, Trash2, Plus, History, Loader2 } from "lucide-react";
import type { Automation, AutomationTrigger } from "@daemon/persistence/repositories.js";
import type { ActionVars } from "@daemon/core/automation-action.js";
import { useT } from "../i18n/provider.js";
import type { TFunc } from "../i18n/provider.js";
import { Button } from "../ui/button.js";
import { SkeletonRows } from "./Skeleton.js";
import { cn } from "../lib/cn.js";
import { referencedVars } from "../lib/automation-vars.js";
import { RunAutomationDialog } from "./RunAutomationDialog.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";

// Resolved Slack id → display name maps (audit #51). Missing entries fall back to the raw id — this is the
// pre-existing behavior, so a slow/failed/disconnected resolution never blocks or breaks the card.
export interface SlackRefNames {
  channels: Record<string, string>;
  users: Record<string, string>;
}
const EMPTY_SLACK_NAMES: SlackRefNames = { channels: {}, users: {} };

// Trigger badge text — for cron, the cron expression; for slack, a filter summary (channels/keyword, or "slack: all" when empty).
// channel/user ids are rendered as their resolved name when known (names), otherwise the raw id (unchanged from before #51).
function triggerBadge(trigger: AutomationTrigger, t: TFunc, names: SlackRefNames = EMPTY_SLACK_NAMES): string {
  if (trigger.kind === "cron") return `${trigger.cron} · ${trigger.timezone}`;
  // 'once' (agent self-wakeup) is not sent to the UI list by the backend, but handle it for union safety.
  if (trigger.kind === "once") return `once · ${trigger.runAt}`;
  const parts: string[] = [];
  if (trigger.channels?.length) parts.push(trigger.channels.map((id) => `#${names.channels[id] ?? id}`).join(","));
  if (trigger.keyword) parts.push(`"${trigger.keyword}"`);
  if (trigger.fromUsers?.length) parts.push(trigger.fromUsers.map((id) => `@${names.users[id] ?? id}`).join(","));
  return parts.length ? `slack: ${parts.join(" ")}` : t("automationPage.slackAll");
}

export function AutomationPage(p: {
  onClose?: () => void;
  automations: Automation[];
  loaded?: boolean; // automation.list has arrived from the daemon → gates the empty copy the same way Sessions/RepoTree do (audit #14)
  loadFailed?: boolean; // the initial fetch was rejected and hasn't succeeded since → error+retry row instead of a false "no jobs" empty state
  onRetry?: () => void; // re-fires automation.list (cleared by the store once it succeeds)
  onRun: (id: string, vars?: ActionVars) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => void;
  onEdit: (job: Automation) => void;
  onNew: () => void;
  onViewSessions?: (id: string) => void; // Jump to this automation's run sessions (history) — Sessions automation filter.
  // Best-effort Slack channel/user id → name resolution (audit #51). Absent (e.g. tests) → cards keep showing raw ids,
  // matching the daemon's own fallback when Slack is unconfigured/off/disconnected or a lookup fails.
  onResolveSlackRefs?: (channels: string[], users: string[]) => Promise<SlackRefNames>;
}): JSX.Element {
  const t = useT();
  // Resolved-name cache for the lifetime of this page mount — ids already requested (resolved or not) are never
  // re-requested just because the automations list re-rendered (e.g. after a toggle/lastStatus update).
  const [slackNames, setSlackNames] = useState<SlackRefNames>(EMPTY_SLACK_NAMES);
  const requested = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!p.onResolveSlackRefs) return;
    const channelIds = new Set<string>();
    const userIds = new Set<string>();
    for (const a of p.automations) {
      if (a.trigger.kind !== "slack") continue;
      for (const c of a.trigger.channels ?? []) channelIds.add(c);
      for (const u of a.trigger.fromUsers ?? []) userIds.add(u);
    }
    const channels = [...channelIds].filter((id) => !requested.current.has(`c:${id}`));
    const users = [...userIds].filter((id) => !requested.current.has(`u:${id}`));
    if (!channels.length && !users.length) return;
    for (const id of channels) requested.current.add(`c:${id}`);
    for (const id of users) requested.current.add(`u:${id}`);
    // Best-effort, never blocks the card list: on rejection the ids above stay unresolved → raw-id fallback in triggerBadge.
    p.onResolveSlackRefs(channels, users)
      .then((res) => setSlackNames((prev) => ({ channels: { ...prev.channels, ...res.channels }, users: { ...prev.users, ...res.users } })))
      .catch(() => {});
  }, [p.automations, p.onResolveSlackRefs]);
  const [runTarget, setRunTarget] = useState<Automation | null>(null);
  // Delete is destructive (no undo) — gate the trash icon behind a confirm dialog (audit #20), mirroring the
  // session/worker delete-confirm pattern (Sessions.tsx/RepoTree.tsx).
  const [confirmDelete, setConfirmDelete] = useState<Automation | null>(null);
  const actionText = (a: Automation): string => a.action.kind === "master" ? a.action.prompt : a.action.task;
  // Run-now: keep the Play button spinning (and disabled) until the request resolves — immediate feedback + blocks the
  // double-fire that actually double-executes (manual/Slack runs aren't overlap-guarded).
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const run = async (id: string, vars?: ActionVars): Promise<void> => {
    setRunning((r) => ({ ...r, [id]: true }));
    try { await p.onRun(id, vars); } finally { setRunning((r) => { const n = { ...r }; delete n[id]; return n; }); }
  };
  // Enable toggle: optimistically reflect the new value so the checkbox doesn't visibly snap back to the old one until the
  // automation.changed refetch lands. Cleared once the server state catches up; reverted if the request fails.
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setPendingEnabled((o) => {
      let changed = false; const n = { ...o };
      for (const a of p.automations) if (a.id in n && n[a.id] === a.enabled) { delete n[a.id]; changed = true; }
      return changed ? n : o;
    });
  }, [p.automations]);
  const toggle = (id: string, enabled: boolean): void => {
    setPendingEnabled((o) => ({ ...o, [id]: enabled }));
    void p.onToggle(id, enabled).catch(() => setPendingEnabled((o) => { const n = { ...o }; delete n[id]; return n; }));
  };
  return (
    <>
      <div className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-5 text-[13px]">
        <span className="font-semibold tracking-[-0.01em]">{t("automationPage.title")}</span>
        <Button variant="outline" size="sm" className="no-drag ml-auto" onClick={p.onNew}><Plus size={14} /> {t("automationPage.newJob")}</Button>
        {p.onClose && (
          <button onClick={p.onClose} aria-label={t("common.close")} className="no-drag rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg-dim"><X size={16} /></button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {!(p.loaded ?? true) ? (
            p.loadFailed ? (
              <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                <p className="text-[12.5px] text-fail">{t("automationPage.loadFailed")}</p>
                <button onClick={p.onRetry} className="rounded-md border border-line px-3 py-1 text-[12px] text-muted hover:bg-raised hover:text-fg-dim">{t("common.retry")}</button>
              </div>
            ) : (
              <SkeletonRows rows={5} />
            )
          ) : p.automations.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-muted">
              <Clock size={30} className="opacity-40" />
              <p className="text-[12.5px]">{t("automationPage.empty")}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {p.automations.map((a) => (
                <div key={a.id} className="flex items-center gap-3 rounded-[var(--radius)] border border-line bg-ink/40 px-3 py-2.5">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", a.lastStatus === "running" ? "bg-run led-live" : a.lastStatus === "ok" ? "bg-pr" : a.lastStatus === "error" ? "bg-fail" : "bg-stop")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg">{a.name}</span>
                      <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] text-muted">{a.action.kind === "master" ? t("automationPage.typeMaster") : t("automationPage.typeWorker")}</span>
                      {a.corrupt && <span className="shrink-0 rounded-full border border-fail px-1.5 py-0.5 text-[10px] text-fail">{t("automationPage.corrupt")}</span>}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted">
                      {triggerBadge(a.trigger, t, slackNames)}
                      {a.trigger.kind === "cron" && <> · {t("automationPage.nextRun")}: {a.nextRunAt ?? t("automationPage.never")}</>}
                    </div>
                  </div>
                  <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
                    <input type="checkbox" className="accent-accent" checked={pendingEnabled[a.id] ?? a.enabled} onChange={(e) => toggle(a.id, e.target.checked)} />
                    {t("automationPage.enabled")}
                  </label>
                  {p.onViewSessions && <button title={t("automationPage.viewSessions")} onClick={() => p.onViewSessions!(a.id)} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg-dim"><History size={14} /></button>}
                  <button title={t("automationPage.run")} disabled={!!running[a.id]} onClick={() => { referencedVars(actionText(a)).length ? setRunTarget(a) : void run(a.id); }} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg-dim disabled:opacity-40">{running[a.id] ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}</button>
                  <button title={t("automationPage.edit")} onClick={() => p.onEdit(a)} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg-dim"><Pencil size={14} /></button>
                  <button title={t("automationPage.delete")} onClick={() => setConfirmDelete(a)} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg-dim"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {runTarget && (
        <RunAutomationDialog
          automation={runTarget}
          onClose={() => setRunTarget(null)}
          onRun={(vars) => { void run(runTarget.id, vars); setRunTarget(null); }}
        />
      )}
      {confirmDelete && (
        <AutomationDeleteConfirm
          name={confirmDelete.name}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => p.onDelete(confirmDelete.id)}
        />
      )}
    </>
  );
}

// Destructive delete confirm (no undo). Extracted so it mounts/unmounts with `confirmDelete` → useDismissTransition
// resets per open and plays a symmetric enter/exit; Escape/cancel button cancel; Cancel autofocused (safe default).
function AutomationDeleteConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onCancel);
  const confirmAndClose = (): void => { onConfirm(); dismiss(); };
  useModalKeys(dismiss, confirmAndClose);
  useFocusTrap(panelRef);
  return (
    <div className={cn("fixed inset-0 z-[110] flex items-center justify-center bg-black/55 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]")}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("automationPage.deleteConfirmTitle")} className={cn("w-[360px] rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]")}>
        <div className="mb-1.5 text-[14px] font-semibold">{t("automationPage.deleteConfirmTitle")}</div>
        <p className="text-[12.5px] leading-relaxed text-muted">{t("automationPage.deleteConfirmBody", { name })}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button autoFocus onClick={dismiss} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-muted hover:bg-raised hover:text-fg-dim">{t("common.cancel")}</button>
          <button onClick={confirmAndClose} className="rounded-lg bg-fail/90 px-3 py-1.5 text-[12.5px] font-medium text-fg hover:bg-fail">{t("common.delete")}</button>
        </div>
      </div>
    </div>
  );
}
