import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Button } from "../ui/button.js";
import { useT } from "../i18n/provider.js";

export interface Checkpoint { seq: number; sha: string; createdAt: string }

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Per-worker-turn checkpoint restore menu. Fetches on open; on item click, confirms then restores.
export function CheckpointMenu({
  fetchCheckpoints,
  onRestore,
}: {
  fetchCheckpoints: () => Promise<Checkpoint[]>;
  onRestore: (seq: number) => void;
}): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Checkpoint[] | null>(null);
  const [armed, setArmed] = useState<number | null>(null);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setArmed(null);
    setItems(null);
    void fetchCheckpoints().then(setItems).catch(() => setItems([]));
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
            {items === null && <div className="px-2 py-1.5 text-[12px] text-muted">{t("common.loading")}</div>}
            {items !== null && items.length === 0 && <div className="px-2 py-1.5 text-[12px] text-muted">{t("checkpointMenu.empty")}</div>}
            {items?.map((c) => (
              <button
                key={c.seq}
                role="menuitem"
                onClick={() => {
                  if (armed === c.seq) { onRestore(c.seq); setOpen(false); }
                  else setArmed(c.seq);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] ${armed === c.seq ? "bg-fail/15 text-fail" : "text-fg-dim hover:bg-line/40"}`}
              >
                <span className="font-mono">{t("checkpointMenu.turn", { turn: c.seq + 1 })}</span>
                <span className="text-[10.5px] text-muted">{armed === c.seq ? t("checkpointMenu.confirmRestore") : hhmm(c.createdAt)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
