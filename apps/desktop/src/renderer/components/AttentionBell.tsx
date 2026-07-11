import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Zap, CircleAlert, Eye, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store/store.js";
import { useAcksStore } from "../store/acks.js";
import { buildAttentionItems, type AttentionItem, type AttentionNav } from "../lib/attention-queue.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";

// Header bell: the single ranked "지금 나를 기다리는 것" surface (attention-queue design).
// Tier 0 (blocked on a human answer) drives the urgent badge tone; clicking a row navigates to it.
// Dismissal routes by kind: failures → persisted ack (acks store), review items → flip the live unread map.
export function AttentionBell(p: { onNavigate: (nav: AttentionNav) => void }): JSX.Element {
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
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const toggle = (): void => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Fixed positioning (the sidebar clips absolutely-positioned children); clamp to the viewport.
      setPos({ top: r.bottom + 6, left: Math.min(r.left, Math.max(8, window.innerWidth - 336)) });
    }
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    const click = (e: MouseEvent): void => {
      if (panelRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", esc);
    window.addEventListener("mousedown", click);
    return () => { window.removeEventListener("keydown", esc); window.removeEventListener("mousedown", click); };
  }, [open]);

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
    kind === "interaction" ? <Zap size={13} className="text-accent" />
    : kind === "worker-failure" || kind === "automation-failure" ? <CircleAlert size={13} className="text-fail" />
    : <Eye size={13} className="text-muted" />;

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        aria-label={t("attentionBell.aria", { count: items.length })}
        aria-expanded={open}
        className={cn("no-drag relative rounded-md p-1.5 transition-colors", open ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised hover:text-fg-dim")}
      >
        <Bell size={16} />
        {items.length > 0 && (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-0.5 text-[9.5px] font-bold leading-none",
              urgent > 0 ? "bg-accent text-white" : "bg-raised text-muted ring-1 ring-line",
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
          aria-label={t("attentionBell.title")}
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-[90] w-[328px] rounded-xl border border-line bg-surface p-1.5 shadow-xl"
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{t("attentionBell.title")}</div>
          {items.length === 0 ? (
            <div className="px-2.5 pb-3 pt-1 text-[12.5px] text-muted">{t("attentionBell.empty")}</div>
          ) : (
            <div className="max-h-[420px] overflow-y-auto">
              {tiers.map(({ tier, title, rows }) =>
                rows.length === 0 ? null : (
                  <div key={tier}>
                    <div className={cn("px-2.5 pb-0.5 pt-2 text-[10.5px] font-medium uppercase tracking-[0.08em]", tier === 0 ? "text-accent" : tier === 1 ? "text-fail" : "text-muted")}>{title}</div>
                    {rows.map((it) => (
                      <div key={it.key} className="group flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-raised">
                        <button onClick={() => go(it)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                          {icon(it.kind)}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] text-fg-dim">{it.label}</span>
                            <span className="block truncate text-[11px] text-muted">
                              {t(`attentionBell.kind_${it.kind}`)}{it.detail ? ` · ${it.detail}` : ""}
                            </span>
                          </span>
                        </button>
                        {it.dismissible && (
                          <button
                            onClick={() => dismiss(it)}
                            aria-label={t("attentionBell.dismiss")}
                            className="rounded p-0.5 text-muted opacity-0 transition-opacity hover:bg-ink/60 hover:text-fg-dim group-hover:opacity-100"
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
