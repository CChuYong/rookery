import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { History, Loader2 } from "lucide-react";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { cn } from "../lib/cn.js";
import { MENU_ITEM, MENU_SURFACE } from "../lib/ui-tokens.js";
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

// Per-worker-turn checkpoint restore menu. Fetches on open; on item click, asks in the shared ConfirmDialog (reverting
// discards later changes to tracked files — irreversible, audit #103) then restores.
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
  const [asking, setAsking] = useState<number | null>(null); // the seq whose revert the ConfirmDialog is asking about
  const [restoring, setRestoring] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Shared by the initial open-fetch and the error state's retry button.
  const load = (): void => {
    setItems(null);
    setLoadError(false);
    void fetchCheckpoints().then(setItems).catch(() => setLoadError(true));
  };

  const toggle = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setAsking(null);
    load();
  };
  // Escape closes the open menu — unless the confirm dialog is up, whose own Escape only cancels the dialog.
  useEffect(() => {
    if (!open || asking !== null) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, asking]);
  // In-flight guard (a ref, not the state: two calls in one tick both see the old `restoring`).
  const inFlight = useRef(false);
  const restore = (seq: number): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRestoring(seq);
    // Close only after settle: both paths reset restoring so a reopened menu is clickable again (the failure toast is
    // fired by onRestore itself).
    void onRestore(seq).then(
      () => { inFlight.current = false; setOpen(false); setRestoring(null); },
      () => { inFlight.current = false; setRestoring(null); },
    );
  };
  // Focus the first turn on open (audit #60 — reuses ContextMenu's precedent). Items load async (fetchCheckpoints
  // fires on toggle), so this re-runs once `items` actually arrives, not just on the `open` transition.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open, items]);
  // ArrowUp/Down roving across turns (audit #60 — same logic as ContextMenu.tsx).
  const onMenuKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
    btns[next]?.focus();
  };

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={toggle} title={t("checkpointMenu.buttonTitle")} aria-haspopup="menu" aria-expanded={open}>
        <History size={14} /> {t("checkpointMenu.restore")}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div ref={menuRef} onKeyDown={onMenuKeyDown} role="menu" className={cn("menu-pop absolute right-0 z-40 mt-1 max-h-72 w-64 origin-top-right overflow-y-auto", MENU_SURFACE)}>
            <div className="px-2 py-1 text-meta leading-relaxed text-muted">
              {t("checkpointMenu.hint")}
            </div>
            {items === null && !loadError && <SkeletonRows rows={3} />}
            {loadError && (
              // The single "couldn't load" string doubles as the retry button's label (no dedicated retry key in the catalog).
              <button onClick={load} className="w-full rounded-md px-2 py-1.5 text-left text-ui text-fail hover:bg-fail/10">
                {t("checkpointMenu.loadFailed")}
              </button>
            )}
            {items !== null && items.length === 0 && <div className="px-2 py-1.5 text-ui text-muted">{t("checkpointMenu.empty")}</div>}
            {items?.map((c) => (
              <button
                key={c.seq}
                role="menuitem"
                disabled={restoring !== null}
                onClick={() => { if (restoring === null) setAsking(c.seq); }}
                className={cn("flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-ui text-fg-dim disabled:opacity-60", MENU_ITEM)}
              >
                <span className="font-mono">{t("checkpointMenu.turn", { turn: c.seq + 1 })}</span>
                <span className="flex shrink-0 items-center gap-1 text-meta text-muted">
                  {restoring === c.seq ? <Loader2 size={12} className="animate-spin" aria-hidden /> : checkpointTimeLabel(c.createdAt, Date.now(), t, locale)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {asking !== null && (
        <ConfirmDialog
          title={t("checkpointMenu.confirmTitle", { turn: asking + 1 })}
          body={t("checkpointMenu.confirmBody")}
          confirmLabel={t("checkpointMenu.restore")}
          variant="danger"
          onConfirm={() => restore(asking)}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}
