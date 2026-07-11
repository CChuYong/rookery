import { Check, ChevronRight, X } from "lucide-react";
import { useT } from "../i18n/provider.js";

interface Item { key: string; title: string; desc: string; done: boolean; action: () => void; actionLabel: string; }

// Non-blocking "Getting Started" card (floating bottom-right) shown after onboarding until dismissed or all done.
// Each item auto-completes from live state (auth / default folder / first session / first worker) — the parent passes the booleans.
export function GettingStartedChecklist({ authDone, folderDone, sessionDone, workerDone, onAuth, onFolder, onSession, onWorker, onDismiss }: {
  authDone: boolean; folderDone: boolean; sessionDone: boolean; workerDone: boolean;
  onAuth: () => void; onFolder: () => void; onSession: () => void; onWorker: () => void; onDismiss: () => void;
}): JSX.Element {
  const t = useT();
  const items: Item[] = [
    { key: "auth", title: t("gettingStarted.auth"), desc: t("gettingStarted.authDesc"), done: authDone, action: onAuth, actionLabel: t("gettingStarted.authAction") },
    { key: "folder", title: t("gettingStarted.folder"), desc: t("gettingStarted.folderDesc"), done: folderDone, action: onFolder, actionLabel: t("gettingStarted.folderAction") },
    { key: "session", title: t("gettingStarted.session"), desc: t("gettingStarted.sessionDesc"), done: sessionDone, action: onSession, actionLabel: t("gettingStarted.sessionAction") },
    { key: "worker", title: t("gettingStarted.worker"), desc: t("gettingStarted.workerDesc"), done: workerDone, action: onWorker, actionLabel: t("gettingStarted.workerAction") },
  ];
  const doneCount = items.filter((i) => i.done).length;

  return (
    <div className="rise-in fixed bottom-4 right-4 z-40 w-80 rounded-xl border border-line bg-surface shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-[12px] font-semibold">{t("gettingStarted.title")}</span>
        <span className="font-mono text-[10px] text-muted">{doneCount}/{items.length}</span>
        <button onClick={onDismiss} aria-label={t("gettingStarted.dismiss")} className="ml-auto rounded p-1 text-muted transition-colors hover:bg-raised hover:text-fg-dim"><X size={13} /></button>
      </div>
      <div className="flex flex-col gap-1 p-2">
        {items.map((it) => (
          <div key={it.key} className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${it.done ? "border-pr/40 bg-pr/15 text-pr" : "border-line text-muted"}`}>
              {it.done && <Check size={12} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-[12px] font-medium ${it.done ? "text-muted line-through" : "text-fg"}`}>{it.title}</div>
              <div className="text-[10px] leading-tight text-muted">{it.desc}</div>
            </div>
            {!it.done && (
              <button onClick={it.action} className="flex shrink-0 items-center gap-0.5 rounded-md border border-line px-2 py-1 text-[10px] text-fg-dim transition-colors hover:bg-raised hover:text-fg">
                {it.actionLabel} <ChevronRight size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
