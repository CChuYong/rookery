import { Loader2, LockKeyhole, X } from "lucide-react";
import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { MessageList } from "./MessageList.js";
import { Composer } from "./Composer.js";
import { Button } from "../ui/button.js";
import { useT } from "../i18n/provider.js";

const EMPTY: LogItem[] = [];

export interface SideConversationDrawerProps {
  sourceKind: "master" | "worker";
  sideId: string | null;
  openingQuestion: string;
  onSend: (sideId: string, text: string) => void;
  onStop: (sideId: string) => void;
  onClose: () => void;
}

export function SideConversationDrawer({ sourceKind, sideId, openingQuestion, onSend, onStop, onClose }: SideConversationDrawerProps): JSX.Element {
  const t = useT();
  const side = useStore((s) => sideId ? s.sideConversations[sideId] : undefined);
  const status = side?.status ?? "opening";
  const items = side?.items ?? (openingQuestion ? [{ kind: "message", role: "user", content: openingQuestion } as LogItem] : EMPTY);
  const running = status === "opening" || status === "running";

  return (
    <aside
      aria-label={t("sideConversation.title")}
      className="absolute inset-0 z-30 flex min-h-0 flex-col border-l border-line bg-surface shadow-2xl md:relative md:inset-auto md:z-auto md:w-[360px] md:shrink-0 md:shadow-none"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 px-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-body font-medium text-fg">{t("sideConversation.title")}</span>
          {running && <Loader2 size={12} className="animate-spin text-accent" aria-label={t("sideConversation.answering")} />}
          <span className="flex min-w-0 items-center gap-1 truncate text-meta text-faint">
            <LockKeyhole size={12} className="shrink-0" />
            {t(sourceKind === "worker" ? "sideConversation.workerContext" : "sideConversation.masterContext")}
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t("common.close")} onClick={onClose}><X size={14} /></Button>
      </header>
      <div className="border-b border-line bg-raised/40 px-3 py-1.5 text-meta text-muted">
        {t(sourceKind === "worker" ? "sideConversation.workerLive" : "sideConversation.masterLive")}
      </div>
      <MessageList items={items} loaded />
      <div className="border-t border-line bg-surface p-2.5">
        <Composer
          onSend={(text) => { if (sideId) onSend(sideId, text); }}
          busy={running}
          onStop={sideId ? () => onStop(sideId) : undefined}
          disabled={!sideId || status === "closed"}
          placeholder={running ? t("sideConversation.waitingPlaceholder") : t("sideConversation.followupPlaceholder")}
          className="bg-ink/30"
        />
      </div>
    </aside>
  );
}
