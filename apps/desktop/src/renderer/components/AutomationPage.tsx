import { useEffect, useRef, useState } from "react";
import { X, Play, Pencil, Trash2, Plus, MessagesSquare, Loader2 } from "lucide-react";
import type { Automation, AutomationTrigger } from "@daemon/persistence/repositories.js";
import type { ActionVars } from "@daemon/core/automation-action.js";
import { useLocale, useT } from "../i18n/provider.js";
import type { TFunc } from "../i18n/provider.js";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { SkeletonRows } from "./Skeleton.js";
import { LoadFailed, EmptyState } from "../ui/load-state.js";
import { ProviderBadge } from "./StatusBadge.js";
import { cn } from "../lib/cn.js";
import { referencedVars } from "../lib/automation-vars.js";
import { RunAutomationDialog } from "./RunAutomationDialog.js";
import { formatNextRun } from "../lib/relative-time.js";
import { usePageEscape } from "../lib/focus.js";
import { withShortcut } from "../lib/shortcuts.js";

// Resolved Slack id → display name maps (audit #51). Missing entries fall back to the raw id — this is the
// pre-existing behavior, so a slow/failed/disconnected resolution never blocks or breaks the card.
export interface SlackRefNames {
  channels: Record<string, string>;
  users: Record<string, string>;
}
const EMPTY_SLACK_NAMES: SlackRefNames = { channels: {}, users: {} };

// Trigger summary — for cron, the expression (+ its timezone); for slack/worker/once, a translated prefix (audit #53:
// these were hardcoded "slack: ", "worker: ", "once · ") followed by the filter summary. channel/user ids are
// rendered as their resolved name when known (names), otherwise the raw id (unchanged from before #51).
interface TriggerParts { prefix?: string; main: string; mono?: boolean; extra?: string }
function triggerParts(trigger: AutomationTrigger, t: TFunc, locale: string, names: SlackRefNames = EMPTY_SLACK_NAMES): TriggerParts {
  if (trigger.kind === "cron") return { main: trigger.cron, mono: true, extra: trigger.timezone };
  if (trigger.kind === "interval") return { main: t("automationPage.everyMinutes", { count: trigger.everyMinutes }) };
  // 'once' (agent self-wakeup) is not sent to the UI list by the backend, but handle it for union safety.
  if (trigger.kind === "once") return { prefix: t("automationPage.prefixOnce"), main: formatNextRun(trigger.runAt, Date.now(), locale) };
  if (trigger.kind === "worker") {
    const on = trigger.on && trigger.on.length > 0 ? trigger.on : ["stopped", "failure"];
    const wparts = [trigger.repo ?? t("automationPage.workerAllRepos"), on.map((b) => t(`automationPage.workerOn_${b}`)).join("/")];
    if (trigger.label) wparts.push(`"${trigger.label}"`);
    return { prefix: t("automationPage.prefixWorker"), main: wparts.join(", ") };
  }
  const parts: string[] = [];
  if (trigger.channels?.length) parts.push(trigger.channels.map((id) => `#${names.channels[id] ?? id}`).join(","));
  if (trigger.keyword) parts.push(`"${trigger.keyword}"`);
  if (trigger.fromUsers?.length) parts.push(trigger.fromUsers.map((id) => `@${names.users[id] ?? id}`).join(","));
  return { prefix: "Slack", main: parts.length ? parts.join(" ") : t("automationPage.slackAll") };
}

const ROW_ICON = "rounded-sm p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-hi disabled:opacity-40";

export function AutomationPage(p: {
  onClose?: () => void;
  automations: Automation[];
  loaded?: boolean; // automation.list has arrived from the daemon → gates the empty copy the same way Sessions/RepoTree do (audit #14)
  loadFailed?: boolean; // the initial fetch was rejected and hasn't succeeded since → error+retry row instead of a false "no jobs" empty state
  onRetry?: () => unknown; // re-fires automation.list (cleared by the store once it succeeds)
  onRun: (id: string, vars?: ActionVars) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => void | Promise<void>; // a rejection brings the optimistically removed row back
  onEdit: (job: Automation) => void;
  onNew: () => void;
  onViewSessions?: (id: string) => void; // Jump to this automation's run sessions (history) — Sessions automation filter.
  // Best-effort Slack channel/user id → name resolution (audit #51). Absent (e.g. tests) → cards keep showing raw ids,
  // matching the daemon's own fallback when Slack is unconfigured/off/disconnected or a lookup fails.
  onResolveSlackRefs?: (channels: string[], users: string[]) => Promise<SlackRefNames>;
}): JSX.Element {
  const t = useT();
  usePageEscape(p.onClose); // Escape closes the list like the header X (audit #129) — nothing here holds a draft
  const locale = useLocale();
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
    // Best-effort, never blocks the card list: on rejection the ids above stay unresolved → raw-id fallback in triggerParts.
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
  // Delete: the confirmed row leaves the list at once (audit #97) and comes back if the request fails.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const remove = (id: string): void => {
    setRemoved((cur) => new Set(cur).add(id));
    void Promise.resolve(p.onDelete(id)).catch(() => setRemoved((cur) => { const n = new Set(cur); n.delete(id); return n; }));
  };
  const visible = p.automations.filter((a) => !removed.has(a.id));
  const now = Date.now();
  // The next run is shown in the viewer's time; a cron that runs in another timezone gets the zone name appended so
  // "03:00" next to "0 3 * * * UTC" isn't read as the trigger's own time.
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center gap-2 px-4">
        <span className="text-body font-medium text-fg">{t("automationPage.title")}</span>
        <Button variant="outline" size="sm" className="no-drag ml-auto" onClick={p.onNew}><Plus size={14} /> {t("automationPage.newJob")}</Button>
        {p.onClose && (
          <Button variant="ghost" size="iconSm" className="no-drag" onClick={p.onClose} aria-label={t("common.close")} title={withShortcut(t("common.close"), "Esc")}><X size={14} /></Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {!(p.loaded ?? true) ? (
            p.loadFailed ? (
              <LoadFailed layout="stack" message={t("automationPage.loadFailed")} onRetry={() => p.onRetry?.()} />
            ) : (
              <SkeletonRows rows={5} />
            )
          ) : visible.length === 0 ? (
            <EmptyState layout="stack" action={{ label: t("automationPage.newJob"), onClick: p.onNew }}>{t("automationPage.empty")}</EmptyState>
          ) : (
            <div className="flex flex-col divide-y divide-line-soft border-y border-line">
              {visible.map((a) => {
                const enabled = pendingEnabled[a.id] ?? a.enabled;
                const trig = triggerParts(a.trigger, t, locale, slackNames);
                return (
                  // Calm row (audit #97): click opens the editor; Run and the on/off switch stay visible, the rest
                  // (runs, edit, delete) show on hover or keyboard focus.
                  <div key={a.id} className="group flex items-center gap-2 px-1 py-1.5">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", a.lastStatus === "running" ? "bg-run led-live" : !enabled ? "bg-faint" : a.lastStatus === "ok" ? "bg-pr" : a.lastStatus === "error" ? "bg-fail" : "bg-stop")} />
                    <button type="button" onClick={() => p.onEdit(a)} className="min-w-0 flex-1 rounded-sm px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-hi">
                      <span className="flex items-center gap-2">
                        <span className={cn("truncate text-body font-medium", enabled ? "text-fg" : "text-fg-dim")}>{a.name}</span>
                        <span className="shrink-0 text-meta text-muted">{a.action.kind === "master" ? t("automationPage.typeMaster") : t("automationPage.typeWorker")}</span>
                        <ProviderBadge provider={a.provider} />
                        {a.corrupt && <span className="shrink-0 text-meta text-fail">{t("automationPage.corrupt")}</span>}
                      </span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-meta text-muted">
                        {trig.prefix && <span className="shrink-0 text-fg-dim">{trig.prefix}</span>}
                        <span className={cn("min-w-0 truncate", trig.mono && "font-mono")}>{trig.main}</span>
                        {trig.extra && <span className="shrink-0">{trig.extra}</span>}
                        {(a.trigger.kind === "cron" || a.trigger.kind === "interval") && enabled && (
                          <>
                            <span className="h-3 w-px shrink-0 bg-line" aria-hidden />
                            <span className="shrink-0">
                              {t("automationPage.nextRun")}{" "}
                              {a.nextRunAt
                                ? <time dateTime={a.nextRunAt} title={new Date(a.nextRunAt).toLocaleString(locale)}>{formatNextRun(a.nextRunAt, now, locale, undefined, a.trigger.kind === "cron" && a.trigger.timezone !== viewerZone)}</time>
                                : t("automationPage.never")}
                            </span>
                          </>
                        )}
                      </span>
                    </button>
                    <div data-row-actions className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      {p.onViewSessions && <button type="button" title={t("automationPage.viewSessions")} aria-label={t("automationPage.viewSessionsFor", { name: a.name })} onClick={() => p.onViewSessions!(a.id)} className={ROW_ICON}><MessagesSquare size={14} /></button>}
                      <button type="button" title={t("automationPage.edit")} aria-label={t("automationPage.editFor", { name: a.name })} onClick={() => p.onEdit(a)} className={ROW_ICON}><Pencil size={14} /></button>
                      <button type="button" title={t("automationPage.delete")} aria-label={t("automationPage.deleteFor", { name: a.name })} onClick={() => setConfirmDelete(a)} className={cn(ROW_ICON, "hover:text-fail")}><Trash2 size={14} /></button>
                    </div>
                    <button type="button" title={t("automationPage.run")} aria-label={t("automationPage.runFor", { name: a.name })} disabled={!!running[a.id]} onClick={() => { referencedVars(actionText(a)).length ? setRunTarget(a) : void run(a.id); }} className={ROW_ICON}>{running[a.id] ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}</button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={t("automationPage.enabledFor", { name: a.name })}
                      title={enabled ? t("automationPage.enabledOn") : t("automationPage.enabledOff")}
                      onClick={() => toggle(a.id, !enabled)}
                      className={cn("relative ml-1 h-4 w-7 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-hi", enabled ? "bg-fg-dim" : "bg-line")}
                    >
                      <span className={cn("absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-ink transition-transform", enabled && "translate-x-3")} aria-hidden />
                    </button>
                  </div>
                );
              })}
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
        <ConfirmDialog
          title={t("automationPage.deleteConfirmTitle")}
          body={t("automationPage.deleteConfirmBody", { name: confirmDelete.name })}
          confirmLabel={t("common.delete")}
          variant="danger"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => remove(confirmDelete.id)}
        />
      )}
    </>
  );
}
