import { memo, useRef, useState } from "react";
import { ChevronRight, Archive, Pin, Trash2 } from "lucide-react";
import { cn } from "../lib/cn.js";
import { ContextMenu } from "../components/ContextMenu.js";
import { Collapse } from "../components/Collapse.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { useSegmentIndicator } from "../lib/useSegmentIndicator.js";
import { useT } from "../i18n/provider.js";
import type { TFunc } from "../i18n/provider.js";

type Session = { id: string; cwd: string; status: string; lastActivity: string; origin: string; originRef?: string | null; label?: string | null; archived?: boolean; pinned?: boolean };
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
// so it sits after a divider + smaller, dimmer text (no count) to drop it down one level in the hierarchy.
function SourceSegment(p: { sources: Array<Exclude<SourceKind, "all">>; counts: Record<SourceKind, number>; current: SourceKind; onPick: (k: SourceKind) => void; t: TFunc }): JSX.Element {
  const seg = useSegmentIndicator(p.current, [p.sources.length]); // coral underline sliding across the source tabs
  return (
    <div ref={seg.containerRef} role="tablist" className="relative flex items-center gap-1 px-2 pb-1.5 pt-1">
      {seg.rect && (
        <div
          className="pointer-events-none absolute bottom-0.5 h-[2px] rounded-full bg-accent transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
          style={{ left: seg.rect.left, width: seg.rect.width }}
        />
      )}
      {p.sources.map((k) => (
        <button
          key={k}
          data-seg={k}
          role="tab"
          aria-selected={p.current === k}
          onClick={() => p.onPick(k)}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] transition-colors",
            p.current === k ? "bg-accent/15 text-fg" : "text-muted hover:bg-raised hover:text-fg-dim",
          )}
        >
          {p.t(SOURCE_LABEL_KEY[k])}
          <span className="ml-1 text-fg-dim/50">{p.counts[k]}</span>
        </button>
      ))}
      <span className="mx-0.5 h-3 w-px shrink-0 bg-line/60" aria-hidden />
      <button
        role="tab"
        aria-selected={p.current === "all"}
        onClick={() => p.onPick("all")}
        className={cn(
          "rounded px-1.5 py-0.5 text-[10px] transition-colors",
          p.current === "all" ? "text-fg-dim" : "text-fg-dim/40 hover:text-fg-dim",
        )}
      >
        {p.t("sessions.sourceAll")}
      </button>
    </div>
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

const sessName = (s: Session): string => s.label || s.cwd.split("/").pop() || s.id;

function SessionsImpl(p: {
  sessions: Session[];
  activeId: string | null;
  loaded?: boolean; // session list has arrived from the daemon → only then is an empty list really "no sessions" (avoids the cold-connect false-empty flash)
  onSelect: (id: string) => void;
  running?: Record<string, boolean>; // sessions with a master turn in progress → live pulse dot
  attention?: Record<string, boolean>; // sessions whose turn finished while unseen → right-side unread dot
  onRename?: (id: string, label: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onDelete?: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void; // pin toggle (hover button)
  automations?: AutomationLite[]; // for resolving automation group header names
  filter?: SourceFilter; // source segment state (external = held by store → set by AutomationPage cross-link)
  onFilter?: (f: SourceFilter) => void;
}): JSX.Element {
  const t = useT();
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
  const visible = focusedAuto ? sourceFiltered.filter((s) => s.originRef === filter.automationId) : sourceFiltered;
  // Pinned sessions go into the top 'Pinned' section (within the current source view). The rest stay in the existing groups (date/automation).
  const pinnedItems = [...visible.filter((s) => s.pinned)].sort(byActivityDesc);
  const rest = visible.filter((s) => !s.pinned);

  const archived = p.sessions.filter((s) => s.archived && (effectiveSource === "all" || srcOf(s.origin) === effectiveSource));

  const Row = (s: Session): JSX.Element => {
    const name = sessName(s);
    const isActive = s.id === p.activeId;
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
            className="w-full rounded-md border border-accent/60 bg-ink px-2 py-1.5 text-[13px] text-fg outline-none"
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
            "relative flex w-full items-center gap-2 rounded-lg py-2 pl-3 pr-2.5 text-left text-[13px] transition-colors",
            isActive ? "bg-accent/15 text-fg" : "text-fg-dim hover:bg-raised hover:text-fg",
          )}
        >
          <span className={cn("absolute left-0.5 top-2 bottom-2 w-[2.5px] rounded-full transition-colors duration-200", isActive ? "bg-accent" : s.status === "active" ? "bg-pr/70" : "bg-stop")} />
          {/* master turn in progress = live pulse (same signature as the worker tree) */}
          {p.running?.[s.id] && <span title={t("sessions.workingDot")} className="h-1.5 w-1.5 shrink-0 rounded-full bg-run led-live" />}
          <span className={cn("min-w-0 flex-1 truncate", p.attention?.[s.id] && !isActive && "font-semibold text-fg")}>{name}</span>
          {/* right-side indicators (badge/unread) yield space to the action buttons on hover. The badge only shows in 'All' (tabs already indicate the source). */}
          {effectiveSource === "all" && <span className="shrink-0 transition-opacity group-hover:opacity-0"><OriginBadge origin={s.origin} /></span>}
          {p.attention?.[s.id] && !isActive && <span title={t("sessions.unreadDot")} className="dot-pop h-2 w-2 shrink-0 rounded-full bg-run transition-opacity group-hover:opacity-0" />}
        </button>
        {/* hover actions (Pin / delete) — a 'sibling' of the main button (no nested buttons), absolutely positioned on the right. Shown only on group-hover. */}
        {(p.onPin || p.onDelete) && (
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
          </div>
        )}
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

      {(p.loaded ?? true) && p.sessions.length === 0 && <div className="px-2 py-3 text-[12px] leading-relaxed text-muted">{t("sessions.empty")}</div>}

      {pinnedItems.length > 0 && (
        <div>
          <div className="eyebrow flex items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted">
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
              <div className="eyebrow flex items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted">
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
            <div className="eyebrow px-2.5 pb-1 pt-2.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted">{g.label}</div>
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
            { label: menuSession.archived ? t("sessions.unarchive") : t("sessions.archive"), onClick: () => p.onArchive?.(menu.id, !menuSession.archived) },
            { label: t("sessions.deleteEllipsis"), danger: true, onClick: () => setConfirm({ id: menu.id, name: sessName(menuSession) }) },
          ]}
        />
      )}

      {confirm && (
        <DeleteConfirm
          name={confirm.name}
          onCancel={() => setConfirm(null)}
          onConfirm={() => p.onDelete?.(confirm.id)}
        />
      )}
    </div>
  );
}

export const Sessions = memo(SessionsImpl);
Sessions.displayName = "Sessions";

// Destructive delete confirm. Extracted so it mounts/unmounts with the `confirm` state → useDismissTransition resets per open
// and the dialog plays a symmetric enter/exit (the old inline version cut out instantly). Escape/backdrop cancel; Cancel is autofocused (safe default).
function DeleteConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onCancel);
  const confirmAndClose = (): void => { onConfirm(); dismiss(); };
  useModalKeys(dismiss, confirmAndClose);
  useFocusTrap(panelRef);
  return (
    <div className={cn("fixed inset-0 z-[110] flex items-center justify-center bg-black/55 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]")} onClick={dismiss}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("sessions.deleteTitle")} className={cn("w-[360px] rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]")} onClick={(e) => e.stopPropagation()}>
        <div className="mb-1.5 text-[14px] font-semibold">{t("sessions.deleteTitle")}</div>
        <p className="text-[12.5px] leading-relaxed text-muted">
          <span className="text-fg-dim">{name}</span> {t("sessions.deleteBody")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button autoFocus onClick={dismiss} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-muted hover:bg-raised hover:text-fg-dim">{t("common.cancel")}</button>
          <button onClick={confirmAndClose} className="rounded-lg bg-fail/90 px-3 py-1.5 text-[12.5px] font-medium text-fg hover:bg-fail">{t("common.delete")}</button>
        </div>
      </div>
    </div>
  );
}

function ArchivedSection({ items, render }: { items: Session[]; render: (s: Session) => JSX.Element }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button onClick={() => setOpen((v) => !v)} className="eyebrow flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted hover:text-fg-dim">
        <ChevronRight size={11} className={cn("transition-transform duration-200 ease-out motion-reduce:transition-none", open && "rotate-90")} />
        <Archive size={11} /> {t("sessions.archivedSection", { count: items.length })}
      </button>
      <Collapse open={open}><div className="opacity-80">{items.map(render)}</div></Collapse>
    </div>
  );
}
