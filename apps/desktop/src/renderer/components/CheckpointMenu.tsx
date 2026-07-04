import { useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";
import { Button } from "../ui/button.js";
import { SkeletonRows } from "./Skeleton.js";
import { useT, useLocale } from "../i18n/provider.js";
import type { TFunc } from "../i18n/provider.js";
import type { Locale } from "../i18n/types.js";
import { relativeTime, absoluteDate } from "../lib/relative-time.js";

export interface Checkpoint { seq: number; sha: string; createdAt: string }

// Time-only hh:mm made cross-midnight turns look out of order (Turn 1 the evening before could read later than
// Turn 2 the next afternoon — audit #80). Reuse the same relative-time convention as AssistantMessage/GitHistory/
// Sessions: within 7 days it's monotonic relative text ("3h ago"), beyond that an absolute date — both unambiguous
// regardless of day boundaries, and both already localized (no new i18n keys needed).
function checkpointTimeLabel(iso: string, now: number, t: TFunc, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ts = d.getTime();
  const rel = relativeTime(ts, now);
  if (!rel) return absoluteDate(ts, now, locale);
  if (rel.unit === "now") return t("relativeTime.justNow");
  if (rel.unit === "m") return t("relativeTime.minutesAgo", { n: rel.value });
  if (rel.unit === "h") return t("relativeTime.hoursAgo", { n: rel.value });
  return t("relativeTime.daysAgo", { n: rel.value });
}

// Per-worker-turn checkpoint restore menu. Fetches on open; on item click, confirms then restores.
export function CheckpointMenu({
  fetchCheckpoints,
  onRestore,
}: {
  fetchCheckpoints: () => Promise<Checkpoint[]>;
  onRestore: (seq: number) => Promise<void>;
}): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Checkpoint[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [armed, setArmed] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  // Shared by the initial open-fetch and the error state's retry button.
  const load = (): void => {
    setItems(null);
    setLoadError(false);
    void fetchCheckpoints().then(setItems).catch(() => setLoadError(true));
  };

  const toggle = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setArmed(null);
    load();
  };
  // Escape closes the open menu.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={toggle} title={t("checkpointMenu.buttonTitle")} aria-haspopup="menu" aria-expanded={open}>
        <History size={13} /> {t("checkpointMenu.restore")}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="menu-pop absolute right-0 z-40 mt-1 max-h-72 w-64 origin-top-right overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl">
            <div className="px-2 py-1 text-[10.5px] leading-relaxed text-muted">
              {t("checkpointMenu.hint")}
            </div>
            {items === null && !loadError && <SkeletonRows rows={3} />}
            {loadError && (
              // The single "couldn't load" string doubles as the retry button's label (no dedicated retry key in the catalog).
              <button onClick={load} className="w-full rounded-md px-2 py-1.5 text-left text-[12px] text-fail hover:bg-fail/10">
                {t("checkpointMenu.loadFailed")}
              </button>
            )}
            {items !== null && items.length === 0 && <div className="px-2 py-1.5 text-[12px] text-muted">{t("checkpointMenu.empty")}</div>}
            {items?.map((c) => (
              <button
                key={c.seq}
                role="menuitem"
                disabled={restoring !== null}
                onClick={() => {
                  if (restoring !== null) return;
                  if (armed === c.seq) {
                    setRestoring(c.seq);
                    // Close only after settle: both paths reset restoring/armed so a reopened menu is
                    // clickable again (the failure toast is fired by onRestore itself).
                    void onRestore(c.seq).then(
                      () => { setOpen(false); setRestoring(null); setArmed(null); },
                      () => { setRestoring(null); setArmed(null); },
                    );
                  } else setArmed(c.seq);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] disabled:opacity-60 ${armed === c.seq ? "bg-fail/15 text-fail" : "text-fg-dim hover:bg-line/40"}`}
              >
                <span className="font-mono">{t("checkpointMenu.turn", { turn: c.seq + 1 })}</span>
                <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted">
                  {restoring === c.seq ? <Loader2 size={11} className="animate-spin" aria-hidden /> : armed === c.seq ? t("checkpointMenu.confirmRestore") : checkpointTimeLabel(c.createdAt, Date.now(), t, locale)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
