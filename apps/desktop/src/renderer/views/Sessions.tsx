import { memo, useRef, useState } from "react";
import { ChevronRight, Archive, Pin, Trash2, MoreHorizontal } from "lucide-react";
import { cn } from "../lib/cn.js";
import { ContextMenu } from "../components/ContextMenu.js";
import { ProviderBadge } from "../components/StatusBadge.js";
import { Collapse } from "../components/Collapse.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { baseName } from "../lib/path.js";
import { Segment, type SegmentItem } from "../ui/segment.js";
import { relativeTime, absoluteDate } from "../lib/relative-time.js";
import { useT, useLocale } from "../i18n/provider.js";
import type { TFunc } from "../i18n/provider.js";
import type { Locale } from "../i18n/types.js";

type Session = { id: string; cwd: string; status: string; lastActivity: string; origin: string; originRef?: string | null; label?: string | null; archived?: boolean; pinned?: boolean; provider?: string };
type SourceKind = "all" | "ui" | "slack" | "automation";
export type SourceFilter = { source: SourceKind; automationId?: string | null };
type AutomationLite = { id: string; name: string };

// Normalize origin into the 3 known sources (unknown values map to ui).
function srcOf(origin: string): Exclude<SourceKind, "all"> {
  return origin === "slack" || origin === "automation" ? origin : "ui";
}

function OriginBadge({ origin }: { origin: string }): JSX.Element {
  const s = srcOf(origin);
  const style =
    s === "slack" ? "border-nochg/30 bg-nochg/12 text-nochg"
    : s === "automation" ? "border-pr/30 bg-pr/12 text-pr"
    : "border-line bg-raised text-muted";
  const label = s === "slack" ? "slack" : s === "automation" ? "auto" : "ui";
  return <span className={cn("shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wide", style)}>{label}</span>;
}

const SOURCE_LABEL_KEY: Record<SourceKind, string> = {
  all: "sessions.sourceAll", ui: "sessions.sourceUi", slack: "sessions.sourceSlack", automation: "sessions.sourceAutomation",
};

// Source segment (tab-in-tab). Present sources = peer tabs (with counts). 'All' is not a peer but a "show everything",
// so it's a secondary tier item — it sits after a divider + smaller, dimmer text (no count) and outside the
// sliding indicator's tracking, to drop it down one level in the hierarchy (Segment's underline variant, audit #52).
function SourceSegment(p: { sources: Array<Exclude<SourceKind, "all">>; counts: Record<SourceKind, number>; current: SourceKind; onPick: (k: SourceKind) => void; t: TFunc }): JSX.Element {
  const items: Array<SegmentItem<SourceKind>> = [
    ...p.sources.map((k) => ({ value: k, label: p.t(SOURCE_LABEL_KEY[k]), count: p.counts[k] })),
    { value: "all" as const, label: p.t("sessions.sourceAll"), tier: "secondary" as const },
  ];
  return (
    <Segment
      items={items}
      value={p.current}
      onChange={p.onPick}
      variant="underline"
      className="gap-1 px-2 pb-1.5 pt-1"
      indicatorClassName="bottom-0.5"
    />
  );
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(d: Date, t: TFunc): string {
  const now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const k = dayKey(d);
  if (k === dayKey(now)) return t("sessions.today");
  if (k === dayKey(yest)) return t("sessions.yesterday");
  if (d.getFullYear() === now.getFullYear()) return t("sessions.monthDay", { month: d.getMonth() + 1, day: d.getDate() });
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

const byActivityDesc = (a: Session, b: Session): number => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0);

// Group by last-activity date — newest group on top, and within a group the newest session on top.
function groupByDay(sessions: Session[], t: TFunc): Array<{ key: string; label: string; items: Session[] }> {
  const sorted = [...sessions].sort(byActivityDesc);
  const groups: Array<{ key: string; label: string; items: Session[] }> = [];
  for (const s of sorted) {
    const d = new Date(s.lastActivity);
    const key = dayKey(d);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: dayLabel(d, t), items: [] };
      groups.push(g);
    }
    g.items.push(s);
  }
  return groups;
}

// Group by automation (per-automation run history) — the automation with the most recent run on top, and within a group the newest on top.
function groupByAutomation(sessions: Session[], automations: AutomationLite[], t: TFunc): Array<{ ref: string; name: string; items: Session[] }> {
  const byRef = new Map<string, Session[]>();
  for (const s of sessions) {
    const ref = s.originRef ?? "";
    const arr = byRef.get(ref);
    if (arr) arr.push(s);
    else byRef.set(ref, [s]);
  }
  return [...byRef.entries()]
    .map(([ref, items]) => ({
      ref,
      name: automations.find((a) => a.id === ref)?.name ?? t("sessions.deletedAutomation"),
      items: [...items].sort(byActivityDesc),
    }))
    .sort((a, b) => byActivityDesc(a.items[0]!, b.items[0]!));
}

const sessName = (s: Session): string => s.label || baseName(s.cwd) || s.id;
// A session has no explicit title → its name fell back to the cwd folder (or id). This is what makes the sidebar a
// wall of identical labels (audit #46, e.g. 'clover-space' x6) when several sessions share a working directory.
const isFallbackNamed = (s: Session): boolean => !s.label;

// Turn last-activity into a label that follows the app locale. Within 7 days, relative time (i18n); beyond that,
// absolute date. Same convention as GitHistory's commitDateLabel / AssistantMessage's timeLabel.
function activityLabel(ts: number, now: number, t: TFunc, locale: Locale): string {
  const rel = relativeTime(ts, now);
  if (!rel) return absoluteDate(ts, now, locale);
  if (rel.unit === "now") return t("relativeTime.justNow");
  if (rel.unit === "m") return t("relativeTime.minutesAgo", { n: rel.value });
  if (rel.unit === "h") return t("relativeTime.hoursAgo", { n: rel.value });
  return t("relativeTime.daysAgo", { n: rel.value });
}

function SessionsImpl(p: {
  sessions: Session[];
  activeId: string | null;
  loaded?: boolean; // session list has arrived from the daemon → only then is an empty list really "no sessions" (avoids the cold-connect false-empty flash)
  loadFailed?: boolean; // the initial fetch was rejected and hasn't succeeded since → show an error+retry row instead of staying blank forever (audit #14)
  onRetry?: () => void; // re-fires session.list (cleared by the store once it succeeds)
  onSelect: (id: string) => void;
  running?: Record<string, boolean>; // sessions with a master turn in progress → live pulse dot
  attention?: Record<string, boolean>; // sessions whose turn finished while unseen → right-side unread dot
  onRename?: (id: string, label: string) => void;
  onFork?: (id: string) => void; // right-click → fork this session (duplicate context into a new session)
  onArchive?: (id: string, archived: boolean) => void;
  onDelete?: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void; // pin toggle (hover button)
  automations?: AutomationLite[]; // for resolving automation group header names
  filter?: SourceFilter; // source segment state (external = held by store → set by AutomationPage cross-link)
  onFilter?: (f: SourceFilter) => void;
}): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [scrolled, setScrolled] = useState(false); // when not at the top, show a fade/blur below the header (scroll shadow)
  // List-arrival animation: seed with the sessions present at first non-empty load; only sessions that appear AFTER that
  // rise-in (avoids a flash-storm of the whole list on cold load / reconnect). Mirrors RepoTree/GitChanges.
  const seedRef = useRef<Set<string> | null>(null);
  if (seedRef.current === null && p.sessions.length > 0) seedRef.current = new Set(p.sessions.map((x) => x.id));
  const isFreshSession = (id: string): boolean => seedRef.current !== null && !seedRef.current.has(id);

  const filter = p.filter ?? { source: "all" as SourceKind };
  const active = p.sessions.filter((s) => !s.archived);

  // Source counts + present sources (to decide whether to show the segment).
  const counts: Record<SourceKind, number> = { all: active.length, ui: 0, slack: 0, automation: 0 };
  for (const s of active) counts[srcOf(s.origin)]++;
  const presentSources = (["ui", "slack", "automation"] as Array<Exclude<SourceKind, "all">>).filter((k) => counts[k] > 0);
  // If the desired source is empty (e.g. default ui but there are no ui sessions), fall back to the first present source → so an empty tab isn't shown by default.
  const effectiveSource: SourceKind =
    filter.source === "all" ? "all"
    : presentSources.includes(filter.source as Exclude<SourceKind, "all">) ? filter.source
    : (presentSources[0] ?? "all");
  // Only show the segment when there are 2 or more sources (nothing to split if there's only one).
  const showSegment = presentSources.length > 1;

  const sourceFiltered = effectiveSource === "all" ? active : active.filter((s) => srcOf(s.origin) === effectiveSource);
  // automationId focus (cross-link): only that automation's sessions.
  const focusedAuto = effectiveSource === "automation" && filter.automationId;
  const filtered = focusedAuto ? sourceFiltered.filter((s) => s.originRef === filter.automationId) : sourceFiltered;
  // The session you're currently viewing must never disappear from the sidebar just because the source filter (or
  // automation focus) would otherwise exclude it (audit #21) — otherwise there's no location highlight anywhere.
  const activeSession = p.activeId ? active.find((s) => s.id === p.activeId) : undefined;
  const visible = activeSession && !filtered.some((s) => s.id === p.activeId) ? [...filtered, activeSession] : filtered;
  // Pinned sessions go into the top 'Pinned' section (within the current source view). The rest stay in the existing groups (date/automation).
  const pinnedItems = [...visible.filter((s) => s.pinned)].sort(byActivityDesc);
  const rest = visible.filter((s) => !s.pinned);

  const archived = p.sessions.filter((s) => s.archived && (effectiveSource === "all" || srcOf(s.origin) === effectiveSource));

  const Row = (s: Session): JSX.Element => {
    const name = sessName(s);
    const isActive = s.id === p.activeId;
    // Only rows without an explicit title get the disambiguating subline — a real title is already distinguishing.
    const fallbackNamed = isFallbackNamed(s);
    if (renaming?.id === s.id) {
      return (
        <div key={s.id} className="px-1 py-1">
          <input
            autoFocus
            value={renaming.value}
            onChange={(e) => setRenaming({ id: s.id, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { p.onRename?.(s.id, renaming.value.trim() || name); setRenaming(null); }
              else if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={() => { p.onRename?.(s.id, renaming.value.trim() || name); setRenaming(null); }}
            className="w-full rounded-md border border-accent/60 bg-ink px-2 py-1 text-[12.5px] text-fg outline-none"
          />
        </div>
      );
    }
    return (
      <div key={s.id} className={cn("group relative", isFreshSession(s.id) && "rise-in")}>
        <button
          onClick={() => p.onSelect(s.id)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ id: s.id, x: e.clientX, y: e.clientY }); }}
          className={cn(
            // Row scale shared with RepoTree.tsx (audit #76) — one sidebar-list token set for both tabs.
            "relative flex w-full items-center gap-1.5 rounded-md py-1.5 pl-3 pr-2.5 text-left text-[12.5px] transition-colors",
            isActive ? "bg-accent/15 text-fg" : "text-fg-dim hover:bg-raised hover:text-fg",
          )}
        >
          <span className={cn("absolute left-0.5 top-1.5 bottom-1.5 w-[2.5px] rounded-full transition-colors duration-200", isActive ? "bg-accent" : s.status === "active" ? "bg-pr/70" : "bg-stop")} />
          {/* master turn in progress = live pulse (same signature as the worker tree) */}
          {p.running?.[s.id] && <span title={t("sessions.workingDot")} className="h-1.5 w-1.5 shrink-0 rounded-full bg-run led-live" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={cn("truncate", p.attention?.[s.id] && !isActive && "font-semibold text-fg")}>{name}</span>
            {/* fallback-named row (no explicit title) → a dim relative-time subline breaks the wall of identical
                folder-name labels (audit #46, secondary-text scope; auto-title from the first message is deferred). */}
            {fallbackNamed && <span className="truncate text-[10.5px] leading-tight text-muted/70">{activityLabel(new Date(s.lastActivity).getTime(), Date.now(), t, locale)}</span>}
          </span>
          {/* right-side indicators (badge/unread) yield space to the action buttons on hover. Provider badge shows in every
              view (codex-only; a mixed claude/codex list must be scannable at a glance); the origin badge only in 'All'. */}
          {s.provider === "codex" && <span className="shrink-0 transition-opacity group-hover:opacity-0"><ProviderBadge provider={s.provider} /></span>}
          {effectiveSource === "all" && <span className="shrink-0 transition-opacity group-hover:opacity-0"><OriginBadge origin={s.origin} /></span>}
          {p.attention?.[s.id] && !isActive && <span title={t("sessions.unreadDot")} className="dot-pop h-2 w-2 shrink-0 rounded-full bg-run transition-opacity group-hover:opacity-0" />}
        </button>
        {/* hover actions (Pin / More / delete) — a 'sibling' of the main button (no nested buttons), absolutely positioned on the right. Shown only on group-hover/focus.
            The '⋯' opens the SAME right-click menu, but reachable by left-click/Enter (audit #45: the menu was previously right-click-only, and macOS has no
            context-menu key for keyboard users). It's always rendered (unlike Pin/Delete) since it also carries Rename/Fork/Archive. */}
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {p.onPin && (
            <button
              title={s.pinned ? t("sessions.unpin") : t("sessions.pin")}
              onClick={(e) => { e.stopPropagation(); p.onPin!(s.id, !s.pinned); }}
              className={cn("rounded p-1 hover:bg-line/60", s.pinned ? "text-accent" : "text-muted hover:text-fg-dim")}
            >
              <Pin size={13} className={s.pinned ? "fill-current" : ""} />
            </button>
          )}
          {p.onDelete && (
            <button
              title={t("common.delete")}
              onClick={(e) => { e.stopPropagation(); setConfirm({ id: s.id, name }); }}
              className="rounded p-1 text-muted hover:bg-line/60 hover:text-fail"
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            title={t("common.moreActions")}
            aria-label={t("common.moreActions")}
            onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ id: s.id, x: r.left, y: r.bottom + 4 }); }}
            className="rounded p-1 text-muted opacity-0 transition-opacity hover:bg-line/60 hover:text-fg-dim group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
      </div>
    );
  };

  const menuSession = menu ? p.sessions.find((x) => x.id === menu.id) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}>
      {/* sticky header — the tab area is opaque (nothing shows through), and the thin frosted fade below it appears naturally only 'when not at the top'. */}
      {showSegment && (
        <div className="sticky top-0 z-10 bg-surface">
          <SourceSegment sources={presentSources} counts={counts} current={effectiveSource} onPick={(k) => p.onFilter?.({ source: k })} t={t} />
          <div className={cn("pointer-events-none absolute inset-x-0 top-full h-2.5 bg-gradient-to-b from-surface to-transparent backdrop-blur-sm transition-opacity duration-200", scrolled ? "opacity-100" : "opacity-0")} />
        </div>
      )}

      {!(p.loaded ?? true) && p.loadFailed ? (
        <div className="flex items-center justify-between gap-2 px-2 py-3 text-[12px] leading-relaxed">
          <span className="text-fail">{t("sessions.loadFailed")}</span>
          <button onClick={p.onRetry} className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-fg-dim">{t("common.retry")}</button>
        </div>
      ) : (
        (p.loaded ?? true) && p.sessions.length === 0 && <div className="px-2 py-3 text-[12px] leading-relaxed text-muted">{t("sessions.empty")}</div>
      )}

      {pinnedItems.length > 0 && (
        <div>
          <div className="eyebrow flex items-center gap-1.5 px-2.5 pb-1 pt-2.5 eyebrow-sm font-medium uppercase text-muted">
            <Pin size={10} className="shrink-0 fill-current opacity-70" />
            <span>{t("sessions.pinnedSection")}</span>
          </div>
          {pinnedItems.map(Row)}
        </div>
      )}

      {effectiveSource === "automation" ? (
        <>
          {focusedAuto && (
            <button onClick={() => p.onFilter?.({ source: "automation" })} className="px-2.5 pb-1 pt-1.5 text-left text-[11px] text-muted hover:text-fg-dim">
              {t("sessions.allAutomations")}
            </button>
          )}
          {groupByAutomation(rest, p.automations ?? [], t).map((g) => (
            <div key={g.ref}>
              <div className="eyebrow flex items-center gap-1.5 px-2.5 pb-1 pt-2.5 eyebrow-sm font-medium uppercase text-muted">
                <span className="min-w-0 truncate normal-case tracking-normal">{g.name}</span>
                <span className="shrink-0 text-fg-dim/50">{t("sessions.runs", { count: g.items.length })}</span>
              </div>
              {g.items.map(Row)}
            </div>
          ))}
        </>
      ) : (
        groupByDay(rest, t).map((g) => (
          <div key={g.key}>
            <div className="eyebrow px-2.5 pb-1 pt-2.5 eyebrow-sm font-medium uppercase text-muted">{g.label}</div>
            {g.items.map(Row)}
          </div>
        ))
      )}

      {archived.length > 0 && <ArchivedSection items={archived} render={Row} />}

      {menu && menuSession && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t("sessions.rename"), onClick: () => setRenaming({ id: menu.id, value: sessName(menuSession) }) },
            { label: t("sessions.fork"), onClick: () => p.onFork?.(menu.id) },
            { label: menuSession.archived ? t("sessions.unarchive") : t("sessions.archive"), onClick: () => p.onArchive?.(menu.id, !menuSession.archived) },
            { label: t("sessions.deleteEllipsis"), danger: true, onClick: () => setConfirm({ id: menu.id, name: sessName(menuSession) }) },
          ]}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={t("sessions.deleteTitle")}
          body={<><span className="text-fg-dim">{confirm.name}</span> {t("sessions.deleteBody")}</>}
          confirmLabel={t("common.delete")}
          variant="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => p.onDelete?.(confirm.id)}
        />
      )}
    </div>
  );
}

export const Sessions = memo(SessionsImpl);
Sessions.displayName = "Sessions";

function ArchivedSection({ items, render }: { items: Session[]; render: (s: Session) => JSX.Element }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button onClick={() => setOpen((v) => !v)} className="eyebrow flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2 eyebrow-sm font-medium uppercase text-muted hover:text-fg-dim">
        <ChevronRight size={11} className={cn("transition-transform duration-200 ease-out motion-reduce:transition-none", open && "rotate-90")} />
        <Archive size={11} /> {t("sessions.archivedSection", { count: items.length })}
      </button>
      <Collapse open={open}><div className="opacity-80">{items.map(render)}</div></Collapse>
    </div>
  );
}
