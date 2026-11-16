import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { rovingIndex, useReturnFocusOnClose } from "../lib/focus.js";
import { Bell, BellOff, Zap, CircleAlert, Eye, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store/store.js";
import { useAcksStore } from "../store/acks.js";
import { buildAttentionItems, type AttentionItem, type AttentionNav } from "../lib/attention-queue.js";
import { cn } from "../lib/cn.js";
import { MENU_SURFACE } from "../lib/ui-tokens.js";
import { useT } from "../i18n/provider.js";

interface TriggerRect {
  left: number;
  top: number;
  bottom: number;
}

interface ViewportRect {
  width: number;
  height: number;
}

export type AttentionPanelPosition = { left: number; top?: number; bottom?: number };

const PANEL_WIDTH_WITH_GUTTER = 336;
const PANEL_MAX_HEIGHT = 452;
const VIEWPORT_GUTTER = 8;
const TRIGGER_GAP = 6;

export function attentionPanelPosition(rect: TriggerRect, viewport: ViewportRect): AttentionPanelPosition {
  const left = Math.max(
    VIEWPORT_GUTTER,
    Math.min(rect.left, Math.max(VIEWPORT_GUTTER, viewport.width - PANEL_WIDTH_WITH_GUTTER)),
  );
  const usablePanelHeight = Math.min(PANEL_MAX_HEIGHT, viewport.height - VIEWPORT_GUTTER * 2);
  const top = rect.bottom + TRIGGER_GAP;
  if (top + usablePanelHeight <= viewport.height - VIEWPORT_GUTTER) return { left, top };
  return { left, bottom: Math.max(VIEWPORT_GUTTER, viewport.height - rect.top + TRIGGER_GAP) };
}

// Header bell: the single ranked "지금 나를 기다리는 것" surface (attention-queue design).
// Tier 0 (blocked on a human answer) drives the urgent badge tone; clicking a row navigates to it.
// Dismissal routes by kind: failures → persisted ack (acks store), review items → flip the live unread map.
// It also hosts the OS-notification toggle (audit #20: one bell, not two) — the glyph turns into a muted bell while
// notifications are off. `variant="statusbar"` is the 20px status-bar trigger.
export function AttentionBell(p: { onNavigate: (nav: AttentionNav) => void; notifyOn?: boolean; onToggleNotify?: () => void; variant?: "header" | "statusbar" }): JSX.Element {
  const t = useT();
  const s = useStore(
    useShallow((st) => ({
      logsBySession: st.logsBySession,
      liveInteractionIds: st.liveInteractionIds,
      fleet: st.fleet,
      automations: st.automations,
      attention: st.attention,
      sessionAttention: st.sessionAttention,
      sessions: st.sessions,
      activeSessionId: st.activeSessionId,
      activeWorkerId: st.activeWorkerId,
      overlay: st.overlay,
      clearAttention: st.clearAttention,
      clearSessionAttention: st.clearSessionAttention,
    })),
  );
  const acked = useAcksStore((a) => a.acked);
  const ack = useAcksStore((a) => a.ack);
  const prune = useAcksStore((a) => a.prune);

  const { items, candidateKeys } = useMemo(
    () =>
      buildAttentionItems(
        {
          logsBySession: s.logsBySession,
          liveInteractionIds: s.liveInteractionIds,
          fleet: s.fleet,
          automations: s.automations,
          attention: s.attention,
          sessionAttention: s.sessionAttention,
          sessions: s.sessions,
          active: { sessionId: s.activeSessionId, workerId: s.activeWorkerId, overlay: s.overlay },
        },
        new Set(acked),
      ),
    [s, acked],
  );
  const urgent = items.filter((i) => i.tier === 0).length;

  // Opportunistic ack GC: drop persisted dismissals whose entity no longer produces a candidate key
  // (worker deleted, automation removed/re-run). Runs when the candidate set shrinks meaningfully.
  useEffect(() => {
    if (acked.some((k) => !candidateKeys.has(k))) prune(candidateKeys);
  }, [candidateKeys, acked, prune]);

  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<AttentionPanelPosition>({ top: 0, left: 0 });
  const toggle = (): void => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Fixed positioning (the sidebar clips absolutely-positioned children):
      // clamp horizontally and flip above bottom-rail triggers when needed.
      setPos(attentionPanelPosition(r, { width: window.innerWidth, height: window.innerHeight }));
    }
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
    const click = (e: MouseEvent): void => {
      if (panelRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", esc);
    window.addEventListener("mousedown", click);
    return () => { window.removeEventListener("keydown", esc); window.removeEventListener("mousedown", click); };
  }, [open]);
  // Focus (audit #75, same contract as ResourceMonitor #61): opening moves focus to the first item (or the panel when
  // empty) so a keyboard user lands in it; closing (Escape, picking an item) gives focus back to the bell.
  useEffect(() => {
    if (!open) return;
    (panelRef.current?.querySelector<HTMLElement>("[data-bell-item]") ?? panelRef.current)?.focus();
  }, [open]);
  useReturnFocusOnClose(open, btnRef, panelRef);
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-bell-item]") ?? []);
    const next = rovingIndex(e.key, rows.indexOf(document.activeElement as HTMLElement), rows.length);
    if (next === null) return;
    e.preventDefault();
    rows[next]?.focus();
  };

  const dismiss = (it: AttentionItem): void => {
    if (it.kind === "worker-review" && it.nav.workerId) s.clearAttention(it.nav.workerId);
    else if (it.kind === "session-review" && it.nav.sessionId) s.clearSessionAttention(it.nav.sessionId);
    else ack(it.key); // failures → persisted
  };
  const go = (it: AttentionItem): void => {
    setOpen(false);
    p.onNavigate(it.nav);
  };

  const tiers: Array<{ tier: 0 | 1 | 2; title: string; rows: AttentionItem[] }> = [
    { tier: 0, title: t("attentionBell.tier0"), rows: items.filter((i) => i.tier === 0) },
    { tier: 1, title: t("attentionBell.tier1"), rows: items.filter((i) => i.tier === 1) },
    { tier: 2, title: t("attentionBell.tier2"), rows: items.filter((i) => i.tier === 2) },
  ];
  const icon = (kind: AttentionItem["kind"]): JSX.Element =>
    kind === "interaction" ? <Zap size={14} className="text-accent" />
    : kind === "worker-failure" || kind === "automation-failure" ? <CircleAlert size={14} className="text-fail" />
    : <Eye size={14} className="text-muted" />;

  const muted = p.notifyOn === false;
  const statusbar = p.variant === "statusbar";
  const BellGlyph = muted ? BellOff : Bell;

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        aria-label={muted ? t("attentionBell.ariaMuted", { count: items.length }) : t("attentionBell.aria", { count: items.length })}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={muted ? t("attentionBell.titleMuted") : t("attentionBell.title")}
        className={cn(
          "no-drag relative flex items-center justify-center transition-colors",
          statusbar ? "h-5 w-5 rounded-sm" : "h-6 w-6 rounded-md",
          open ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg-dim",
        )}
      >
        <BellGlyph size={statusbar ? 12 : 14} />
        {items.length > 0 && (
          <span
            className={cn(
              "absolute flex items-center justify-center rounded-full px-0.5 text-meta font-medium leading-none",
              statusbar ? "-right-1 -top-1 h-[13px] min-w-[13px]" : "-right-0.5 -top-0.5 h-[15px] min-w-[15px]",
              urgent > 0 ? "bg-accent text-white" : "bg-line text-fg ring-1 ring-sunk",
            )}
          >
            {items.length > 99 ? "99+" : items.length}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
          aria-label={t("attentionBell.title")}
          onKeyDown={onPanelKeyDown}
          style={{ top: pos.top, left: pos.left }}
          className={cn("fixed z-[90] flex max-h-[calc(100vh-16px)] w-[328px] flex-col overflow-hidden focus:outline-none", MENU_SURFACE)}
        >
          <div className="flex items-center gap-2 px-2.5 pb-1 pt-1.5">
            <span className="min-w-0 flex-1 text-meta font-medium text-faint">{t("attentionBell.title")}</span>
            {p.onToggleNotify && (
              <button
                onClick={p.onToggleNotify}
                aria-pressed={!muted}
                title={muted ? t("app.notifyOffTitle") : t("app.notifyOnTitle")}
                className="no-drag flex shrink-0 items-center gap-1 rounded px-1 text-meta text-muted transition-colors hover:bg-raised hover:text-fg-dim"
              >
                <span>{t("attentionBell.notifyToggle")}</span>
                <span className={muted ? "text-faint" : "text-fg-dim"}>{muted ? t("attentionBell.notifyOffState") : t("attentionBell.notifyOnState")}</span>
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="px-2.5 pb-3 pt-1 text-ui text-muted">{t("attentionBell.empty")}</div>
          ) : (
            <div className="min-h-0 max-h-[420px] overflow-y-auto">
              {tiers.map(({ tier, title, rows }) =>
                rows.length === 0 ? null : (
                  <div key={tier}>
                    <div className={cn("px-2.5 pb-0.5 pt-2 text-meta font-medium", tier === 0 ? "text-accent" : tier === 1 ? "text-fail" : "text-faint")}>{title}</div>
                    {rows.map((it) => (
                      <div key={it.key} className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-raised">
                        <button data-bell-item onClick={() => go(it)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                          {icon(it.kind)}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body text-fg-dim">{it.label}</span>
                            <span className="block truncate text-meta text-muted">
                              {t(`attentionBell.kind_${it.kind}`)}{(() => { const d = it.detailKey ? t(it.detailKey) : it.detail; return d ? ` · ${d}` : ""; })()}
                            </span>
                          </span>
                        </button>
                        {it.dismissible && (
                          <button
                            onClick={() => dismiss(it)}
                            aria-label={t("attentionBell.dismiss")}
                            className="rounded p-0.5 text-muted opacity-0 transition-opacity hover:bg-ink/60 hover:text-fg-dim group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
